/**
 * Откуда image_convert берёт исходник.
 *
 * Стенд живёт в контейнере, а проект агента — на хосте, и общей файловой системы у них нет.
 * Поэтому путей на машине пользователя здесь нет вовсе: исходник приходит либо по адресу —
 * контейнер проекта, host.docker.internal, интернет, — либо из каталога артефактов, куда его
 * положила загрузка /upload или figma_export. Путь хоста в контейнере не значит ничего, и
 * принять его означало бы отвечать «нет такого файла» на верно названный файл.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { CONFIG } from '../config.js';
import { resolveInArtifacts } from '../paths.js';

/** Форматы, которые sharp читает и которые имеет смысл принимать как картинку. */
export const INPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'svg', 'heif'];

export class SourceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const tooLarge = (bytes) =>
  new SourceError(`Файл больше потолка ${CONFIG.maxUploadBytes} байт${bytes ? ` (${bytes})` : ''}. Потолок задаёт LT_MAX_UPLOAD_BYTES.`, 413);

/**
 * Метаданные картинки или внятный отказ.
 *
 * Чаще всего вместо картинки приходит HTML: страница 404 с кодом 200, форма входа, редирект на
 * главную. Сырое «Input buffer contains unsupported image format» не говорит, что именно пришло,
 * поэтому начало текста показывается в ошибке.
 */
export async function imageMeta(buffer, label = 'источник') {
  let meta = null;
  try {
    meta = await sharp(buffer, { animated: true }).metadata();
  } catch {
    meta = null;
  }
  if (meta && INPUT_FORMATS.includes(meta.format)) return meta;
  const head = buffer.subarray(0, 120).toString('utf8');
  /* Бинарный мусор в ошибку не выводим: он ничего не объясняет и ломает строку. */
  const printable = head && !/[\x00-\x08\x0e-\x1f�]/.test(head);
  throw new SourceError(
    `${label} — не картинка${printable ? `: начинается с «${head.replace(/\s+/g, ' ').trim().slice(0, 80)}»` : ''}.`,
    415,
  );
}

/** Тело с потолком, который проверяется по мере чтения: content-length бывает враньём или его нет. */
export async function readCapped(stream, max) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > max) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fromUrl(src) {
  let res;
  try {
    res = await fetch(src, { redirect: 'follow', signal: AbortSignal.timeout(CONFIG.defaultTimeout) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `не ответил за ${CONFIG.defaultTimeout} мс` : err.cause?.message || err.message;
    throw new SourceError(
      `Не скачать ${src}: ${reason}. Стенд в контейнере: localhost здесь — сам стенд; проект — по имени его контейнера, хост — host.docker.internal, локальный файл — через /upload.`,
    );
  }
  if (!res.ok) throw new SourceError(`Не скачать ${src}: ответ ${res.status}.`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > CONFIG.maxUploadBytes) throw tooLarge(declared);
  const buffer = await readCapped(res.body, CONFIG.maxUploadBytes);
  const name = decodeURIComponent(new URL(res.url || src).pathname.split('/').pop() || '') || 'image';
  return { buffer, name, from: src };
}

async function fromArtifacts(src) {
  const rel = src.startsWith('lt://artifacts/') ? src.slice('lt://artifacts/'.length) : src;
  const abs = resolveInArtifacts(decodeURIComponent(rel));
  const info = await fs.stat(abs).catch(() => null);
  if (!info?.isFile()) {
    throw new SourceError(
      `Нет файла ${src} в артефактах. Принимаются http(s)-адрес, lt://artifacts/… или путь внутри артефактов; путь на машине пользователя стенду не виден — такой файл отдают через /upload.`,
      404,
    );
  }
  if (info.size > CONFIG.maxUploadBytes) throw tooLarge(info.size);
  return { buffer: await fs.readFile(abs), name: path.basename(abs), from: src };
}

/** Исходник по строке src: http(s)-адрес, lt://artifacts/… или путь внутри артефактов. */
export async function loadSource(src) {
  const value = String(src ?? '').trim();
  if (!value) throw new SourceError('Пустой src.');
  const loaded = /^https?:\/\//i.test(value) ? await fromUrl(value) : await fromArtifacts(value);
  const meta = await imageMeta(loaded.buffer, value);
  return { ...loaded, meta };
}
