/**
 * Картинки-заглушки для вёрстки.
 *
 * Рисунок повторяет генератор, которым пользовались руками (image_placeholder_generator.html):
 * фон, рамка, крест и диагонали с градиентом «цвет рамки → фон → цвет рамки», по центру размер и
 * пропорция. Так заглушка, подставленная агентом, выглядит так же, как та, что верстальщик
 * сохранял из браузера, и в вёрстке их не нужно различать.
 *
 * Рисуется SVG, а не canvas: браузер ради прямоугольника с текстом поднимать незачем, а sharp
 * растеризует SVG сам. Тот же исходник отдаётся и как файл .svg — он весит сотни байт и
 * масштабируется без потерь.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { artifactRef, newRunId, runDir } from '../artifacts.js';

export const PLACEHOLDER_FORMATS = ['png', 'jpeg', 'webp', 'avif', 'svg'];
export const FONT_FAMILIES = ['monospace', 'sans-serif', 'serif', 'cursive'];

/** Те же значения по умолчанию, что у генератора. */
export const PLACEHOLDER_DEFAULTS = {
  bg: '#eeeeee',
  borderColor: '#999999',
  borderWidth: 5,
  textColor: '#333333',
  fontFamily: 'monospace',
};

/** Больше этого по стороне заглушка не нужна никому, а растр 20000×20000 съел бы память стенда. */
export const MAX_SIDE = 8000;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/*
 * Цвет попадает в атрибут SVG. Произвольную строку туда пускать нельзя: кавычка в «цвете»
 * дописала бы в разметку что угодно. Пропускаются формы, которыми цвет и задают.
 */
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgb|hsl)a?\([\d\s.,%/+-]+\))$/i;

function color(value, name) {
  const str = String(value).trim();
  if (!COLOR.test(str)) throw new Error(`${name}: «${value}» не похоже на цвет. Нужен #rrggbb, имя или rgb()/hsl().`);
  return str;
}

const escapeXml = (value) =>
  String(value).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]);

const num = (value) => Math.round(value * 100) / 100;

/** «600x400», «600×400», «600X400» → { width, height }. */
export function parseSize(value) {
  const m = /^\s*(\d+)\s*[x×х*]\s*(\d+)\s*$/i.exec(String(value));
  if (!m) throw new Error(`Размер «${value}» не разобран: нужен вид 600x400.`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`Размер «${value}»: стороны от 1 до ${MAX_SIDE}.`);
  }
  return { width, height };
}

/**
 * SVG заглушки.
 *
 * width и height — размер, который подписан на картинке; scale множит геометрию, но не подпись:
 * заглушка @2x для блока 600×400 весит 1200×800 точек и всё равно называет себя 600×400.
 */
