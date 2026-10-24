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
 *
 * Одного visibility:hidden !important мало. Кнопка «наверх» с transition по visibility в сессии
 * с живой анимацией остаётся видимой всё время перехода, потомок со своим visibility: visible
 * виден сквозь скрытого родителя, а один невалидный селектор в общем списке роняет всё правило.
 * Поэтому правило — на каждый селектор отдельно, на сам элемент и его потомков, без переходов; и
 * перед кадром проверяется, что совпало и что осталось видимым: о промахе ответ говорит сам.
 */
async function withHidden(page, selectors, report, fn) {
  if (!selectors || !selectors.length) return fn();
  const list = await page.evaluate(
    ([mark, sels]) => {
      const style = document.createElement('style');
      style.setAttribute(mark, '');
      document.head.appendChild(style);
      const out = [];
      for (const sel of sels) {
        let matched = [];
        try {
          matched = Array.from(document.querySelectorAll(sel));
        } catch {
          out.push({ selector: sel, invalid: true });
          continue;
        }
        const body = '{visibility:hidden !important; opacity:0 !important; transition:none !important; animation:none !important}';
        try {
          style.sheet.insertRule(`:is(${sel}), :is(${sel}) * ${body}`, style.sheet.cssRules.length);
        } catch {
          style.sheet.insertRule(`${sel} ${body}`, style.sheet.cssRules.length);
        }
        out.push({ selector: sel, matched });
      }
      /* Перерасчёт стилей до проверки: computed-значения читаются уже с правилом. */
      void document.body?.offsetHeight;
      return out.map(({ selector, invalid, matched }) => {
        if (invalid) return { selector, invalid: true };
        const shown = (matched || []).filter((el) =>
          typeof el.checkVisibility === 'function'
            ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
            : getComputedStyle(el).visibility !== 'hidden',
        );
        return { selector, matched: matched.length, ...(shown.length ? { stillVisible: shown.length } : {}) };
      });
    },
    [HIDE_MARK, selectors],
  );
  report.list = list;
  const problems = [
    ...list.filter((item) => item.invalid).map((item) => `${item.selector} — невалидный селектор`),
    ...list.filter((item) => item.matched === 0).map((item) => `${item.selector} — ничего не нашёл (элемент в iframe или shadow DOM здесь не виден)`),
    ...list.filter((item) => item.stillVisible).map((item) => `${item.selector} — видимыми остались ${item.stillVisible}`),
  ];
  if (problems.length) report.warning = `hide спрятал не всё: ${problems.join('; ')}.`;
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

  /*
   * clip задан в координатах страницы, а без fullPage Playwright меряет его от окна и молча
   * режет по нему: clip высотой 2100 в окне 800 возвращал 800. С fullPage clip абсолютный;
   * за границу документа он всё же не выходит — такое обрезаем сами и говорим об этом.
   */
  let clipNote = null;
  if (clip && !selector) {
    const doc = await page.evaluate(() => ({
      w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      viewH: window.innerHeight,
    }));
    const trimmed = trimClip(clip, doc);
    if (!trimmed) throw new Error(`clip {x: ${clip.x}, y: ${clip.y}} лежит за пределами страницы ${doc.w}×${doc.h}.`);
    if (trimmed.trimmed) clipNote = `clip обрезан по размеру страницы ${doc.w}×${doc.h}: снято ${trimmed.clip.width}×${trimmed.clip.height} вместо ${clip.width}×${clip.height}.`;
    clip = trimmed.clip;
    /* Ниже первого экрана появляющиеся по прокрутке блоки ещё не проявлены. */
    if (clip.y + clip.height > doc.viewH) await revealAll(page);
  }

  // Снимаем в буфер, а не сразу в файл: перекодировать и уменьшить всё равно нужно
  // здесь же, и лишний проход через диск ничего не даёт.
  const hiddenReport = {};
  const raw = await withIsolated(page, selector, isolate, () =>
    withHidden(page, hide, hiddenReport, async () => {
      if (selector) return (await resolveShotTarget(page, selector, timeout)).screenshot(common);
      if (clip) return page.screenshot({ ...common, fullPage: true, clip });
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
    ...(clipNote ? { clipNote } : {}),
    ...(hiddenReport.list ? { hidden: hiddenReport.list } : {}),
    ...(hiddenReport.warning ? { hideWarning: hiddenReport.warning } : {}),
  };
}

/** clip, урезанный по документу; null — если от него ничего не осталось. */
export function trimClip(clip, doc) {
  const x = Math.max(0, clip.x);
  const y = Math.max(0, clip.y);
  const right = Math.min(doc.w, clip.x + clip.width);
  const bottom = Math.min(doc.h, clip.y + clip.height);
  if (right <= x || bottom <= y) return null;
  const out = { x, y, width: right - x, height: bottom - y };
  const trimmed = out.x !== clip.x || out.y !== clip.y || out.width !== clip.width || out.height !== clip.height;
  return { clip: out, trimmed };
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

/*
 * Кадр, который клиент вложит без уменьшения: длинная сторона и площадь — пороги, выше которых
 * модель получает картинку ужатой. Кадр 1425×3413, вложенный целиком, приходил в треть величины,
 * и обрезанная подпись или слипшиеся рамки на нём не видны.
 */
export const TILE_MAX_SIDE = 1560;
export const TILE_MAX_PIXELS = 1_150_000;

/**
 * Нарезать кадр по высоте на куски в натуральную величину.
 *
 * Ширина — исходная, пока она не больше TILE_MAX_SIDE (шире — ужимается до неё: иначе модель
 * ужмёт сама). Высота куска — сколько позволяет площадь. Соседние куски перекрываются на overlap,
 * чтобы дефект на стыке был виден целиком хотя бы в одном. Куски ложатся файлами рядом с кадром.
 *
 * Бюджет на все куски — maxBytes: кусок с фотографиями в PNG весит мегабайт, и восемь таких не
 * пролезают в ответ. Тяжёлый кусок перекодируется в JPEG (текст на нём читается), а когда бюджет
 * кончился, нарезка останавливается и в ответе rest — откуда продолжать clip-ом.
 */
export async function tileImage(absPath, { maxTiles = 8, overlap = 40, maxBytes = 4_000_000 } = {}) {
  const meta = await sharp(absPath).metadata();
  const scale = meta.width > TILE_MAX_SIDE ? TILE_MAX_SIDE / meta.width : 1;
  const width = Math.round(meta.width * scale);
  const fullHeight = Math.round(meta.height * scale);
  const tileHeight = Math.max(overlap * 2, Math.min(TILE_MAX_SIDE, Math.floor(TILE_MAX_PIXELS / width)));
  const step = tileHeight - overlap;
  const source = scale === 1 ? sharp(absPath) : sharp(await sharp(absPath).resize({ width }).png().toBuffer());
  const buffer = await source.png().toBuffer();

  const tiles = [];
  let top = 0;
  let spent = 0;
  while (top < fullHeight && tiles.length < maxTiles) {
    const height = Math.min(tileHeight, fullHeight - top);
    const piece = () => sharp(buffer).extract({ left: 0, top, width, height });
    let data = await piece().png({ compressionLevel: 9 }).toBuffer();
    let ext = 'png';
    if (data.length > 900_000) {
      data = await piece().jpeg({ quality: 85 }).toBuffer();
      ext = 'jpg';
    }
    if (tiles.length && spent + data.length > maxBytes) break;
    spent += data.length;
    const file = absPath.replace(/\.(\w+)$/, `__tile-${tiles.length + 1}.${ext}`);
    await fs.writeFile(file, data);
    /* Координаты — в пикселях исходного кадра: по ним агент снимает clip, если нужно крупнее. */
    tiles.push({
      index: tiles.length + 1,
      y0: Math.round(top / scale),
      y1: Math.round((top + height) / scale),
      file,
      mimeType: ext === 'png' ? 'image/png' : 'image/jpeg',
      data: data.toString('base64'),
      bytes: data.length,
    });
    if (top + height >= fullHeight) break;
    top += step;
  }
  const covered = tiles.length ? tiles.at(-1).y1 : 0;
  return {
    tiles,
    width,
    tileHeight,
    scale,
    ...(covered < meta.height ? { rest: { from: covered, to: meta.height } } : {}),
  };
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
