/**
 * Хранилище ресурсов зеркала с дедупликацией по содержимому.
 *
 * Обход на пятьсот страниц тянет один и тот же CSS пятьсот раз. Без дедупликации архив растёт
 * линейно по страницам, хотя реального материала там на десяток файлов. Ключ — sha1 содержимого,
 * поэтому один и тот же файл, отданный по трём разным адресам (CDN, версия в query, протокол),
 * ложится на диск однажды.
 *
 * Каталог шардится по первым двум символам хэша: пятьдесят тысяч файлов в одном каталоге
 * превращают каждое обращение к нему в перебор.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/*
 * Расширение берётся из Content-Type, а не из адреса: адрес сплошь и рядом заканчивается на
 * /style или несёт версию в query, а браузер смотрит на тип. Неверное расширение означает, что
 * nginx отдаст файл не с тем MIME, и зеркало останется без стилей.
 */
const BY_TYPE = {
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'application/font-woff2': 'woff2',
  'video/mp4': 'mp4',
};

const FROM_URL = /\.([a-z0-9]{1,5})(?:$|[?#])/i;

export function extensionFor(url, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (BY_TYPE[type]) return BY_TYPE[type];
  const m = FROM_URL.exec(String(url || ''));
  if (m) return m[1].toLowerCase();
  return 'bin';
}

export function assetName(body, url, contentType) {
  const hash = createHash('sha1').update(body).digest('hex');
  return { hash, file: `${hash}.${extensionFor(url, contentType)}` };
}

/**
 * Кладёт содержимое в хранилище и возвращает путь относительно каталога сайта.
 *
 * Относительный путь, а не абсолютный: зеркало должно открываться и через nginx, и с диска,
 * и переживать перенос каталога — абсолютные ссылки всё это ломают.
 */
export async function putAsset(siteDir, body, { url, contentType } = {}) {
  const { hash, file } = assetName(body, url, contentType);
  const shard = hash.slice(0, 2);
  const abs = path.join(siteDir, 'assets', shard, file);

  // Совпал хэш — совпало содержимое: переписывать нечего, и это самый частый случай.
  const known = await fs.stat(abs).then(() => true).catch(() => false);
  if (!known) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }

  return { hash, abs, rel: `assets/${shard}/${file}`, bytes: body.length, reused: known };
}
