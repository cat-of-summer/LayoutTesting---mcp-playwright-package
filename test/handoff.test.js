/**
 * Передача вкладки стенда человеку: страница проверки, ввод, завершение.
 *
 * Браузер не поднимается: вкладка подменена объектом с теми методами Playwright, которые
 * передача трогает. Проверяется то, что делает её безопасной: токен в адресе, закрытие после
 * успеха, переходы только на разрешённые домены.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { applyInput, closeHandoff, handleHandoffRoute, handoffStatus, openHandoff } from '../src/browser/handoff.js';

function fakePage() {
  const log = [];
  return {
    log,
    done: false,
    closed: false,
    isClosed() {
      return this.closed;
    },
    url: () => 'https://www.figma.com/login',
    viewportSize: () => ({ width: 1600, height: 1000 }),
    screenshot: async () => Buffer.from('jpeg'),
    goto: async (url) => log.push(['goto', url]),
    mouse: {
      click: async (x, y) => log.push(['click', x, y]),
      move: async (x, y) => log.push(['move', x, y]),
      down: async () => log.push(['down']),
      up: async () => log.push(['up']),
      wheel: async (dx, dy) => log.push(['wheel', dy]),
    },
    keyboard: {
      type: async (text) => log.push(['type', text]),
      press: async (key) => log.push(['press', key]),
    },
  };
}

function call(pathname, { method = 'GET', body = null } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(code, headers) {
        this.code = code;
        this.headers = headers;
        this.headersSent = true;
      },
      end(payload) {
        resolve({ code: this.code, headers: this.headers, body: String(payload ?? '') });
      },
    };
    handleHandoffRoute(req, res, new URL(`http://stand${pathname}`));
  });
}

test('передача: страница по токену, ввод доходит до вкладки, чужой токен — 404', async () => {
  const page = fakePage();
  const opened = openHandoff({ page, purpose: 't1', reason: 'Капча.', isDone: async () => false });
  const token = new URL(opened.url).pathname.split('/').pop();
  assert.ok(token.length >= 30, 'токен в адресе должен быть неугадываемым');
  assert.equal(opened.state, 'open');

  const html = await call(`/handoff/${token}`);
  assert.equal(html.code, 200);
  assert.match(html.body, /Капча\./);

  const frame = await call(`/handoff/${token}/frame`);
  assert.equal(frame.code, 200);
  assert.equal(frame.headers['X-Viewport'], '1600x1000');

  assert.equal((await call(`/handoff/${token}/input`, { method: 'POST', body: { type: 'click', x: 10, y: 20 } })).code, 200);
  assert.equal((await call(`/handoff/${token}/input`, { method: 'POST', body: { type: 'type', text: '123456' } })).code, 200);
  assert.deepEqual(page.log.slice(0, 2), [['click', 10, 20], ['type', '123456']]);

  assert.equal((await call(`/handoff/${'x'.repeat(32)}`)).code, 404);
  closeHandoff('t1');
  assert.equal((await call(`/handoff/${token}/input`, { method: 'POST', body: { type: 'click', x: 1, y: 1 } })).code, 409, 'закрытая передача ввода не принимает');
});

test('переход — только https и только на разрешённый домен; неизвестные клавиши не проходят', async () => {
  const page = fakePage();
  const item = { page, allowHosts: ['figma.com'] };
  await applyInput(item, { type: 'goto', url: 'https://www.figma.com/verify?token=abc' });
  assert.deepEqual(page.log.at(-1), ['goto', 'https://www.figma.com/verify?token=abc']);
  await assert.rejects(applyInput(item, { type: 'goto', url: 'https://evil.example/figma.com' }), /разрешён только/);
  await assert.rejects(applyInput(item, { type: 'goto', url: 'http://www.figma.com/' }), /разрешён только/);
  await assert.rejects(applyInput(item, { type: 'goto', url: 'https://notfigma.com/' }), /разрешён только/);
  await assert.rejects(applyInput(item, { type: 'key', key: 'F12' }), /не передаётся/);
  await applyInput(item, { type: 'drag', from: { x: 1, y: 2 }, to: { x: 100, y: 2 } });
  assert.deepEqual(page.log.slice(-4, -2), [['move', 1, 2], ['down']]);
});

test('пройденная проверка закрывает передачу и зовёт onDone', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const page = fakePage();
  let finished = 0;
  openHandoff({
    page,
    purpose: 't3',
    isDone: async (tab) => tab.done,
    onDone: async () => {
      finished += 1;
    },
  });
  t.mock.timers.tick(1600);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handoffStatus('t3').state, 'open');
  page.done = true;
  t.mock.timers.tick(1600);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, 1);
  assert.equal(handoffStatus('t3').state, 'done');
});

test('вторая проверка того же назначения заменяет первую', () => {
  const first = openHandoff({ page: fakePage(), purpose: 't4', isDone: async () => false });
  const second = openHandoff({ page: fakePage(), purpose: 't4', isDone: async () => false });
  assert.notEqual(first.url, second.url);
  assert.equal(handoffStatus('t4').url, second.url);
  closeHandoff('t4');
});