export function placeholderSvg({
  width,
  height,
  scale = 1,
  bg = PLACEHOLDER_DEFAULTS.bg,
  borderColor = PLACEHOLDER_DEFAULTS.borderColor,
  borderWidth = PLACEHOLDER_DEFAULTS.borderWidth,
  textColor = PLACEHOLDER_DEFAULTS.textColor,
  fontSize,
  fontFamily = PLACEHOLDER_DEFAULTS.fontFamily,
  text,
} = {}) {
  if (!FONT_FAMILIES.includes(fontFamily)) throw new Error(`fontFamily: одно из ${FONT_FAMILIES.join(', ')}.`);
  const bgc = color(bg, 'bg');
  const border = color(borderColor, 'borderColor');
  const ink = color(textColor, 'textColor');

  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const bw = Math.max(0, Number(borderWidth) || 0) * scale;
  const size = (fontSize ? Number(fontSize) : Math.min(width, height) * 0.2) * scale;
  const g = gcd(width, height);
  const label = text && String(text).trim() ? String(text).trim() : `${width}×${height}\n${width / g}:${height / g}`;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${bgc}"/>`,
  ];

  if (bw > 0) {
    parts.push(
      `<rect x="${num(bw / 2)}" y="${num(bw / 2)}" width="${num(Math.max(0, w - bw))}" height="${num(Math.max(0, h - bw))}" fill="none" stroke="${border}" stroke-width="${num(bw)}"/>`,
    );
    /* Порядок и концы линий — как в генераторе: горизонталь, вертикаль, две диагонали, от
       внутренней кромки рамки. Градиент у каждой свой, вдоль неё самой. */
    const lines = [
      [bw, h / 2, w - bw, h / 2],
      [w / 2, bw, w / 2, h - bw],
      [bw, bw, w - bw, h - bw],
      [w - bw, bw, bw, h - bw],
    ];
    const defs = [];
    const strokes = [];
    lines.forEach(([x1, y1, x2, y2], i) => {
      const at = `x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"`;
      defs.push(
        `<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" ${at}><stop offset="0" stop-color="${border}"/><stop offset="0.5" stop-color="${bgc}"/><stop offset="1" stop-color="${border}"/></linearGradient>`,
      );
      strokes.push(`<line ${at} stroke="url(#g${i})" stroke-width="${num(bw)}"/>`);
    });
    parts.push(`<defs>${defs.join('')}</defs>`, ...strokes);
  }

  /* textBaseline = 'middle' у canvas ставит середину em-квадрата на точку. dominant-baseline librsvg
     поддерживает не во всех версиях, поэтому базовая линия опускается явно — на 0.26 кегля: при
     этом сдвиге рамка текста совпала с canvas генератора до пикселя. */
  const rows = label.split(/\r?\n/);
  const lineHeight = size * 1.1;
  const spans = rows.map((row, i) => {
    const y = h / 2 + (i - (rows.length - 1) / 2) * lineHeight + size * 0.26;
    return `<text x="${num(w / 2)}" y="${num(y)}">${escapeXml(row)}</text>`;
  });
  parts.push(
    `<g font-family="${fontFamily}" font-size="${num(size)}" fill="${ink}" text-anchor="middle">${spans.join('')}</g>`,
    '</svg>',
  );
  return parts.join('');
}

/** SVG → файл нужного формата. */
export async function rasterize(svg, format, { quality } = {}) {
  if (format === 'svg') return Buffer.from(svg, 'utf8');
  const image = sharp(Buffer.from(svg, 'utf8'));
  if (format === 'png') return image.png({ compressionLevel: 9 }).toBuffer();
  if (format === 'jpeg') return image.jpeg({ quality: quality ?? 85, mozjpeg: true }).toBuffer();
  if (format === 'webp') return image.webp({ quality: quality ?? 85 }).toBuffer();
  if (format === 'avif') return image.avif({ quality: quality ?? 60 }).toBuffer();
  throw new Error(`format: одно из ${PLACEHOLDER_FORMATS.join(', ')}.`);
}

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif', svg: 'svg' };

/**
 * Набор заглушек одним прогоном.
 *
 * Размеры приходят списком, потому что заглушки нужны сразу для всего макета: карточки, баннер,
 * аватар. По вызову на каждую — это десяток ходов агента ради одинаковой работы.
 */
export async function renderPlaceholders(sizes, { format = 'png', scale = 1, quality, ...style } = {}) {
  if (!PLACEHOLDER_FORMATS.includes(format)) throw new Error(`format: одно из ${PLACEHOLDER_FORMATS.join(', ')}.`);
  if (!(scale >= 1 && scale <= 3)) throw new Error('scale: от 1 до 3.');
  const unique = [...new Set(sizes.map((value) => parseSize(value)).map(({ width, height }) => `${width}x${height}`))];
  for (const key of unique) {
    const { width, height } = parseSize(key);
    if (width * scale > MAX_SIDE || height * scale > MAX_SIDE) throw new Error(`${key} при scale ${scale} больше ${MAX_SIDE} по стороне.`);
  }

  const runId = newRunId('placeholder');
  const dir = await runDir(runId);
  const files = [];
  for (const key of unique) {
    const { width, height } = parseSize(key);
    const svg = placeholderSvg({ width, height, scale, ...style });
    const buffer = await rasterize(svg, format, { quality });
    const name = `${key}${scale > 1 ? `@${scale}x` : ''}.${EXT[format]}`;
    const file = path.join(dir, name);
    await fs.writeFile(file, buffer);
    files.push({
      size: key,
      pixels: `${Math.round(width * scale)}x${Math.round(height * scale)}`,
      format,
      bytes: buffer.length,
      file: artifactRef(file),
    });
  }
  return { runId, files };
}
