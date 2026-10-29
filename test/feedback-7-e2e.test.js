/**
 * Седьмой отзыв на настоящем браузере: обход интерфейса Figma руками, когда канал редактора не
 * работал. Скачивания кнопкой «Скачать» (ссылка с blob и showSaveFilePicker), ожидание по
 * условию вместо паузы наугад, клик по видимой кнопке, когда первая по DOM скрыта, и режим
 * просмотра Figma, узнаваемый по кнопке «Ask to edit».
 *
 *   LT_BROWSER_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';

process.env.LT_UPDATE_CHECK = '0';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const PAGES = {
  '/downloads.html': `<!doctype html><meta charset="utf-8">
    <button id="blob" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['hello'],{type:'text/plain'}));a.download='привет.txt';a.click()">blob</button>
    <button id="pick" onclick="(async()=>{const h=await showSaveFilePicker({suggestedName:'frame.png'});const w=await h.createWritable();await w.write(new Blob([new Uint8Array([137,80,78,71])]));await w.write(new Uint8Array([1,2]));await w.close();document.title='saved'})()">pick</button>
    <button id="late" onclick="setTimeout(()=>{const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['late']));a.download='late.bin';a.click()},700)">late</button>`,
  '/buttons.html': `<!doctype html><meta charset="utf-8">
    <div style="display:none"><button onclick="document.title='hidden'">Ask to edit</button></div>
    <button onclick="document.title='visible'">Ask to edit</button>
    <button id="ghost" style="visibility:hidden;padding:20px"><span style="visibility:visible" onclick="document.title='ghost'">Ghost</span></button>
    <script>setTimeout(()=>{window.ready=true},600)</script>`,
};

let pool;
let server;
let base;
let client;
let sessionId;

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  server = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = await createServer();
  await mcp.connect(serverSide);
  client = new Client({ name: 'feedback-7-e2e', version: '1' });
  await client.connect(clientSide);
  ({ sessionId } = await call('browser_open', { viewport: '1280x800', keepAlive: true, browser: 'chromium' }));
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('скачивание по ссылке с blob ложится в артефакты и приходит в ответе действия', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/downloads.html` });
  const res = await call('browser_act', { sessionId, action: 'click', selector: '#blob' });
  assert.equal(res.downloads?.length, 1, JSON.stringify(res));
  const [file] = res.downloads;
  assert.equal(file.via, 'download');
  assert.equal(file.bytes, 5);
  assert.match(file.uri, /^lt:\/\/artifacts\/.+downloads.+привет\.txt$/);
  assert.equal(await fs.readFile(file.path, 'utf8'), 'hello');
});

test('showSaveFilePicker: записанное страницей приходит файлом, мимо CSP и окна выбора', options, async () => {
  const res = await call('browser_act', {
    sessionId,
    steps: [
      { action: 'click', selector: '#pick' },
      { action: 'wait', value: 'download', timeout: 5000 },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const [file] = res.downloads;
  assert.equal(file.via, 'showSaveFilePicker');
  assert.equal(file.name, 'frame.png');
  assert.deepEqual([...(await fs.readFile(file.path))], [137, 80, 78, 71, 1, 2]);
});

test('wait value: download дожидается скачивания, начатого с задержкой', options, async () => {
  const res = await call('browser_act', {
    sessionId,
    steps: [
      { action: 'click', selector: '#late' },
      { action: 'wait', value: 'download', timeout: 5000 },
    ],
  });
  assert.equal(res.steps[1].download, 'late.bin');
  assert.equal(res.downloads[0].name, 'late.bin');
});

test('wait с expression ждёт условия; невыполнимое — понятная ошибка, а не про селектор', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/buttons.html` });
  const ok = await call('browser_act', { sessionId, action: 'wait', expression: 'window.ready === true', timeout: 5000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.expression, 'window.ready === true');
  const body = await call('browser_act', { sessionId, action: 'wait', expression: 'return document.title !== null', timeout: 2000 });
  assert.equal(body.ok, true);
  await assert.rejects(
    call('browser_act', { sessionId, action: 'wait', expression: 'window.never === 1', timeout: 600 }),
    (err) => /не стало истинным за 600 мс/.test(err.message) && !/селектор/.test(err.message),
  );
});

test('клик по селектору берёт видимую кнопку, когда первая по DOM скрыта', options, async () => {
  await call('browser_act', { sessionId, action: 'click', selector: "button:has-text('Ask to edit')", timeout: 3000 });
  const title = await call('browser_eval', { sessionId, expression: 'document.title' });
  assert.equal(title.value, 'visible');
});

test('элемент «невидим» для Playwright, но на экране — клик по центру рамки с пометкой', options, async () => {
  const res = await call('browser_act', { sessionId, action: 'click', selector: '#ghost', timeout: 1500 });
  assert.equal(res.fallback, 'bbox', JSON.stringify(res));
  const title = await call('browser_eval', { sessionId, expression: 'document.title' });
  assert.equal(title.value, 'ghost');
});

test('fileOutcome: кнопка «Ask to edit» — режим просмотра, а не минута ожидания window.figma', options, async () => {
  const { fileOutcome } = await import('../src/figma/editor.js');
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await session.page.goto(`${base}/buttons.html`);
    const started = Date.now();
    assert.equal(await fileOutcome(session.page, 5000), 'view');
    assert.ok(Date.now() - started < 3000);
  } finally {
    await pool.closeSession(session.id);
  }
});
