/**
 * Правки по третьему отзыву — проверка браузерных игр — и по журналу использования: что стенд
 * не давал сделать и из-за чего агент уходил в свои скрипты Playwright. Здесь всё, что
 * считается без браузера; действия на странице — в act-input-e2e.
 *
 * Логи таймаутов — настоящие, из state/usage: так их видел агент, и разбор обязан понимать
 * именно такой текст, а не придуманный.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { explainTimeout } from '../src/browser/act.js';
import { contextOptions, normalizeProfile, profileKey } from '../src/browser/profile.js';
import { redactArgs } from '../src/usage/redact.js';
import { exportFile } from '../src/exports.js';

const DISABLED = `locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('[data-confirm]').first()
    - locator resolved to <button disabled type="button" data-confirm="" class="btn btn--danger">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    58 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms`;

const COVERED = `locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('.Box-row:has-text("Shop") .Box-rowMeta').first()
    - locator resolved to <div class="Box-rowMeta">…</div>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <a class="Box-rowLink" href="/block/00000002?mock=demo">Shop</a> intercepts pointer events
    - retrying click action`;

const MISSING = `locator.waitFor: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('[data-prop="ftp"]').first() to be visible`;

test('таймаут: disabled-кнопка — причина первой строкой, без шестидесяти повторов', () => {
  const text = explainTimeout(DISABLED, { action: 'click', selector: '[data-confirm]' });
  const [first] = text.split('\n');
  assert.match(first, /^click \[data-confirm\]: не выполнено за 30000 мс — элемент неактивен \(disabled\)/);
  assert.match(first, /<button disabled/);
  assert.ok(text.split('\n').length <= 2, 'хвост лога — одной строкой');
  assert.ok((text.match(/element is not enabled/g) || []).length <= 1, 'повторы схлопнуты');
});

test('таймаут: перекрытый элемент называет, кто перекрывает', () => {
  const first = explainTimeout(COVERED, { action: 'click', selector: '.Box-rowMeta' }).split('\n')[0];
  assert.match(first, /перекрыт: события забирает <a class="Box-rowLink"/);
  assert.match(first, /force: true/);
});

test('таймаут: ненайденный селектор отправляет к page_snapshot', () => {
  const first = explainTimeout(MISSING, { action: 'wait', selector: '[data-prop="ftp"]' }).split('\n')[0];
  assert.match(first, /за 10000 мс — селектор ничего не нашёл/);
  assert.match(first, /page_snapshot/);
});

test('touch: только касания — раскладка и UA не трогаются', () => {
  const p = normalizeProfile({ viewport: '520x760', deviceScaleFactor: 2, touch: true });
  assert.deepEqual(p.viewport, { width: 520, height: 760 });
  const ctx = contextOptions(p);
  assert.equal(ctx.hasTouch, true);
  assert.equal(ctx.isMobile, undefined, 'isMobile разложил бы страницу без meta viewport на 980px');
  assert.equal(ctx.userAgent, undefined);
  assert.equal(profileKey(p), 'chromium_520x760_dpr2_touch');
});

test('device: телефон целиком, явные параметры сильнее, имя без учёта регистра', () => {
  const p = normalizeProfile({ device: 'iphone 13' });
  assert.equal(p.device, 'iPhone 13');
  const ctx = contextOptions(p);
  assert.equal(ctx.hasTouch, true);
  assert.equal(ctx.isMobile, true);
  assert.equal(ctx.deviceScaleFactor, 3);
  assert.match(ctx.userAgent, /iPhone/);
  assert.equal(profileKey(p), `chromium_${p.viewport.width}x${p.viewport.height}_dpr3_touch_mobile`);

  const tuned = normalizeProfile({ device: 'iPhone 13', viewport: '390x500', touch: false });
  assert.deepEqual(tuned.viewport, { width: 390, height: 500 });
  assert.equal(contextOptions(tuned).hasTouch, undefined);
  assert.equal(normalizeProfile({ device: 'iPhone 13', viewport: undefined }).viewport.height, p.viewport.height, 'undefined не затирает устройство');
});

test('device: промах подсказывает похожие имена', () => {
  assert.throws(() => normalizeProfile({ device: 'iphone 99' }), /не найдено/);
  assert.throws(() => normalizeProfile({ device: 'pixel' }), /Похожие: .*Pixel/);
});

test('пресет mobile остался прежним: эталоны не переименовываются', () => {
  const p = normalizeProfile({ viewport: 'mobile' });
  assert.equal(profileKey(p), 'chromium_375x812');
  assert.equal(contextOptions(p).hasTouch, undefined);
});

test('журнал: ввод в шагах пакета browser_act маскируется', () => {
  const out = redactArgs('browser_act', {
    sessionId: 's',
    steps: [
      { action: 'fill', selector: '#pass', value: 'secret-1' },
      { action: 'press', value: 'Enter' },
      { action: 'eval', expression: 'game.score' },
    ],
  });
  assert.equal(out.steps[0].value, '[скрыто: 8 симв.]');
  assert.equal(out.steps[1].value, 'Enter', 'клавиша — не секрет');
  assert.equal(out.steps[2].expression, 'game.score');
});

test('выгрузка: путь от корня, абсолютный путь хоста, расширение и выход за корень', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-exports-'));
  const dir = path.join(tmp, 'exports');
  const source = path.join(tmp, 'shot.png');
  await fs.writeFile(source, 'png');
  const before = process.env.EXPORTS_DIR;
  t.after(async () => {
    if (before === undefined) delete process.env.EXPORTS_DIR;
    else process.env.EXPORTS_DIR = before;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  delete process.env.EXPORTS_DIR;
  await assert.rejects(exportFile(source, 'a.png', { dir, url: 'http://x/shot.png' }), /не настроена.*curl -fsSL -o <путь> http:\/\/x\/shot\.png/);

  await fs.mkdir(dir);
  const plain = await exportFile(source, 'games/puzzle', { dir });
  assert.equal(plain.path, 'games/puzzle.png', 'расширение исходника дописано');
  assert.equal(plain.hostPath, null);
  assert.equal(await fs.readFile(path.join(dir, 'games', 'puzzle.png'), 'utf8'), 'png');

  process.env.EXPORTS_DIR = 'O:\\Projects\\Game\\';
  const host = await exportFile(source, 'o:/projects/game/shots/', { dir });
  assert.equal(host.path, 'shots/shot.png', 'папка — имя у исходника, регистр диска не важен');
  assert.equal(host.hostPath, 'O:/Projects/Game/shots/shot.png');

  await assert.rejects(exportFile(source, 'D:/elsewhere/x.png', { dir }), /вне папки выгрузки/);
  await assert.rejects(exportFile(source, '../x.png', { dir }), /выходит за пределы папки выгрузки/);

  /* Стенд в WSL: compose видит /mnt/o/…, агент на Windows пишет O:/… — это одна папка. */
  process.env.EXPORTS_DIR = '/mnt/o/Projects';
  const wsl = await exportFile(source, 'O:\\Projects\\game\\w.png', { dir });
  assert.equal(wsl.path, 'game/w.png');
  assert.equal(wsl.hostPath, '/mnt/o/Projects/game/w.png');
  assert.equal(wsl.windowsPath, 'O:/Projects/game/w.png');
  assert.equal((await exportFile(source, '/mnt/o/Projects/game/l.png', { dir })).path, 'game/l.png');
  process.env.EXPORTS_DIR = '/mnt/o';
  assert.equal((await exportFile(source, 'o:/x/d.png', { dir })).windowsPath, 'O:/x/d.png', 'корень диска');
  await assert.rejects(exportFile(source, 'D:/x.png', { dir }), /вне папки выгрузки/);

  process.env.EXPORTS_DIR = './exports';
  const relative = await exportFile(source, 'r.png', { dir });
  assert.equal(relative.hostPath, './exports/r.png');
  assert.match(relative.note, /относительно каталога/);
});
