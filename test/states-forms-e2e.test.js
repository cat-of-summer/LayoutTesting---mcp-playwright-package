/**
 * Состояния страницы и формы — через настоящие инструменты, по JSON-RPC.
 *
 * Три бага одной сдачи, которые стенд не видел: шапка при открытом меню уезжала на 60px,
 * крестик модалки 15×15 не попадал в аудит, потому что модалка была закрыта, а ошибки форм
 * жили между пустой и полной отправкой. Фикстуры воспроизводят каждый механизм.
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

const FIXTURES = path.join(path.resolve(import.meta.dirname, '..'), 'fixtures');

let client;
let closeAll;
let server;
let base;
let sessionId;

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
  ({ closeAll } = await import('../src/browser/pool.js'));

  server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
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
  base = `http://127.0.0.1:${server.address().port}`;

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = await createServer();
  await mcp.connect(serverSide);
  client = new Client({ name: 'states-forms-e2e', version: '1' });
  await client.connect(clientSide);
  ({ sessionId } = await call('browser_open', { viewport: '1440x900', keepAlive: true }));
});

test.after(async () => {
  if (closeAll) await closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('browser_act с anchors: кнопка шапки уехала на 60px, это видно в ответе', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/menu-states.html` });
  const res = await call('browser_act', {
    sessionId,
    action: 'click',
    selector: '.hbar__burger',
    anchors: ['.hbar__burger', '.hbar__logo', 'main p'],
  });
  const moved = Object.fromEntries(res.anchors.moved.map((item) => [item.selector, item]));
  assert.equal(moved['.hbar__burger'].dx, -60, JSON.stringify(res.anchors));
  assert.equal(moved['.hbar__logo'].dx, 60);
  assert.equal(res.anchors.stable, 1, 'текст страницы не двигался');
});

test('layout_audit со states видит крестик модалки 15×15, страница возвращается', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/menu-states.html` });
  const res = await call('layout_audit', {
    sessionId,
    categories: ['tinyTargets'],
    states: [{ name: 'modal', steps: [{ action: 'click', selector: '#open-modal' }] }],
  });
  const closeIn = (report) => report.issues.tinyTargets.some((item) => /modal__close/.test(item.selector));
  assert.equal(closeIn(res.base), false, 'в закрытой модалке крестика не видно');
  assert.equal(closeIn(res.states.modal), true, JSON.stringify(res.states.modal.issues));
  const open = await call('browser_eval', { sessionId, expression: "document.body.classList.contains('modal-open')" });
  assert.equal(open.value, false, 'после аудита страница перезагружена');
});

test('form_audit ловит маску без input, дёрганье ошибки и наложение', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/form-errors.html` });
  const res = await call('form_audit', { sessionId });
  const [feedback, subscribe] = res.forms;
  const kinds = (form) => form.issues.map((issue) => `${issue.step}:${issue.kind}:${issue.selector ?? ''}`);

  assert.ok(
    kinds(feedback).some((k) => /^fix:errorStays:.*phone/.test(k)),
    `маска гасит beforeinput — ошибка телефона должна остаться: ${kinds(feedback)}`,
  );
  assert.ok(feedback.issues.some((issue) => issue.kind === 'jitter'), `ошибка чекбокса дёргается: ${kinds(feedback)}`);
  assert.ok(
    subscribe.issues.some((issue) => issue.kind === 'layout' && issue.counts.overlaps),
    `ошибка email наезжает на подпись: ${JSON.stringify(subscribe.issues)}`,
  );
  assert.equal(subscribe.sent.length, 1, 'годная подписка ушла одним запросом');
  assert.equal(res.submit, 'intercept');
  assert.ok(feedback.steps.every((step) => step.screenshot), 'у каждого шага скриншот');
});

test('form_audit: форма, спрятанная или сброшенная после успеха, — успех, а не пачка ошибок', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/form-success.html` });
  const res = await call('form_audit', { sessionId });
  const [request, subscribe] = res.forms;
  const validIssues = (form) => form.issues.filter((issue) => issue.step === 'valid');

  assert.equal(request.success?.kind, 'hidden', JSON.stringify(request.steps.at(-1)));
  assert.match(request.success.message, /Спасибо/);
  assert.deepEqual(validIssues(request), [], JSON.stringify(validIssues(request)));
  assert.equal(request.steps.at(-1).screenshot, undefined, 'спрятанную форму не снять — ссылки на пустой файл нет');

  assert.equal(subscribe.success?.kind, 'reset', JSON.stringify(subscribe.steps.at(-1)));
  assert.match(subscribe.success.message, /подписаны/);
  assert.deepEqual(validIssues(subscribe), [], JSON.stringify(validIssues(subscribe)));
});
