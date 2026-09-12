/**
 * Загрузка картинки на стенд: POST /upload.
 *
 * Стенд в контейнере не видит файлов проекта на хосте, а гнать картинку через MCP нечем:
 * base64 в параметре инструмента — это мегабайты в ответе модели. Поэтому файл отдаётся стенду
 * мимо протокола, одной командой curl, а в инструмент идёт уже короткий адрес lt://artifacts/….
 *
 *   curl -F file=@hero.jpg -F file=@card.png http://127.0.0.1:8089/upload
 *   curl --data-binary @hero.jpg "http://127.0.0.1:8089/upload?name=hero.jpg"
 *
 * Файлы ложатся прогоном в artifacts/ и чистятся вместе с остальными прогонами: это
 * промежуточный материал, а не хранилище.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { artifactRef, newRunId, runDir, slug } from '../artifacts.js';
import { SourceError, imageMeta, readCapped } from './source.js';

const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tiff', svg: 'svg', heif: 'heic' };

const USAGE = `Загрузка картинки на стенд для image_convert:
  curl -F file=@hero.jpg ${CONFIG.publicBaseUrl}/upload
  curl --data-binary @hero.jpg "${CONFIG.publicBaseUrl}/upload?name=hero.jpg"
В ответе src — его и передают в image_convert.
`;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** Имя файла на стенде: латиница и кириллица из исходного имени, расширение — по настоящему формату. */
function fileName(original, format, taken) {
  const stem = slug(path.basename(original || '', path.extname(original || ''))) || 'upload';
  let name = `${stem}.${EXT[format] || format}`;
  for (let i = 2; taken.has(name); i += 1) name = `${stem}-${i}.${EXT[format] || format}`;
  taken.add(name);
  return name;
}

/** Тело запроса как поток с потолком: formData() иначе прочитал бы в память сколько пришлют. */
async function* capped(req, max) {
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) throw new SourceError(`Загрузка больше потолка ${max} байт. Потолок задаёт LT_MAX_UPLOAD_BYTES.`, 413);
    yield chunk;
  }
}

async function readParts(req, url) {
  const type = String(req.headers['content-type'] || '');
  if (type.startsWith('multipart/form-data')) {
    const request = new Request('http://stand/upload', {
      method: 'POST',
      headers: { 'content-type': type },
      body: capped(req, CONFIG.maxUploadBytes),
      duplex: 'half',
    });
    let form;
    try {
      form = await request.formData();
    } catch (err) {
      if (err instanceof SourceError) throw err;
      if (err.cause instanceof SourceError) throw err.cause;
      throw new SourceError(`multipart не разобран: ${err.message}.`);
    }
    const parts = [];
    for (const [, value] of form) {
      if (typeof value === 'object' && typeof value.arrayBuffer === 'function') {
        parts.push({ name: value.name, buffer: Buffer.from(await value.arrayBuffer()) });
      }
    }
    return parts;
  }
  const buffer = await readCapped(req, CONFIG.maxUploadBytes);
  return buffer.length ? [{ name: url.searchParams.get('name') || '', buffer }] : [];
}

export async function handleUpload(req, res, url) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
    res.end(USAGE);
    return;
  }
  const declared = Number(req.headers['content-length']);
  if (declared > CONFIG.maxUploadBytes) {
    send(res, 413, { error: `Загрузка ${declared} байт больше потолка ${CONFIG.maxUploadBytes}. Потолок задаёт LT_MAX_UPLOAD_BYTES.` });
    req.resume();
    return;
  }

  let parts;
  try {
    parts = await readParts(req, url);
  } catch (err) {
    send(res, err.status || 400, { error: err.message });
    return;
  }
  if (!parts.length) {
    send(res, 400, { error: 'Файла в запросе нет.', usage: USAGE });
    return;
  }

  /* Проверка до записи: каталог прогона не заводится ради одного текстового файла. */
  const accepted = [];
  const rejected = [];
  for (const part of parts) {
    try {
      accepted.push({ ...part, meta: await imageMeta(part.buffer, part.name || 'файл') });
    } catch (err) {
      rejected.push({ name: part.name || null, error: err.message });
    }
  }
  if (!accepted.length) {
    send(res, 415, { error: 'Ни одной картинки среди загруженного.', rejected });
    return;
  }

  const dir = await runDir(newRunId('upload'));
  const taken = new Set();
  const files = [];
  for (const { name, buffer, meta } of accepted) {
    const file = path.join(dir, fileName(name, meta.format, taken));
    await fs.writeFile(file, buffer);
    const ref = artifactRef(file);
    files.push({
      name: path.basename(file),
      format: meta.format,
      size: meta.width && meta.height ? `${meta.width}x${meta.pages > 1 ? meta.pageHeight : meta.height}` : null,
      bytes: buffer.length,
      src: ref.uri,
      url: ref.url,
    });
  }
  send(res, 200, { files, ...(rejected.length ? { rejected } : {}), next: 'Передайте src в image_convert.' });
}
