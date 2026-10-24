/**
 * Шестой отзыв на настоящем браузере: вёрстка UI kit на Astro, где layout_audit отвечал нулями,
 * а человек видел наезжания. Подпись шире ужатой кнопки, наложение соседних контролов, шум
 * tinyTargets на флажках с подписью и ноль по недорисованной странице.
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

let pool;
let layoutAudit;
let server;
let base;
let client;
let sessionId;

/* Вызов инструмента: текст ответа разобран, остальные блоки — рядом. */
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  return { ...JSON.parse(text), _content: res.content };
}

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ layoutAudit } = await import('../src/checks/layout.js'));
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
  base = `http://127.0.0.1:${server.address().port}`;

  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = await createServer();
  await mcp.connect(serverSide);
  client = new Client({ name: 'feedback-6-e2e', version: '1' });
  await client.connect(clientSide);
  ({ sessionId } = await call('browser_open', { viewport: '1440x900', keepAlive: true }));
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function audit(file, opts = {}) {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/${file}`);
    return await layoutAudit(session.page, opts);
  } finally {
    await pool.closeSession(session.id);
  }
}

async function auditHtml(html, opts = {}) {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await session.page.setContent(html);
    return await layoutAudit(session.page, opts);
  } finally {
    await pool.closeSession(session.id);
  }
}

test('contentOverflow: подпись шире ужатой кнопки найдена, сосед под вылетом назван', options, async () => {
  const res = await audit('control-overflow.html', { categories: ['contentOverflow'] });
  const spill = res.issues.contentOverflow.find((item) => item.control === '#spill');
  assert.ok(spill, JSON.stringify(res.issues.contentOverflow));
  assert.ok(spill.overflowPx.right > 60, `подпись 80px в кнопке 28px: ${JSON.stringify(spill.overflowPx)}`);
  assert.match(spill.overNeighbour, /#victim/);
  assert.equal(res.counts.contentOverflow, 1, JSON.stringify(res.counts));

  /* Голый текст в прозрачной кнопке вылезает в пустое поле: виден, но не в total. */
  const bare = res.issues.contentOverflow.find((item) => item.selector === '#bare-btn');
  assert.ok(bare, 'текст прямо в кнопке без рамки');
  assert.equal(bare.overNeighbour, false);
  assert.equal(res.counts.contentOverflowFree, 1);
  assert.equal(res.issues.contentOverflow.at(-1), bare, 'вылет в пустоту — после вылетов поверх соседа');
});

test('contentOverflow: ряд сетки с отрицательным margin и бейдж ниже строки — не находка', options, async () => {
  const res = await auditHtml(
    `<!doctype html><style>body{margin:0;padding:24px;font:14px/20px sans-serif}
      .container{width:400px}.row{display:flex;margin:0 -15px}.col{flex:1;padding:0 15px}
      .badge{display:inline-block;height:16px;line-height:20px;padding:0 4px;font-size:12px}</style>
     <div class="container"><div class="row"><div class="col">Один</div><div class="col">Два</div></div></div>
     <p><span class="badge">Новое</span> рядом текст</p>`,
    { categories: ['contentOverflow'] },
  );
  assert.equal(res.issues.contentOverflow.length, 0, JSON.stringify(res.issues.contentOverflow));
});

test('controlOverlaps: наложение соседних контролов найдено, намеренные наложения — нет', options, async () => {
  const res = await audit('control-overflow.html', { categories: ['controlOverlaps'] });
  const found = res.issues.controlOverlaps;
  assert.equal(found.length, 1, JSON.stringify(found));
  const selectors = [found[0].a.selector, found[0].b.selector].join(' ');
  assert.match(selectors, /#victim/);
  assert.match(selectors, /#spill/);
  /* Иконка в поле, ToggleSwitch, меню поверх кнопки, стопка аватаров — не находки. */
  assert.doesNotMatch(JSON.stringify(found), /FormControl|ToggleSwitch|menu|avatars/);
});

test('controlOverlaps: кнопки position: relative внахлёст находятся, overlapIgnore их снимает', options, async () => {
  const html = `<!doctype html><style>body{margin:0;padding:24px}
    .bar button{position:relative;width:120px;height:32px}
    .bar button + button{margin-left:-40px}</style>
    <div class="bar"><button>Сохранить</button><button>Отмена</button></div>`;
  const res = await auditHtml(html, { categories: ['controlOverlaps', 'overlaps'] });
  assert.equal(res.counts.overlaps, 0, 'overlaps такие кнопки не видит — для того и новая категория');
  /* Отрицательный margin в 40px при перекрытии в 40px — стопка, а не дефект. Сдвинем дальше. */
  assert.equal(res.counts.controlOverlaps, 0, 'перекрытие ровно на отрицательный margin — замысел');

  const shifted = html.replace('margin-left:-40px', 'margin-left:0;left:-40px');
  const hit = await auditHtml(shifted, { categories: ['controlOverlaps'] });
  assert.equal(hit.counts.controlOverlaps, 1, JSON.stringify(hit.issues.controlOverlaps));
  /* 40px сдвига минус пробел между inline-block кнопками. */
  const { w } = hit.issues.controlOverlaps[0].overlapPx;
  assert.ok(w >= 30 && w <= 40, JSON.stringify(hit.issues.controlOverlaps[0]));

  const ignored = await auditHtml(shifted, { categories: ['controlOverlaps'], overlapIgnore: ['.bar'] });
  assert.equal(ignored.counts.controlOverlaps, 0);
});

test('tinyTargets: флажки с подписью и редкие мелкие цели — исключения WCAG, плотные иконки — находка', options, async () => {
  const res = await audit('control-overflow.html', { categories: ['tinyTargets'] });
  const selectors = res.issues.tinyTargets.map((item) => item.selector);
  assert.ok(!selectors.some((s) => /checks/.test(s)), `флажки с подписью: ${selectors.join(', ')}`);
  assert.ok(selectors.some((s) => /#icons > button:nth-of-type\(1\)/.test(s)), 'иконки 16px вплотную остаются');
  const icon = res.issues.tinyTargets.find((item) => /#icons > button:nth-of-type\(1\)/.test(item.selector));
  assert.match(icon.tooClose, /#icons > button:nth-of-type\(2\)/);
  assert.ok(res.counts.tinyTargetsExempt >= 3, JSON.stringify(res.counts));
  assert.ok(res.exempt.tinyTargets.spacing + res.exempt.tinyTargets.label >= 3, JSON.stringify(res.exempt));

  const total = Object.entries(res.counts)
    .filter(([key]) => !['boxOverflowClipped', 'contentOverflowFree', 'tinyTargetsExempt'].includes(key))
    .reduce((sum, [, value]) => sum + value, 0);
  assert.equal(res.total, total, 'исключённые в total не входят');
});

test('tinyTargets: ссылка в строке текста — Inline, крупная подпись — Label', options, async () => {
  const res = await auditHtml(
    `<!doctype html><style>body{margin:0;padding:24px;font:12px/16px sans-serif}
      label.big{display:inline-flex;align-items:center;height:32px;padding:0 8px}
      input{width:14px;height:14px;margin:0}</style>
     <p>Читайте <a href="#a">правила</a> и <a href="#b">условия</a> перед отправкой формы.</p>
     <label class="big"><input type="checkbox"> Согласен</label>`,
    { categories: ['tinyTargets'] },
  );
  assert.equal(res.counts.tinyTargets, 0, JSON.stringify(res.issues.tinyTargets));
  assert.equal(res.exempt.tinyTargets.inline, 2, JSON.stringify(res.exempt));
  assert.equal(res.exempt.tinyTargets.label, 1, JSON.stringify(res.exempt));
});

test('checked и warning: ноль по пустой странице не выдаёт себя за чистый отчёт', options, async () => {
  const empty = await auditHtml('<!doctype html><body></body>');
  assert.equal(empty.total, 0);
  assert.equal(empty.checked.visible, 0);
  assert.match(empty.warning, /видимых узлов всего 0/);

  const full = await audit('clean.html');
  assert.equal(full.total, 0);
  assert.ok(full.checked.visible >= 5, JSON.stringify(full.checked));
  assert.equal(full.warning, undefined);
  assert.equal(full.pageState.readyState, 'complete');
});

test('screenshot tiles: длинная страница кусками в натуральную ширину, download и путь в ответе', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/control-overflow.html` });
  const page = pool.getSession(sessionId).page;
  await page.evaluate(() => {
    document.body.style.minHeight = '3400px';
  });
  const shot = await call('screenshot', { sessionId, tiles: true });
  assert.equal(shot.width, 1440);
  assert.ok(shot.tiles.length >= 4, JSON.stringify(shot.tiles));
  assert.match(shot.download, /^curl -fsSL -o \S+\.png http/);
  const images = shot._content.filter((c) => c.type === 'image');
  assert.equal(images.length, shot.tiles.length, 'по картинке на кусок, уменьшенной копии нет');
  const sharp = (await import('sharp')).default;
  const meta = await sharp(Buffer.from(images[0].data, 'base64')).metadata();
  assert.equal(meta.width, 1440, 'кусок в натуральную ширину');
  assert.ok(meta.width * meta.height <= 1_150_000);
  assert.ok(shot._content.some((c) => c.type === 'text' && /^Кусок 1 из/.test(c.text)));
});

