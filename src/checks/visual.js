import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compare as odiffCompare } from 'odiff-bin';
import { CONFIG } from '../config.js';
import { artifactRef, baselinePath, runDir, slug } from '../artifacts.js';

const HIDE_MARK = 'data-lt-hide';
const ISOLATE_MARK = 'data-lt-isolate';

const FORMATS = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
};

/**
 * Оставляет в кадре только перечисленные элементы, остальных соседей убирает
 * из потока.
 *
 * Отличие от `hide`: тот ставит visibility и место за элементом сохраняет — это верно
 * для баннеров поверх макета, но бесполезно, когда надо показать пару соседних блоков
 * без остальных десяти: пустоты между ними останутся. Здесь именно display: none.
 *
 * Прячем не всё подряд, а только ветки, которые не ведут к нужным элементам, — иначе
 * вместе с соседями исчезло бы и содержимое самих оставленных блоков.
 */
async function withIsolated(page, rootSelector, keep, fn) {
  if (!keep || !keep.length) return fn();

  const found = await page.evaluate(
    ([mark, rootSel, list]) => {
      const root = rootSel ? document.querySelector(rootSel) : document.body;
      if (!root) return 0;

      const kept = list.flatMap((sel) => Array.from(root.querySelectorAll(sel)));
      if (!kept.length) return 0;

      const keptSet = new Set(kept);
      const ancestors = new Set();
      for (const el of kept) {
        let node = el.parentElement;
        while (node && node !== root.parentElement) {
          ancestors.add(node);
          node = node.parentElement;
        }
      }

      const style = document.createElement('style');
      style.setAttribute(`${mark}-style`, '');
      style.textContent = `[${mark}]{display:none !important}`;
      document.head.appendChild(style);

      const walk = (node) => {
        for (const child of Array.from(node.children)) {
          if (keptSet.has(child)) continue;
          if (ancestors.has(child)) walk(child);
          else child.setAttribute(mark, '');
        }
      };
      walk(root);
      return kept.length;
    },
    [ISOLATE_MARK, rootSelector, keep],
  );

  if (!found) throw new Error(`isolate: ни один из селекторов не найден внутри ${rootSelector || 'body'}.`);

  try {
    return await fn();
  } finally {
    await page
      .evaluate((mark) => {
        document.querySelectorAll(`[${mark}]`).forEach((n) => n.removeAttribute(mark));
        document.querySelectorAll(`style[${mark}-style]`).forEach((n) => n.remove());
      }, ISOLATE_MARK)
      .catch(() => {});
  }
}

/**
 * Убирает мешающие слои перед снимком: cookie-баннеры, чаты, всплывашки.
 * visibility, а не display — чтобы не поехал layout и снимок остался сравнимым
 * с эталоном, снятым без скрытия.
 */
async function withHidden(page, selectors, fn) {
  if (!selectors || !selectors.length) return fn();
  await page.evaluate(
    ([mark, list]) => {
      const el = document.createElement('style');
      el.setAttribute(mark, '');
      el.textContent = `${list.join(',')}{visibility:hidden !important}`;
      document.head.appendChild(el);
    },
    [HIDE_MARK, selectors],
  );
  try {
    return await fn();
  } finally {
    await page
      .evaluate((mark) => document.querySelectorAll(`style[${mark}]`).forEach((n) => n.remove()), HIDE_MARK)
      .catch(() => {});
  }
}

/**
 * Снимок страницы. Маска закрывает заведомо нестабильные зоны (часы, баннеры),
 * иначе они краснят каждый прогон визуальной регрессии.
 */
