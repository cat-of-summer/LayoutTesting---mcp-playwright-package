/**
 * Пятый отзыв на настоящих инструментах, по JSON-RPC: скрытие кнопки «наверх» в снимке,
 * clearance у текста на картинке и переход на сервер, который принимает соединение и молчит.
 *
 *   LT_BROWSER_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.LT_UPDATE_CHECK = '0';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const FIXTURES = path.join(path.resolve(import.meta.dirname, '..'), 'fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };

let client;
let pool;
let sharp;
let server;
let base;
let sessionId;
let scheme;

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

test.before(async () => {
  if (!enabled) return;
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  pool = await import('../src/browser/pool.js');
  sharp = (await import('sharp')).default;

  /* Схема: непрозрачный круг радиусом 150 в центре прозрачного PNG 400×400. */
  scheme = await sharp(
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><circle cx="200" cy="200" r="150" fill="#0a7"/></svg>'),
  )
    .png()
    .toBuffer();

  server = http.createServer(async (req, res) => {
    const name = path.basename(req.url.split('?')[0]);
    try {
      const body = name === 'scheme.png' ? scheme : await fs.readFile(path.join(FIXTURES, name));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = await createServer();
  await mcp.connect(serverSide);
  client = new Client({ name: 'feedback-5-e2e', version: '1' });
  await client.connect(clientSide);
  ({ sessionId } = await call('browser_open', { viewport: '1440x900', keepAlive: true, animations: 'allow' }));
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

/* Цвет пикселя кадра в точке окна. */
async function pixel(file, x, y) {
  const { data } = await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

test('screenshot hide: кнопка с .is-visible и иконкой со своим visibility уходит из кадра, промах назван', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/hide-to-top.html` });
  const page = pool.getSession(sessionId).page;

  /* Механизм из отзыва: одно visibility:hidden !important на кнопке иконку не прячет. */
  const leaked = await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.to-top{visibility:hidden !important}';
    document.head.appendChild(style);
    const visible = document.querySelector('.to-top .icon').checkVisibility({ visibilityProperty: true });
    style.remove();
    return visible;
  });
  assert.equal(leaked, true, 'потомок со своим visibility: visible виден сквозь скрытого родителя');

  const shot = await call('screenshot', { sessionId, fullPage: false, hide: ['.to-top', 'div[['] });
  assert.deepEqual(shot.hidden[0], { selector: '.to-top', matched: 1 });
  assert.equal(shot.hidden[1].invalid, true);
  assert.match(shot.hideWarning, /div\[\[ — невалидный селектор/);
  /* Центр иконки (синяя) и угол кнопки (красная) — в кадре белый фон. */
  assert.deepEqual(await pixel(shot.path, 1440 - 20 - 24, 900 - 20 - 24), [255, 255, 255]);
  assert.deepEqual(await pixel(shot.path, 1440 - 20 - 4, 900 - 20 - 4), [255, 255, 255]);
  /* После кадра страница прежняя. */
  assert.equal(await page.evaluate(() => document.querySelector('.to-top .icon').checkVisibility({ visibilityProperty: true })), true);
});

test('layout_audit textOverImage: clearance называет масштаб и сдвиг, при которых строка чиста', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/ink-clearance.html` });
  const res = await call('layout_audit', { sessionId, categories: ['textOverImage'] });
  const finding = res.issues.textOverImage.find((item) => item.text === 'Подпись схемы');
  assert.ok(finding, JSON.stringify(res.issues.textOverImage));
  assert.ok(finding.ink > 0.3, `под строкой край круга: ink ${finding.ink}`);
  const { clearance } = finding;
  assert.equal(clearance.margin, 8);
  /* Край круга 200 + 150·s плюс отступ 8 должен уйти левее строки на x = 300: s ≈ 0.61. */
  assert.ok(clearance.scale >= 0.55 && clearance.scale <= 0.66, JSON.stringify(clearance));
  assert.ok(Math.abs(clearance.shift.left - 58) <= 6, JSON.stringify(clearance));
  assert.match(finding.why, /чисто при scale 0\.\d+ к центру или сдвиге картинки/);

  /* Проверка подбором: с найденным масштабом находки нет. */
  const page = pool.getSession(sessionId).page;
  await page.evaluate((s) => {
    document.querySelector('.scheme img').style.transform = `scale(${s})`;
  }, clearance.scale);
  const after = await call('layout_audit', { sessionId, categories: ['textOverImage'] });
  assert.ok(!after.issues.textOverImage.some((item) => item.text === 'Подпись схемы' && item.ink > 0), JSON.stringify(after.issues.textOverImage));
});

test('browser_goto на порт, который принимает соединение и молчит: диагноз вместо голого таймаута', options, async () => {
  const sockets = [];
  const silent = net.createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${silent.address().port}/`;
  const session = await pool.createSession({ viewport: '1280x800' }, { owned: 'internal' });
  try {
    const res = await pool.gotoAndSettle(session, url, { timeout: 3000 });
    assert.equal(res.navigationTimedOut, true);
    assert.equal(res.server.state, 'acceptedNoResponse');
    assert.match(res.note, /не прислал ответ на сам документ/);
    assert.match(res.hint, /принимает соединение, но не присылает ни байта/);
  } finally {
    await pool.closeSession(session.id);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }
});
