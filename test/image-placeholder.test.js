/**
 * Заглушки: рисунок как у генератора и файлы нужного размера. Браузер не нужен — рисует sharp.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { parseSize, placeholderSvg, rasterize, renderPlaceholders } from '../src/media/placeholder.js';

const pixel = async (buffer, x, y) => {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

test('подпись по умолчанию — размер и пропорция через НОД', () => {
  const svg = placeholderSvg({ width: 600, height: 400 });
  assert.match(svg, /600×400/);
  assert.match(svg, />3:2</);
  assert.equal((svg.match(/<linearGradient/g) || []).length, 4, 'крест и две диагонали — четыре градиента');
  assert.match(svg, /stop-color="#999999"\/><stop offset="0.5" stop-color="#eeeeee"/, 'рамка → фон → рамка');
});

test('текст экранируется, а не пишется в разметку', () => {
  const svg = placeholderSvg({ width: 100, height: 100, text: '<b>&"x"' });
  assert.match(svg, /&lt;b&gt;&amp;&quot;x&quot;/);
  assert.doesNotMatch(svg, /<b>/);
});

test('цвет с кавычкой отклоняется: он дописал бы в SVG что угодно', () => {
  assert.throws(() => placeholderSvg({ width: 10, height: 10, bg: '#fff" onload="x' }), /не похоже на цвет/);
});

test('размер разбирается в разных записях и не бывает огромным', () => {
  assert.deepEqual(parseSize('600x400'), { width: 600, height: 400 });
  assert.deepEqual(parseSize('600×400'), { width: 600, height: 400 });
  assert.throws(() => parseSize('600'), /600x400/);
  assert.throws(() => parseSize('90000x10'), /от 1 до/);
});

test('растр нужного размера: фон в углу за рамкой, в центре не фон', async () => {
  const png = await rasterize(placeholderSvg({ width: 300, height: 200, borderWidth: 4 }), 'png');
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 300);
  assert.equal(meta.height, 200);
  assert.deepEqual(await pixel(png, 1, 1), [0x99, 0x99, 0x99], 'угол — рамка');
  assert.deepEqual(await pixel(png, 40, 12), [0xee, 0xee, 0xee], 'между рамкой и диагональю — фон');
});

test('подпись действительно отрисована: шрифт в системе есть', async () => {
  /* Без диагоналей и рамки всё не-фоновое в середине — текст. Квадраты вместо букв тоже дали бы
     не-фон, поэтому считаем долю: у пустых прямоугольников тофу она заметно выше. */
  const png = await rasterize(placeholderSvg({ width: 400, height: 200, borderWidth: 0, text: 'AB' }), 'png');
  const { data, info } = await sharp(png).extract({ left: 100, top: 50, width: 200, height: 100 }).raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] < 0x80) ink += 1;
  assert.ok(ink > 200, `в центре почти нет текста: ${ink} тёмных точек`);
});

test('набор заглушек: одинаковые размеры не дублируются, scale удваивает растр, но не подпись', async () => {
  const { files, runId } = await renderPlaceholders(['600x400', '600×400', '100x100'], { format: 'webp', scale: 2 });
  assert.ok(runId);
  assert.equal(files.length, 2);
  const [first] = files;
  assert.equal(first.size, '600x400');
  assert.equal(first.pixels, '1200x800');
  assert.match(first.file.path, /600x400@2x\.webp$/);
  assert.match(first.file.uri, /^lt:\/\/artifacts\//);
  const meta = await sharp(first.file.path).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 1200);
});

test('svg отдаётся исходником', async () => {
  const { files } = await renderPlaceholders(['64x64'], { format: 'svg' });
  assert.match(files[0].file.path, /64x64\.svg$/);
});
