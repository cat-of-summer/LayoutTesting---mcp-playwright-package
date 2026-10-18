/**
 * Четвёртый отзыв на настоящих инструментах, по JSON-RPC: состояния на нескольких ширинах,
 * перебор группы, готовность страницы. Фикстуры воспроизводят каждый механизм из отзыва.
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

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
    const name = path.basename(req.url.split('?')[0]);
    try {
      const body = await fs.readFile(path.join(FIXTURES, name));
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
  client = new Client({ name: 'feedback-4-e2e', version: '1' });
  await client.connect(clientSide);
  ({ sessionId } = await call('browser_open', { viewport: '1440x900', keepAlive: true }));
});

test.after(async () => {
  if (closeAll) await closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('layout_audit: состояние с мобильной кнопкой проверено на мобильных ширинах, на десктопе — skipped', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/states-widths.html` });
  const started = Date.now();
  const res = await call('layout_audit', {
    sessionId,
    widths: [375, 1440],
    states: [{ name: 'Фильтры', steps: [{ action: 'click', selector: '.filters-toggle' }, { action: 'wait', value: '200' }] }],
  });
  const state = res.states['Фильтры'];
  assert.deepEqual(state.applicable, [375]);
  assert.deepEqual(state.skippedOn, [1440]);
  assert.match(state.byWidth[1440].skipped, /не виден на 1440px/);
  assert.ok(state.byWidth[375].counts.overlaps >= 1, 'подпись наезжает на кнопку в открытой панели');
  assert.equal(state.error, undefined);
  assert.ok(Date.now() - started < 25_000, 'неприменимая ширина не ждёт полминуты');
});

test('layout_audit: each — по состоянию на каждый пин карты', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/states-widths.html` });
  const res = await call('layout_audit', { sessionId, states: [{ each: '[data-pin]' }] });
  const names = Object.keys(res.states);
  assert.deepEqual(names, ['[data-pin] [1] Байконур', '[data-pin] [2] Восточный']);
  for (const name of names) assert.equal(res.states[name].error, undefined, name);
});

test('page_ready без кадров: мёртвая кнопка и наложение в состоянии — блокеры, ready: false', options, async () => {
  const res = await call('page_ready', {
    url: `${base}/states-widths.html`,
    widths: [375, 1440],
    states: [{ name: 'Фильтры', steps: [{ action: 'click', selector: '.filters-toggle' }] }],
  });
  assert.equal(res.ready, false);
  assert.ok(res.blockers.some((b) => b.check === 'interaction_audit' && /\.dead/.test(b.where)), JSON.stringify(res.blockers));
  assert.ok(res.blockers.some((b) => b.check === 'layout_audit' && /Фильтры/.test(b.where)));
  assert.ok(res.blockers.every((b) => b.next?.tool), 'у каждого блокера готовый вызов');
  assert.match(res.framesNote, /Кадры не переданы/);
  assert.ok(res.ran.includes('interaction_audit') && res.ran.includes('layout_audit'));

  /* Второй вызов берёт свежие прогоны из журнала, а не гоняет заново. */
  const again = await call('page_ready', {
    url: `${base}/states-widths.html`,
    widths: [375, 1440],
    states: [{ name: 'Фильтры', steps: [{ action: 'click', selector: '.filters-toggle' }] }],
  });
  assert.deepEqual(again.ran, []);
  assert.equal(again.reused.length, 2);
});

test('interaction_audit hover: краска SVG-потомка — «ответил стилем», правило без изменения — мёртвый ховер, шапка не в счёт', options, async () => {
  const { sessionId: live } = await call('browser_open', { viewport: '1280x800', animations: 'allow' });
  try {
    await call('browser_goto', { sessionId: live, url: `${base}/hover-styles.html`, animations: 'allow' });
    const res = await call('interaction_audit', { sessionId: live, selectors: ['.svc', '.tech', '.plain'], actions: ['hover'] });
    const [svc, tech, plain] = res.targets;
    assert.equal(svc.verdict, 'ответил стилем', JSON.stringify(svc));
    assert.ok(svc.styles.some((s) => s.prop === 'fill' && /path/.test(s.node)), JSON.stringify(svc.styles));
    assert.equal(tech.verdict, 'ховер без видимого изменения', JSON.stringify(tech));
    assert.deepEqual(res.hoverInvisible, [`${tech.selector} (hover)`]);
    assert.equal(plain.verdict, 'молчит', JSON.stringify(plain));
    assert.deepEqual(res.hoverNone.selectors, [plain.selector]);
    assert.deepEqual(res.silent, [], 'наведение без ответа — не мёртвая кнопка');
  } finally {
    await call('browser_close', { sessionId: live });
  }
});

test('layout_audit: подпись, вылезшая из figure под картинку следующей строки, — coveredText; текст над прозрачной частью PNG — не находка', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/caption-overlap.html` });
  const res = await call('layout_audit', { sessionId, categories: ['coveredText', 'textOverImage'] });
  const covered = res.issues.coveredText.filter((item) => item.reason === 'вышел за контейнер');
  assert.ok(covered.some((item) => /\[1\]/.test(item.text)), JSON.stringify(res.issues.coveredText));
  assert.ok(covered.every((item) => /figure/.test(item.container)));
  const overImage = res.issues.textOverImage;
  assert.ok(overImage.some((item) => /нарисованной части/.test(item.text) && item.ink > 0.5), JSON.stringify(overImage));
  assert.ok(!overImage.some((item) => /прозрачной частью/.test(item.text)), 'над прозрачным полем PNG чернил нет');
});

test('lint_css с sessionId: переменная, которой у библиотеки нет, и переменная состояния, оставшаяся по умолчанию', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/library-vars.html` });
  const res = await call('lint_css', { sessionId });
  assert.equal(res.sheets, 2);
  assert.ok(res.unusedCustomProperty.some((item) => item.name === '--lib-color-selected' && item.didYouMean), JSON.stringify(res));
  assert.deepEqual(res.libraryDefault.map((item) => item.name), ['--lib-cell-background-color-in-range']);
  assert.equal(res.counts.stateColorOffPalette, undefined, 'без figma палитру не проверяем');
});
