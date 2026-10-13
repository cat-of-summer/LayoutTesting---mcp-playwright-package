/**
 * Ввод по отзыву с проверки игр: зажатые клавиши, перетаскивание по canvas, касания и пакет
 * шагов — через настоящие инструменты по JSON-RPC, как их зовёт агент.
 *
 * До этих правок всё это агент делал скриптами Playwright из образа стенда, в обход него:
 * press был только «нажал-отпустил», drag не было, касаний сессия не получала вовсе, а восемь
 * пробелов уходили восемью вызовами с задержкой между ними.
 *
 * Нужен браузер и полный набор зависимостей:
 *
 *   LT_BROWSER_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.LT_UPDATE_CHECK = '0';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');

let client;
let closeAll;
let server;
let page;

/** Ответ инструмента целиком: ошибки здесь проверяются, а не только успех. */
async function raw(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { isError: Boolean(res.isError), data, text };
}

async function call(name, args) {
  const res = await raw(name, args);
  if (res.isError) throw new Error(`${name}: ${res.text}`);
  return res.data;
}

const events = async (sessionId) => (await call('browser_eval', { sessionId, expression: 'window.log' })).value;

test.before(async () => {
  if (!enabled) return;
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  ({ closeAll } = await import('../src/browser/pool.js'));

  server = http.createServer(async (req, res) => {
    try {
      const body = await fs.readFile(path.join(FIXTURES, path.basename(req.url.split('?')[0])));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  page = `http://127.0.0.1:${server.address().port}/act-input.html`;

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = await createServer();
  await mcp.connect(serverSide);
  client = new Client({ name: 'act-input-e2e', version: '1' });
  await client.connect(clientSide);
});

test.after(async () => {
  if (closeAll) await closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('press с duration держит клавишу, down и up — раздельно', options, async () => {
  const { sessionId, idle } = await call('browser_open', { url: page });
  assert.match(idle, /keepAlive/, 'про простой и keepAlive сказано сразу, а не ошибкой');

  const held = await call('browser_act', { sessionId, action: 'press', value: 'ArrowLeft', duration: 400 });
  assert.equal(held.heldMs, 400);
  await call('browser_act', { sessionId, action: 'down', value: 'ArrowRight' });
  await call('browser_act', { sessionId, action: 'up', value: 'ArrowRight' });

  const log = await events(sessionId);
  const down = log.find((e) => e.type === 'keydown' && e.key === 'ArrowLeft');
  const up = log.find((e) => e.type === 'keyup' && e.key === 'ArrowLeft');
  assert.ok(down.trusted, 'событие настоящее, а не dispatchEvent');
  assert.ok(up.t - down.t >= 380, `клавиша отпущена через ${up.t - down.t} мс, ждали ~400`);
  assert.deepEqual(
    log.filter((e) => e.key === 'ArrowRight').map((e) => e.type),
    ['keydown', 'keyup'],
  );
  await call('browser_close', { sessionId });
});

test('drag по canvas: точки от угла элемента, с промежуточными шагами', options, async () => {
  const { sessionId } = await call('browser_open', { url: page });
  const res = await call('browser_act', {
    sessionId,
    action: 'drag',
    selector: '#board',
    x: 20,
    y: 30,
    to: { x: 220, y: 130 },
    duration: 320,
  });
  assert.equal(res.pointer, 'mouse');
  assert.deepEqual(res.from, { x: 120, y: 110 }, 'от угла canvas (100, 80), а не страницы');

  const log = await events(sessionId);
  const down = log.find((e) => e.type === 'pointerdown');
  const moves = log.filter((e) => e.type === 'pointermove' && e.t >= down.t);
  const up = log.find((e) => e.type === 'pointerup');
  assert.deepEqual({ x: down.x, y: down.y }, { x: 20, y: 30 });
  assert.deepEqual({ x: up.x, y: up.y }, { x: 220, y: 130 });
  assert.ok(moves.length >= 10, `промежуточных точек ${moves.length}: жест, а не телепорт`);
  assert.ok(up.t - down.t >= 250, `жест длился ${up.t - down.t} мс`);
  await call('browser_close', { sessionId });
});

test('касания: device даёт coarse и tap, без касаний tap — понятная ошибка', options, async () => {
  const plain = await call('browser_open', { url: page });
  const refused = await raw('browser_act', { sessionId: plain.sessionId, action: 'tap', selector: '#board' });
  assert.ok(refused.isError);
  assert.match(refused.text, /touch: true или device/);
  await call('browser_close', { sessionId: plain.sessionId });

  const phone = await call('browser_open', { url: page, device: 'iphone 13' });
  assert.match(phone.profileKey, /dpr3.*touch.*mobile/);
  const media = await call('browser_eval', {
    sessionId: phone.sessionId,
    expression: "({ coarse: matchMedia('(pointer: coarse)').matches, ua: navigator.userAgent })",
  });
  assert.equal(media.value.coarse, true);
  assert.match(media.value.ua, /iPhone/);

  await call('browser_act', { sessionId: phone.sessionId, action: 'tap', selector: '#board', x: 10, y: 10 });
  const swipe = await call('browser_act', {
    sessionId: phone.sessionId,
    action: 'drag',
    selector: '#board',
    x: 10,
    y: 100,
    to: { x: 200, y: 100 },
    duration: 200,
  });
  assert.equal(swipe.pointer, 'touch');
  const types = (await events(phone.sessionId)).map((e) => e.type);
  assert.ok(types.includes('touchstart') && types.includes('touchend'), `касания дошли: ${types.join(',')}`);
  assert.ok(types.filter((t) => t === 'touchmove').length >= 5, 'палец провёл через промежуточные точки');
  await call('browser_close', { sessionId: phone.sessionId });
});

test('пакет: восемь пробелов, пауза, кадр и чтение состояния одним вызовом', options, async () => {
  const { sessionId } = await call('browser_open', { url: page });
  const steps = [
    ...Array.from({ length: 8 }, () => ({ action: 'press', value: ' ' })),
    { action: 'wait', duration: 200 },
    { action: 'screenshot', name: 'after', selector: '#board' },
    { action: 'eval', expression: "window.log.filter((e) => e.type === 'keydown').length" },
  ];
  const res = await call('browser_act', { sessionId, steps });
  assert.equal(res.ok, true);
  assert.equal(res.steps.length, 11);
  assert.ok(res.steps.every((s, i) => i === 0 || s.atMs >= res.steps[i - 1].atMs), 'atMs растут');
  assert.ok(res.steps[9].atMs - res.steps[8].atMs >= 190, 'пауза выдержана');
  assert.match(res.steps[9].uri, /^lt:\/\/artifacts\//, 'у кадра есть ref артефакта');
  assert.equal(res.steps[10].value, 8);

  const broken = await raw('browser_act', { sessionId, steps: [{ action: 'wait', durtion: 10 }] });
  assert.ok(broken.isError);
  assert.match(broken.text, /Шаг 0/, 'опечатка в поле шага — ошибка, а не пауза в ноль');

  const stopped = await raw('browser_act', {
    sessionId,
    steps: [{ action: 'press', value: 'a' }, { action: 'click', selector: '#off', timeout: 800 }, { action: 'press', value: 'b' }],
  });
  assert.ok(stopped.isError);
  assert.equal(stopped.data.steps.length, 1, 'выполненное до ошибки возвращается');
  assert.equal(stopped.data.failed.i, 1);
  assert.match(stopped.data.failed.error, /неактивен/);
  await call('browser_close', { sessionId });
});

test('таймаут клика называет причину первой строкой', options, async () => {
  const { sessionId } = await call('browser_open', { url: page });
  const disabled = await raw('browser_act', { sessionId, action: 'click', selector: '#off', timeout: 800 });
  assert.match(disabled.text.split('\n')[0], /неактивен \(disabled\)/);

  const covered = await raw('browser_act', { sessionId, action: 'click', selector: '#under', timeout: 800 });
  assert.match(covered.text.split('\n')[0], /перекрыт: события забирает <div id="cover">/);

  const missing = await raw('browser_act', { sessionId, action: 'click', selector: '#nope', timeout: 800 });
  assert.match(missing.text.split('\n')[0], /селектор ничего не нашёл/);
  await call('browser_close', { sessionId });
});