test('browser_act steps: шаг screenshot с clip снимает фрагмент, key подсказывает press', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/control-overflow.html` });
  const res = await call('browser_act', { sessionId, steps: [{ action: 'screenshot', name: 'clip', clip: { x: 0, y: 0, width: 200, height: 100 } }] });
  assert.equal(res.steps[0].width, 200);
  assert.equal(res.steps[0].height, 100);
  assert.match(res.steps[0].download, /^curl /);
  await assert.rejects(call('browser_act', { sessionId, steps: [{ action: 'key', value: 'Escape' }] }), /возможно, вы имели в виду press/);
});

test('browser_eval: скрипт по имени живёт в новой сессии, urls — ответ по каждой странице', options, async () => {
  const name = `count-buttons-${process.pid}`;
  try {
    await call('browser_goto', { sessionId, url: `${base}/control-overflow.html` });
    const first = await call('browser_eval', { sessionId, name, expression: 'document.querySelectorAll("button").length' });
    assert.equal(first.saved, true);
    assert.ok(first.value > 3);

    const other = await call('browser_open', { viewport: '375x800' });
    try {
      await call('browser_goto', { sessionId: other.sessionId, url: `${base}/clean.html` });
      const again = await call('browser_eval', { sessionId: other.sessionId, name });
      assert.equal(again.script, name);
      assert.equal(typeof again.value, 'number');
    } finally {
      await call('browser_close', { sessionId: other.sessionId });
    }

    const many = await call('browser_eval', { sessionId, name, urls: [`${base}/control-overflow.html`, `${base}/clean.html`, 'http://127.0.0.1:9/'] });
    assert.equal(many.pages.length, 3);
    assert.ok(many.pages[0].value > many.pages[1].value, JSON.stringify(many.pages));
    assert.ok(many.pages[2].error, 'недоступная страница — ошибка в своей строке, а не всего вызова');
    assert.ok((await call('browser_eval', { sessionId, action: 'list' })).scripts.some((item) => item.name === name));
  } finally {
    await call('browser_eval', { sessionId, action: 'remove', name });
  }
});

test('browser_goto после неудачного перехода не прерывается страницей ошибки Chrome', options, async () => {
  await assert.rejects(call('browser_goto', { sessionId, url: 'http://127.0.0.1:9/' }), /ERR_/);
  const ok = await call('browser_goto', { sessionId, url: `${base}/clean.html` });
  assert.equal(ok.status, 200);
});

test('layout_diff: правка отступа — что сдвинулось и какой стиль поменялся, с подсветкой', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/control-overflow.html` });
  const saved = await call('layout_diff', { sessionId, action: 'save', selector: '#intended' });
  assert.ok(saved.nodes > 5);

  const page = pool.getSession(sessionId).page;
  await page.evaluate(() => {
    document.querySelector('.FormControl').style.marginBottom = '24px';
  });
  const diff = await call('layout_diff', { sessionId, action: 'compare', highlight: true });
  assert.equal(diff.unchanged, false);
  assert.ok(diff.styles.some((item) => item.node === 'div.FormControl' && item.prop === 'margin'), JSON.stringify(diff.styles));
  assert.ok(diff.moved.some((item) => item.node === 'button.ToggleSwitch-track' && item.dy === 24), JSON.stringify(diff.moved));
  assert.ok(diff.moved.some((item) => item.node === ':root' && item.dh === 24));
  assert.ok(!diff.moved.some((item) => /ToggleSwitch-icons/.test(item.node)), 'иконки сдвинулись вместе с кнопкой');
  assert.ok(diff.highlight?.url && diff.highlight.marked >= 2, JSON.stringify(diff.highlight));
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-lt-diff]').length), 0, 'пометки сняты');

  const repeat = await call('layout_diff', { sessionId, action: 'compare', update: true });
  assert.equal(repeat.unchanged, false);
  const after = await call('layout_diff', { sessionId, action: 'compare' });
  assert.equal(after.unchanged, true, 'update положил новый снимок');
  await assert.rejects(call('layout_diff', { sessionId, action: 'compare', name: 'нет' }), /Снимка "нет" нет — есть: default/);
});

test('layout_audit через инструмент: новые категории и overlapIgnore', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/control-overflow.html` });
  const res = await call('layout_audit', { sessionId, categories: ['controlOverlaps', 'contentOverflow'] });
  assert.equal(res.counts.controlOverlaps, 1);
  assert.ok(res.checked.controls > 5);
  const ignored = await call('layout_audit', { sessionId, categories: ['controlOverlaps'], overlapIgnore: ['#table'] });
  assert.equal(ignored.counts.controlOverlaps, 0);
});
