/**
 * Вшивание картинок в отчёт. Нужен sharp, но не нужен браузер.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { imageDataUri } from '../src/checks/visual.js';
import { renderMatrixReport } from '../src/report.js';

let dir;
let shot;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-report-'));
  shot = path.join(dir, 'shot.png');
  await sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 120, b: 60 } },
  })
    .png()
    .toFile(shot);
});

test.after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('imageDataUri уменьшает и перекодирует', async () => {
  const { uri, width, bytes } = await imageDataUri(shot, { format: 'webp', maxWidth: 400 });

  assert.equal(width, 400, 'ширина должна упасть до maxWidth');
  assert.ok(uri.startsWith('data:image/webp;base64,'), `неожиданный префикс: ${uri.slice(0, 40)}`);
  assert.ok(bytes < (await fs.stat(shot)).size, 'перекодированная картинка должна быть легче исходной');
});

test('imageDataUri не растягивает картинку меньше maxWidth', async () => {
  const small = path.join(dir, 'small.png');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#123456' } })
    .png()
    .toFile(small);

  const { width } = await imageDataUri(small, { maxWidth: 1000 });
  assert.equal(width, 120);
});

const cell = (key, shotPath) => ({
  key,
  ok: true,
  summary: { verdict: 'проблем не найдено', layoutIssues: 0 },
  results: { screenshot: { path: shotPath } },
});

test('обычный отчёт ссылается на соседние файлы', async () => {
  const html = await renderMatrixReport({
    url: 'http://example.com',
    name: 'проба',
    runId: 'run-1',
    cells: [cell('chromium_1440x900', shot)],
  });

  assert.match(html, /src="shot\.png"/, 'по умолчанию должна остаться ссылка на файл рядом');
});

test('с inlineImages отчёт становится самодостаточным', async () => {
  const html = await renderMatrixReport({
    url: 'http://example.com',
    name: 'проба',
    runId: 'run-1',
    cells: [cell('chromium_1440x900', shot), cell('chromium_375x812', shot)],
    inlineImages: true,
    image: { format: 'webp', maxWidth: 300 },
  });

  const external = html.match(/src="(?!data:)[^"]*"/g);
  assert.equal(external, null, `остались внешние ссылки: ${external}`);
  assert.equal((html.match(/src="data:image\/webp;base64,/g) || []).length, 2);
});
