/**
 * Сравнение двух живых страниц между собой.
 *
 * Визуальная регрессия отвечает на вопрос «изменилась ли страница со вчера» и потому
 * сравнивает снимок с накопленным эталоном. При натягивании вёрстки вопрос другой —
 * «совпало ли с макетом», и обе стороны живые: слева отданный студией статический HTML,
 * справа собранная страница. Копить эталон тут не из чего, а сличать глазами два снимка
 * в переписке — то же самое, но дороже и без чисел.
 *
 * Отличия от compareWithBaseline, из-за которых это отдельный проход:
 *
 *  - у сторон свои условия просмотра: у макета один HTTP-доступ, у стенда другой;
 *  - высота почти никогда не совпадает — у макета демо-контент, у страницы боевой.
 *    Для эталона расхождение размеров законно считается несравнимым, здесь же это
 *    нормальное состояние, поэтому кадры дополняются до общего холста, а разница
 *    размеров выносится в ответ отдельным числом, а не отменяет сравнение.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compare as odiffCompare } from 'odiff-bin';
import { CONFIG } from '../config.js';
import { artifactRef, runDir, slug } from '../artifacts.js';
import { takeScreenshot } from './visual.js';

const PAD = { r: 255, g: 255, b: 255, alpha: 1 };

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Обрезает снимок до общей области, не растягивая картинку.
 *
 * Сравнивать надо ровно то, что есть у обеих сторон. Дополнять короткую страницу белым
 * до высоты длинной — значит объявить эту белизну расхождением: на паре «макет с
 * демо-контентом против боевой страницы» так набегало три четверти процента различий,
 * и число переставало что-либо значить. Насколько стороны разошлись по высоте, честнее
 * сказать отдельным числом, чем растворить в процентах.
 *
 * Масштабировать тоже нельзя: сравнение попиксельное, и любое растяжение показало бы
 * расхождение там, где вёрстка совпадает, — просто из-за интерполяции.
 */
async function cropTo(srcPath, outPath, width, height) {
  const image = sharp(srcPath);
  const meta = await image.metadata();
  if (meta.width === width && meta.height === height) {
    await fs.copyFile(srcPath, outPath);
    return { width: meta.width, height: meta.height, cropped: false };
  }
  await image
    .extract({ left: 0, top: 0, width: Math.min(width, meta.width), height: Math.min(height, meta.height) })
    .png()
    .toFile(outPath);
  return { width: meta.width, height: meta.height, cropped: true };
}

/**
 * Снимает одну сторону под своими условиями просмотра и отдаёт путь к кадру.
 * Сессию закрывает за собой в любом случае — иначе на матрице ширин их накопится втрое.
 */
async function shotOf(pool, side, { viewport, runId, name, selector, fullPage, hide, mask }) {
  const session = await pool.createSession({
    viewport,
    browser: side.browser,
    auth: side.auth,
    extraHTTPHeaders: side.extraHTTPHeaders,
    hostMap: side.hostMap,
    colorScheme: side.colorScheme,
  });

  try {
    const nav = await pool.gotoAndSettle(session, side.url, { waitUntil: side.waitUntil });
    const shot = await takeScreenshot(session.page, {
      runId,
      name,
      fullPage,
      selector,
      hide,
      mask,
    });
    return { shot, nav };
  } finally {
    await pool.closeSession(session.id);
  }
}

/**
 * Сравнивает две страницы на списке ширин.
 *
 * Возвращает по каждой ширине процент расхождения и ссылки на кадры; картинки в ответ
 * не вкладываются — их место в отчёте, иначе одна проверка съедает весь контекст.
 */
export async function comparePages({
  pool,
  runId,
  name = 'compare',
  a,
  b,
  viewports = ['desktop'],
  selector = null,
  fullPage = true,
  hide = [],
  mask = [],
  threshold = CONFIG.visualThreshold,
}) {
  if (!a?.url || !b?.url) throw new Error('Нужны обе стороны: a.url и b.url.');

  const dir = await runDir(runId);
  const results = [];

  for (const viewport of viewports) {
    const key = slug(viewport);
    const shared = { viewport, runId, selector, fullPage, hide, mask };

    let left;
    let right;
    try {
      left = await shotOf(pool, a, { ...shared, name: `${name}__${key}__a` });
      right = await shotOf(pool, b, { ...shared, name: `${name}__${key}__b` });
    } catch (err) {
      results.push({ viewport, ok: false, error: err.message });
      continue;
    }

    // Общая область: то, что есть у обеих сторон.
    const width = Math.min(left.shot.width, right.shot.width);
    const height = Math.min(left.shot.height, right.shot.height);

    const leftCrop = path.join(dir, `${slug(name)}__${key}__a.crop.png`);
    const rightCrop = path.join(dir, `${slug(name)}__${key}__b.crop.png`);
    const sizeA = await cropTo(left.shot.path, leftCrop, width, height);
    const sizeB = await cropTo(right.shot.path, rightCrop, width, height);

    const diffFile = path.join(dir, `${slug(name)}__${key}.diff.png`);
    const res = await odiffCompare(leftCrop, rightCrop, diffFile, {
      threshold: 0.1,
      antialiasing: true,
      outputDiffMask: false,
    });

    const diffPercentage = res.match ? 0 : Number(res.diffPercentage || 0);
    if (res.match) await fs.rm(diffFile, { force: true });

    results.push({
      viewport,
      ok: true,
      match: diffPercentage <= threshold,
      diffPercentage: Math.round(diffPercentage * 1000) / 1000,
      threshold,
      /*
       * Разница высот — самостоятельный сигнал: страницы не сошлись по вертикали, даже
       * если на общей области расхождения почти нет. coverage показывает, какую долю
       * более длинной страницы вообще удалось сравнить: 0.27 значит, что три четверти
       * длинной стороны остались за кадром и о них процент ничего не говорит.
       */
      size: {
        a: { width: sizeA.width, height: sizeA.height },
        b: { width: sizeB.width, height: sizeB.height },
        heightDelta: sizeB.height - sizeA.height,
        compared: { width, height },
        coverage: Math.round((height / Math.max(sizeA.height, sizeB.height)) * 100) / 100,
        cropped: sizeA.cropped || sizeB.cropped,
      },
      a: artifactRef(left.shot.path),
      b: artifactRef(right.shot.path),
      diff: (await exists(diffFile)) ? artifactRef(diffFile) : null,
      navigation: {
        a: { status: left.nav.status, warnings: left.nav.warnings || null },
        b: { status: right.nav.status, warnings: right.nav.warnings || null },
      },
    });
  }

  const compared = results.filter((r) => r.ok);
  const worst = compared.length
    ? compared.reduce((acc, r) => (r.diffPercentage > acc.diffPercentage ? r : acc))
    : null;

  return {
    runId,
    dir,
    name,
    a: a.url,
    b: b.url,
    results,
    // Ссылкой, а не копией ячейки: полный дубль удваивал ответ ради одного числа.
    worst: worst && { viewport: worst.viewport, diffPercentage: worst.diffPercentage },
    clean: compared.length > 0 && compared.every((r) => r.match),
  };
}
