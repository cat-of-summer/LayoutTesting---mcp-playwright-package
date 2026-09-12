/**
 * Конвертация картинок: размеры, форматы, разметка <picture> и источники. Браузер не нужен.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';

import { convertImages, pictureMarkup } from '../src/media/convert.js';
import { loadSource } from '../src/media/source.js';
import { newRunId, runDir } from '../src/artifacts.js';

let server;
let base;
let jpeg;
let alphaPng;

test.before(async () => {
  jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .jpeg({ quality: 95 })
    .toBuffer();
  alphaPng = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();

  server = http.createServer((req, res) => {
    if (req.url === '/photo.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(jpeg);
    } else if (req.url === '/alpha.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(alphaPng);
    } else if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Вход</title>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

test('набор ширин в двух форматах, без увеличения и с пометкой о пропущенном', async () => {
  const { images } = await convertImages([`${base}/photo.jpg`], { widths: [480, 960, 2000], formats: ['avif', 'webp'] });
  const [image] = images;
  assert.equal(image.source.size, '1200x800');
  assert.deepEqual(image.skipped, ['2000w']);
  assert.equal(image.outputs.length, 4);
  for (const out of image.outputs) {
    const meta = await sharp(out.file.path).metadata();
    assert.equal(meta.format === 'heif' ? 'avif' : meta.format, out.format);
    assert.equal(meta.width, out.width);
    assert.equal(out.height, Math.round((out.width * 800) / 1200));
  }
  assert.match(image.outputs[0].name, /^photo-480w\.avif$/);
  assert.match(image.picture, /<source type="image\/avif" srcset="photo-480w\.avif 480w, photo-960w\.avif 960w"/);
  assert.match(image.picture, /<img src="photo-960w\.webp" srcset="[^"]+" sizes="[^"]+" width="960" height="640"/);
});

test('все ширины шире исходника — отдаётся исходный размер, а не пустота', async () => {
  const { images } = await convertImages([`${base}/photo.jpg`], { widths: [3000], formats: ['webp'] });
  assert.equal(images[0].outputs.length, 1);
  assert.equal(images[0].outputs[0].width, 1200);
});

test('jpeg из прозрачного png заливается фоном, а не чёрным', async () => {
  const { images } = await convertImages([`${base}/alpha.png`], { formats: ['jpeg'], background: '#ffffff' });
  const { data } = await sharp(images[0].outputs[0].file.path).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240, `фон должен быть белым, а пиксель ${data[0]}`);
});

test('cover с высотой кадрирует точно в размер', async () => {
  const { images } = await convertImages([`${base}/photo.jpg`], { widths: [300], height: 300, fit: 'cover', formats: ['webp'] });
  assert.equal(images[0].outputs[0].width, 300);
  assert.equal(images[0].outputs[0].height, 300);
});

test('original совпадающий с названным форматом не даёт двух файлов под одним именем', async () => {
  const { images } = await convertImages([`${base}/photo.jpg`], { formats: ['jpeg', 'original'] });
  assert.equal(images[0].outputs.length, 1);
});

test('страница вместо картинки даёт внятную ошибку с началом ответа', async () => {
  await assert.rejects(() => loadSource(`${base}/page`), /не картинка: начинается с «<!doctype html>/);
});

test('404 и путь хоста называются как есть, с подсказкой про /upload', async () => {
  await assert.rejects(() => loadSource(`${base}/nope.jpg`), /ответ 404/);
  await assert.rejects(() => loadSource('C:/Users/me/hero.jpg'), /\/upload|выходит за пределы/);
});

test('битый исходник в списке не роняет остальные', async () => {
  const result = await convertImages([`${base}/photo.jpg`, `${base}/nope.jpg`], { widths: [200] });
  assert.equal(result.images.length, 1);
  assert.equal(result.failed.length, 1);
});

test('исходник из артефактов принимается и по lt://, и по относительному пути', async () => {
  const runId = newRunId('test-source');
  const dir = await runDir(runId);
  await fs.writeFile(path.join(dir, 'a.jpg'), jpeg);
  assert.equal((await loadSource(`lt://artifacts/${runId}/a.jpg`)).meta.width, 1200);
  assert.equal((await loadSource(`${runId}/a.jpg`)).meta.width, 1200);
  await assert.rejects(() => loadSource('lt://artifacts/../state/x.jpg'), /выходит за пределы|закрыт/);
});

test('<picture> для одного размера и одного формата — просто <img>', () => {
  const markup = pictureMarkup([{ name: 'a.webp', format: 'webp', width: 10, height: 5 }]);
  assert.equal(markup, '<img src="a.webp" width="10" height="5" alt="" loading="lazy" decoding="async">');
});
