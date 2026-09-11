import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compare as odiffCompare } from 'odiff-bin';
import { CONFIG } from '../config.js';
import { artifactRef, baselinePath, runDir, slug } from '../artifacts.js';
import { revealAll, placeholderBrokenMedia } from '../browser/stabilize.js';

const HIDE_MARK = 'data-lt-hide';
const ISOLATE_MARK = 'data-lt-isolate';

/**
 * Выбирает элемент для съёмки по селектору.
 *
 * `locator(...).first()` берёт первое совпадение в DOM, не глядя на видимость. Если первым
 * оказался скрытый узел — а на страницах с шаблонами и модалками это обычное дело, — снимок
 * упирается в таймаут ожидания видимости и отдаёт англоязычную простыню Playwright через
 * полминуты. Ждать тут нечего: сколько совпадений и какие из них видимы, известно сразу.
 */
async function resolveShotTarget(page, selector, timeout) {
  const locator = page.locator(selector);
  const total = await locator.count();

  if (!total) throw new Error(`Селектор ${selector} ничего не нашёл на странице.`);

  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible()) return candidate;
  }

  throw new Error(
    `Селектор ${selector}: совпадений ${total}, видимых нет — снимать нечего. ` +
      'Уточните селектор либо снимите скрытие перед съёмкой.',
  );
}

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
  placeholders = true,
  placeholderSize = 1000,
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

  /*
   * Стабилизация живёт в навигации, а снимок бывает и без неё: после действия, правки
   * стилей или просто вторым подряд. К этому моменту появляющиеся по прокрутке блоки
   * успевают спрятаться обратно, а подгруженная позже битая картинка — схлопнуть коробку.
   * Поэтому обе поправки повторяем перед каждым кадром.
   */
  if (placeholders) await placeholderBrokenMedia(page, { size: placeholderSize });
  if (fullPage && !selector && !clip) await revealAll(page);

  // Снимаем в буфер, а не сразу в файл: перекодировать и уменьшить всё равно нужно
  // здесь же, и лишний проход через диск ничего не даёт.
  const raw = await withIsolated(page, selector, isolate, () =>
    withHidden(page, hide, async () => {
      if (selector) return (await resolveShotTarget(page, selector, timeout)).screenshot(common);
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

/**
 * Уменьшенная копия для инлайн-отдачи агенту: полный PNG съедает контекст.
 *
 * У полностраничного снимка мобильной страницы высота бывает в семь тысяч точек. Ужатая до
 * 900px по ширине, такая полоса нечитаема совсем — и при этом стоит как обычная картинка.
 * Поэтому непропорционально высокий кадр обрезается по верхней части, а факт обрезки
 * возвращается наверх: целиком снимок никуда не делся, он лежит по url артефакта.
 */
export async function inlineImage(absPath, maxWidth = 900, { maxRatio = 4 } = {}) {
  const buf = await sharp(absPath)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const meta = await sharp(buf).metadata();
  const done = (data, height, cropped = null) => ({
    data: data.toString('base64'),
    mimeType: 'image/png',
    bytes: data.length,
    width: meta.width,
    height,
    ...(cropped ? { cropped } : {}),
  });

  if (!maxRatio || meta.height <= meta.width * maxRatio) return done(buf, meta.height);

  const shownHeight = Math.round(meta.width * maxRatio);
  const cut = await sharp(buf)
    .extract({ left: 0, top: 0, width: meta.width, height: shownHeight })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return done(cut, shownHeight, { fullHeight: meta.height, shownHeight });
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

/**
 * Удаление эталонов.
 *
 * До сих пор их можно было только перечислять, и они копились без предела: profileKey входит в
 * имя файла, поэтому широкая матрица заводит по эталону на каждое сочетание ширины, темы, zoom
 * и RTL. Каталог рос молча — в отличие от artifacts/, у которого есть автоочистка.
 *
 * Автоочистки здесь нет и не будет: эталон это не побочный продукт прогона, а решение человека
 * о том, как страница должна выглядеть. Удалять такое по расписанию нельзя.
 */
export async function removeBaseline(dirPath, name, { apply = false } = {}) {
  const file = `${path.basename(String(name)).replace(/\.png$/i, '')}.png`;
  const abs = path.join(dirPath, file);
  const exists = await fs
    .stat(abs)
    .then(() => true)
    .catch(() => false);
  if (!exists) return { name: file, found: false, removed: false };
  if (!apply) return { name: file, found: true, removed: false, wouldRemove: true };
  await fs.rm(abs, { force: true });
  return { name: file, found: true, removed: true };
}

export async function pruneBaselines(dirPath, { olderThanDays = 90, apply = false } = {}) {
  const all = await listBaselines(dirPath);
  const edge = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const doomed = all.filter((item) => new Date(item.mtime).getTime() < edge);
  /* По умолчанию вхолостую: удаление эталона делает следующее сравнение бессмысленным —
     сравнивать станет не с чем, — и увидеть список до, а не после, здесь важнее обычного. */
  if (!apply) {
    return {
      olderThanDays,
      total: all.length,
      wouldRemove: doomed.map((d) => d.name),
      applied: false,
      note: 'Ничего не удалено. Повторите с apply: true, если список верен.',
    };
  }
  for (const item of doomed) await fs.rm(item.path, { force: true });
  return { olderThanDays, total: all.length, removed: doomed.map((d) => d.name), applied: true };
}
