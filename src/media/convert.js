/**
 * Ресайз и конвертация картинок для вёрстки.
 *
 * Задача, ради которой это есть, одна: из исходника получить набор файлов под srcset в
 * современных форматах и готовую разметку <picture>. Руками это ImageMagick, подбор качества и
 * сверка размеров — и чаще всего это не делают вовсе, оставляя в вёрстке фото на 4 МБ.
 *
 * Правила, которые здесь зашиты:
 *   - увеличения нет: ширина больше исходника пропускается с пометкой, а не растягивается —
 *     растянутый файл тяжелее и хуже исходника;
 *   - EXIF-поворот применяется, метаданные вырезаются: снимок с телефона иначе ляжет боком и
 *     унесёт в вёрстку координаты съёмки;
 *   - прозрачность при переводе в jpeg заливается явно заданным фоном, а не чёрным.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { artifactRef, newRunId, runDir, slug } from '../artifacts.js';
import { loadSource } from './source.js';

export const OUTPUT_FORMATS = ['webp', 'avif', 'jpeg', 'png', 'original'];
export const FITS = ['inside', 'cover', 'contain', 'fill'];

const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tiff' };
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', tiff: 'image/tiff' };

/** Во что превращается «original», когда sharp не умеет писать исходный формат. */
const ORIGINAL = { svg: 'png', heif: 'avif' };

/** Порядок <source> в <picture>: браузер берёт первый понятный, поэтому лёгкие форматы идут раньше. */
const PICTURE_ORDER = ['avif', 'webp', 'png', 'jpeg', 'gif', 'tiff'];

/** Размер с учётом EXIF-поворота: у снимка с orientation 6 ширина и высота меняются местами. */
function orientedSize(meta) {
  const height = meta.pages > 1 ? meta.pageHeight : meta.height;
  return meta.orientation >= 5 ? { width: height, height: meta.width } : { width: meta.width, height };
}

function encode(image, format, { quality }) {
  if (format === 'webp') return image.webp({ quality: quality ?? 80 });
  if (format === 'avif') return image.avif({ quality: quality ?? 55 });
  if (format === 'jpeg') return image.jpeg({ quality: quality ?? 82, mozjpeg: true });
  if (format === 'png') return image.png({ compressionLevel: 9 });
  if (format === 'gif') return image.gif();
  return image.tiff({ quality: quality ?? 80 });
}

function basename(name) {
  const stem = path.basename(String(name || ''), path.extname(String(name || '')));
  return slug(stem) || 'image';
}

/**
 * Разметка <picture> по готовым файлам.
 *
 * Имена файлов относительные: где они лягут в проекте, знает агент, а не стенд. width и height у
 * <img> — от самого широкого варианта: пропорция нужна браузеру до загрузки, иначе блок прыгает.
 */
export function pictureMarkup(outputs, { alt = '' } = {}) {
  if (!outputs.length) return null;
  const byFormat = new Map();
  for (const out of outputs) byFormat.set(out.format, [...(byFormat.get(out.format) || []), out]);
  const formats = [...byFormat.keys()].sort((a, b) => PICTURE_ORDER.indexOf(a) - PICTURE_ORDER.indexOf(b));
  const multi = new Set(outputs.map((out) => out.width)).size > 1;
  const srcset = (list) => (multi ? list.map((out) => `${out.name} ${out.width}w`).join(', ') : list[0].name);

  /* Запасной вариант для <img> — самый старый формат из выданных: его понимает любой браузер. */
  const fallbackFormat = formats[formats.length - 1];
  const fallback = byFormat.get(fallbackFormat);
  const widest = fallback.reduce((a, b) => (b.width > a.width ? b : a));
  const sizes = multi ? ` sizes="(max-width: ${widest.width}px) 100vw, ${widest.width}px"` : '';

  const lines = formats
    .filter((format) => format !== fallbackFormat)
    .map((format) => `  <source type="${MIME[format]}" srcset="${srcset(byFormat.get(format))}"${sizes}>`);
  const imgSrcset = multi ? ` srcset="${srcset(fallback)}"${sizes}` : '';
  lines.push(
    `  <img src="${widest.name}"${imgSrcset} width="${widest.width}" height="${widest.height}" alt="${alt}" loading="lazy" decoding="async">`,
  );
  return lines.length === 1 ? lines[0].trim() : `<picture>\n${lines.join('\n')}\n</picture>`;
}

