/**
 * Загрузка картинки на стенд: POST /upload. Поднимается только обработчик, без MCP и браузера.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';

import { CONFIG } from '../src/config.js';
import { handleUpload } from '../src/media/upload.js';
import { loadSource } from '../src/media/source.js';

let server;
let base;
let png;

test.before(async () => {
  png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#336699' } }).png().toBuffer();
  server = http.createServer((req, res) => handleUpload(req, res, new URL(req.url, 'http://stand')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/upload`;
});

test.after(() => server?.close());

test('сырое тело: имя из ?name, расширение по настоящему формату', async () => {
  const res = await fetch(`${base}?name=Фото героя.jpg`, { method: 'POST', body: png });
  assert.equal(res.status, 200);
  const { files } = await res.json();
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'фото-героя.png', 'png, присланный под именем .jpg, остаётся png');
  assert.equal(files[0].size, '64x32');
  assert.match(files[0].src, /^lt:\/\/artifacts\/.+_upload\/фото-героя\.png$/);
  assert.equal((await loadSource(files[0].src)).meta.width, 64, 'src из ответа принимается image_convert');
});

test('multipart с несколькими файлами и отбраковкой не-картинки', async () => {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  form.append('file', new Blob(['просто текст'], { type: 'text/plain' }), 'notes.txt');
  const res = await fetch(base, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.files.map((f) => f.name), ['a.png', 'a-2.png'], 'одинаковые имена не затирают друг друга');
  assert.equal(body.rejected.length, 1);
  assert.match(body.rejected[0].error, /не картинка/);
});

test('ни одной картинки — 415', async () => {
  const res = await fetch(base, { method: 'POST', body: 'hello' });
  assert.equal(res.status, 415);
});

test('больше потолка — 413, и по заявленной длине, и по факту чтения', async () => {
  const saved = CONFIG.maxUploadBytes;
  CONFIG.maxUploadBytes = 100;
  try {
    const declared = await fetch(base, { method: 'POST', body: png });
    assert.equal(declared.status, 413);

    /* Поток без content-length: потолок должен сработать по мере чтения. */
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(png));
        controller.close();
      },
    });
    const chunked = await fetch(base, { method: 'POST', body: stream, duplex: 'half' });
    assert.equal(chunked.status, 413);
  } finally {
    CONFIG.maxUploadBytes = saved;
  }
});

test('GET отвечает подсказкой, как загружать', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 405);
  assert.match(await res.text(), /curl -F file=@/);
});