export async function takeScreenshot(page, {
  runId,
  name = 'screenshot',
  fullPage = true,
  selector = null,
  clip = null,
  mask = [],
  hide = [],
  isolate = [],
  omitBackground = false,
  format = 'png',
  quality = 80,
  maxWidth = null,
  timeout = undefined,
} = {}) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Неизвестный формат: ${format}. Доступны: ${Object.keys(FORMATS).join(', ')}.`);

  const dir = await runDir(runId);
  const file = path.join(dir, `${slug(name)}.${spec.ext}`);

  const maskLocators = (mask || []).map((sel) => page.locator(sel));
  const common = {
    mask: maskLocators,
    maskColor: '#FF00FF',
    omitBackground,
    ...(timeout === undefined ? {} : { timeout }),
  };

  // Снимаем в буфер, а не сразу в файл: перекодировать и уменьшить всё равно нужно
  // здесь же, и лишний проход через диск ничего не даёт.
  const raw = await withIsolated(page, selector, isolate, () =>
    withHidden(page, hide, async () => {
      if (selector) return page.locator(selector).first().screenshot(common);
      if (clip) return page.screenshot({ ...common, clip });
      return page.screenshot({ ...common, fullPage });
    }),
  );

  let pipeline = sharp(raw);
  if (maxWidth) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  if (format === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality });
  if (format === 'webp') pipeline = pipeline.webp({ quality });

  const out = await pipeline.toBuffer();
  await fs.writeFile(file, out);

  const meta = await sharp(out).metadata();
  return {
    ...artifactRef(file),
    name,
    width: meta.width,
    height: meta.height,
    format,
    mimeType: spec.mime,
    bytes: out.length,
  };
}

/** Уменьшенная копия для инлайн-отдачи агенту: полный PNG съедает контекст. */
export async function inlineImage(absPath, maxWidth = 900) {
  const buf = await sharp(absPath)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { data: buf.toString('base64'), mimeType: 'image/png', bytes: buf.length };
}

/**
 * Картинка как data:-URI — для отчётов, которые должны пересылаться одним файлом.
 * PNG со скриншотами фотографий весит столько, что документ из пары десятков кадров
 * перестаёт открываться; webp с ограничением по ширине даёт тот же документ на порядок легче.
 */
export async function imageDataUri(absPath, { format = 'webp', quality = 80, maxWidth = 1000 } = {}) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Неизвестный формат: ${format}.`);

  let pipeline = sharp(absPath);
  if (maxWidth) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  if (format === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality });
  if (format === 'webp') pipeline = pipeline.webp({ quality });

  const buf = await pipeline.toBuffer();
  const meta = await sharp(buf).metadata();
  return {
    uri: `data:${spec.mime};base64,${buf.toString('base64')}`,
    width: meta.width,
    height: meta.height,
    bytes: buf.length,
  };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Сравнение с эталоном. Если эталона нет — снимок становится эталоном,
 * и это честно сообщается: первый прогон никогда не «проходит» молча.
 */
export async function compareWithBaseline({
  runId,
  name,
  profileKey: key = '',
  actualPath,
  threshold = CONFIG.visualThreshold,
  updateBaseline = false,
}) {
  const base = baselinePath(name, key);
  const dir = await runDir(runId);
  const diffFile = path.join(dir, `${slug(name)}${key ? `__${slug(key)}` : ''}.diff.png`);

  await fs.mkdir(path.dirname(base), { recursive: true });

  if (updateBaseline || !(await exists(base))) {
    await fs.copyFile(actualPath, base);
    return {
      status: updateBaseline ? 'baseline-updated' : 'baseline-created',
      match: null,
      baseline: { path: base },
      actual: artifactRef(actualPath),
      note: updateBaseline
        ? 'Эталон перезаписан текущим снимком.'
        : 'Эталона не было — снимок принят как эталон. Сравнивать будет следующий прогон.',
    };
  }

  const result = await odiffCompare(base, actualPath, diffFile, {
    threshold: 0.1,
    antialiasing: true,
    outputDiffMask: false,
  });

  if (result.match) {
    await fs.rm(diffFile, { force: true });
    return {
      status: 'match',
      match: true,
      diffPercentage: 0,
      threshold,
      baseline: { path: base },
      actual: artifactRef(actualPath),
    };
  }

  if (result.reason === 'layout-diff') {
    return {
      status: 'size-mismatch',
      match: false,
      threshold,
      baseline: { path: base },
      actual: artifactRef(actualPath),
      note: 'Размеры снимка и эталона не совпали — сравнение по пикселям невозможно.',
    };
  }

  const diffPercentage = Number(result.diffPercentage || 0);
  return {
    status: diffPercentage > threshold ? 'diff' : 'within-threshold',
    match: diffPercentage <= threshold,
    diffPercentage: Math.round(diffPercentage * 1000) / 1000,
    diffCount: result.diffCount,
    threshold,
    baseline: { path: base },
    actual: artifactRef(actualPath),
    diff: (await exists(diffFile)) ? artifactRef(diffFile) : null,
  };
}

export async function listBaselines(dirPath) {
  const dir = dirPath;
  try {
    const files = await fs.readdir(dir);
    const out = [];
    for (const f of files.filter((x) => x.endsWith('.png'))) {
      const st = await fs.stat(path.join(dir, f));
      out.push({ name: f.replace(/\.png$/, ''), path: path.join(dir, f), bytes: st.size, mtime: st.mtime.toISOString() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