async function convertOne(src, dir, taken, { widths, height, fit, formats, quality, background }) {
  const { buffer, name, meta } = await loadSource(src);
  const size = orientedSize(meta);
  const animated = meta.pages > 1;
  const stem = (() => {
    let base = basename(name);
    for (let i = 2; taken.has(base); i += 1) base = `${basename(name)}-${i}`;
    taken.add(base);
    return base;
  })();

  /* Ширины больше исходника пропускаются: withoutEnlargement у sharp вернул бы исходный размер
     под чужим именем, и в srcset легли бы два одинаковых файла с разными дескрипторами. */
  const wanted = widths?.length ? [...new Set(widths)].sort((a, b) => a - b) : [null];
  const skipped = wanted.filter((w) => w && w > size.width);
  let targets = wanted.filter((w) => !w || w <= size.width);
  if (!targets.length) targets = [size.width];

  /* original у jpeg-исходника совпадает с jpeg: один файл, а не два под одним именем. */
  const resolved = new Map();
  for (const requested of formats) {
    const format = requested === 'original' ? ORIGINAL[meta.format] || meta.format : requested;
    if (!resolved.has(format)) resolved.set(format, requested);
  }

  const outputs = [];
  for (const target of targets) {
    for (const [format, requested] of resolved) {
      const keepAnimation = animated && (format === 'webp' || format === 'gif');
      let image = sharp(buffer, { animated: keepAnimation }).rotate();
      if (target || height) {
        image = image.resize({ width: target || undefined, height: height || undefined, fit, withoutEnlargement: true });
      }
      if (format === 'jpeg' && meta.hasAlpha) image = image.flatten({ background: background || '#ffffff' });
      const { data, info } = await encode(image, format, { quality }).toBuffer({ resolveWithObject: true });
      const outHeight = keepAnimation && info.pageHeight ? info.pageHeight : info.height;
      const fileName = `${stem}${widths?.length ? `-${info.width}w` : ''}.${EXT[format]}`;
      const file = path.join(dir, fileName);
      await fs.writeFile(file, data);
      const notes = [];
      if (requested === 'original' && ORIGINAL[meta.format]) notes.push(`${meta.format} так не записывается — отдан ${format}`);
      if (animated && !keepAnimation) notes.push('анимация сохраняется только в webp и gif — взят первый кадр');
      outputs.push({
        name: fileName,
        format,
        width: info.width,
        height: outHeight,
        bytes: data.length,
        saved: `${Math.round((1 - data.length / buffer.length) * 100)}%`,
        ...(notes.length ? { note: notes.join('; ') } : {}),
        file: artifactRef(file),
      });
    }
  }

  /* Файл, который не легче исходника того же размера, — не оптимизация. Сказать об этом надо
     прямо: иначе агент подставит его, поверив, что так лучше. */
  const heavier = outputs
    .filter((out) => out.width === size.width && out.bytes >= buffer.length)
    .map((out) => out.name);

  return {
    src,
    source: { format: meta.format, size: `${size.width}x${size.height}`, bytes: buffer.length, ...(animated ? { frames: meta.pages } : {}) },
    outputs,
    ...(skipped.length ? { skipped: skipped.map((w) => `${w}w`), skippedNote: `шире исходника (${size.width}px): увеличение не делается` } : {}),
    ...(heavier.length ? { heavier, heavierNote: 'не легче исходника того же размера — оставьте исходник' } : {}),
    picture: pictureMarkup(outputs),
  };
}

/**
 * Прогон конвертации по списку исходников.
 *
 * Отказ одного исходника не роняет остальные: из десяти картинок одна битая ссылка — не повод
 * переделывать девять.
 */
export async function convertImages(sources, { width, widths, height, fit = 'inside', formats = ['webp'], quality, background } = {}) {
  if (!FITS.includes(fit)) throw new Error(`fit: одно из ${FITS.join(', ')}.`);
  if (!formats.length) throw new Error('formats: нужен хотя бы один формат.');
  const list = widths?.length ? widths : width ? [width] : null;

  const runId = newRunId('image');
  const dir = await runDir(runId);
  const taken = new Set();
  const images = [];
  const failed = [];
  for (const src of sources) {
    try {
      images.push(await convertOne(src, dir, taken, { widths: list, height, fit, formats, quality, background }));
    } catch (err) {
      failed.push({ src, error: err.message });
    }
  }
  if (!images.length && failed.length === 1) throw new Error(failed[0].error);
  return { runId, images, ...(failed.length ? { failed } : {}) };
}
