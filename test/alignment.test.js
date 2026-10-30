/**
 * Выпадение из ряда (src/checks/alignment.js). Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Фикстуры alignment-*.html самоописывающиеся: выпадающий элемент несёт data-expect с видом
 * находки. Сверка точная в обе стороны: заявленное должно находиться, а лишнего быть не должно —
 * проверка подсказывает агенту, куда смотреть глазами, и каждая ложная подсказка тратит его время.
 * alignment-quiet.html — расхождения размеров по замыслу: там находок ноль.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

let pool;
let alignmentAudit;
let server;
let base;

async function startServer() {
  const srv = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
      const body = await fs.readFile(path.join(FIXTURES, path.basename(url)));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return srv;
}

/**
 * Разбор фикстуры и сверка с data-expect: wrong — находки не там или не того вида,
 * missing — заявленное, но не найденное.
 */
async function check(file, { viewport = 'desktop', ...opts } = {}) {
  const session = await pool.createSession({ viewport });
  try {
    await pool.gotoAndSettle(session, `${base}/${file}`);
    const report = await alignmentAudit(session.page, opts);
    const { wrong, missing } = await session.page.evaluate(
      ({ findings, fixed }) => {
        const hit = new Set();
        const wrong = [];
        for (const f of findings) {
          const el = document.querySelector(f.selector);
          if (!el || fixed || el.dataset.expect !== f.kind) wrong.push(`${f.kind} ${f.selector}`);
          else hit.add(el);
        }
        const missing = fixed ? [] : [...document.querySelectorAll('[data-expect]')].filter((el) => !hit.has(el)).map((el) => `${el.dataset.expect} ${el.className}`);
        return { wrong, missing };
      },
      { findings: report.findings, fixed: file.includes('?fixed') },
    );
    return { report, wrong, missing };
  } finally {
    await pool.closeSession(session.id);
  }
}

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ alignmentAudit } = await import('../src/checks/alignment.js'));
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

const CASES = [
  ['alignment-props.html', 'ряд свойств: четвёртый Box короче при align-items: flex-start', { rowHeight: 1 }],
  ['alignment-grid.html', 'сетка: ячейка с align-self: start короче соседей по ряду', { rowHeight: 1 }],
  ['alignment-cards.html', 'карточки: кнопка третьей не прижата к низу', { innerAlign: 1 }],
  ['alignment-form.html', 'кромки: поле на 4px правее колонки, плитка на 3px ниже ряда', { nearMiss: 2 }],
  ['alignment-pair.html', 'пара карточек разной высоты — слабая подсказка', { unevenPair: 1 }],
];

for (const [file, title, counts] of CASES) {
  test(`${title}`, options, async () => {
    const { report, wrong, missing } = await check(file);
    assert.deepEqual(wrong, [], 'лишние находки');
    assert.deepEqual(missing, [], 'не найдено заявленное');
    for (const [kind, n] of Object.entries(counts)) assert.equal(report.counts[kind], n, kind);
    assert.equal(report.total, report.findings.length);
  });
}

test('находка несёт линию, соседей на ней, группу и подсказку', options, async () => {
  const { report } = await check('alignment-props.html');
  const [f] = report.findings;
  assert.equal(f.kind, 'rowHeight');
  assert.equal(f.line.on, 3);
  assert.equal(f.line.of, 4);
  assert.equal(f.line.neighbors.length, 3);
  assert.equal(f.group.signature, 'div.Box');
  assert.ok(f.delta < 0, 'блок короче — низ выше линии');
  assert.match(f.hint, /align-items/);
  assert.equal(f.weak, undefined);
});

test('пара помечена слабой', options, async () => {
  const { report } = await check('alignment-pair.html');
  assert.equal(report.findings[0].weak, true);
});

test('тот же ряд с align-items: stretch молчит', options, async () => {
  const { report, wrong } = await check('alignment-props.html?fixed');
  assert.deepEqual(wrong, []);
  assert.equal(report.total, 0);
});

for (const viewport of ['desktop', 'mobile']) {
  test(`расхождения по замыслу не дают находок (${viewport})`, options, async () => {
    const { report, wrong } = await check('alignment-quiet.html', { viewport });
    assert.deepEqual(wrong, []);
    assert.equal(report.total, 0);
    /* Пустой отчёт должен быть пустым по разбору, а не потому, что групп не нашлось. */
    assert.ok(report.checked.rows >= 15, `рядов разобрано: ${report.checked.rows}`);
  });
}

test('на чистой фикстуре стенда находок нет', options, async () => {
  const { report } = await check('clean.html');
  assert.equal(report.total, 0);
});

test('на узкой ширине находка та же или её нет, но не ложная', options, async () => {
  for (const file of CASES.map(([name]) => name)) {
    const { wrong } = await check(file, { viewport: 'mobile' });
    assert.deepEqual(wrong, [], file);
  }
});

test('include и exclude сужают разбор', options, async () => {
  const only = await check('alignment-form.html', { include: ['#tiles'] });
  assert.deepEqual(only.report.findings.map((f) => f.selector), ['#tiles > div.tile:nth-of-type(2)']);
  const without = await check('alignment-form.html', { exclude: ['#tiles'] });
  assert.deepEqual(without.report.findings.map((f) => f.selector), ['#fields > div.field:nth-of-type(3)']);
});

// ---------------------------------------------------------------------------
// Встраивание: подсказки идут рядом с находками, но не в total, вердикт и блокеры.
// ---------------------------------------------------------------------------

test('layout_audit несёт alignment отдельным полем, total не меняется', options, async () => {
  const { layoutAudit } = await import('../src/checks/layout.js');
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/alignment-props.html`);
    const full = await layoutAudit(session.page);
    const bare = await layoutAudit(session.page, { alignment: false });
    assert.equal(full.alignment.total, 1);
    assert.deepEqual(full.alignment.counts, { rowHeight: 1 });
    assert.match(full.alignment.note, /не дефекты/);
    assert.equal(full.total, bare.total, 'подсказки не входят в total');
    assert.equal(full.counts.alignment, undefined, 'и в счётчики категорий');
    assert.equal(bare.alignment, undefined);
    /* Узкий прогон по своим категориям за выравнивание не платит; попросили явно — получает. */
    assert.equal((await layoutAudit(session.page, { categories: ['overlaps'] })).alignment, undefined);
    assert.equal((await layoutAudit(session.page, { categories: ['alignment'] })).alignment.total, 1);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('сводка по ширинам: alignment там, где ряд рваный, и пояснение в note', options, async () => {
  const { layoutAuditAcrossWidths } = await import('../src/checks/layout.js');
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/alignment-props.html`);
    const result = await layoutAuditAcrossWidths(session.page, [375, 1280]);
    assert.equal(result.byWidth[1280].alignment.total, 1);
    assert.equal(result.byWidth[1280].alignment.top[0].kind, 'rowHeight');
    assert.equal(result.byWidth[375].alignment, undefined, 'на телефоне ряд переносится — выпадать не из чего');
    assert.match(result.note, /alignment/);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('сводка audit: подсказки в alignmentHints и lookAt, вердикт и clean не трогают', async () => {
  const { summarize } = await import('../src/audit.js');
  const s = summarize({ layout: { total: 0, counts: {}, issues: {}, alignment: { total: 2, findings: [] } } });
  assert.equal(s.alignmentHints, 2);
  assert.equal(s.clean, true);
  assert.equal(s.verdict, 'проблем не найдено');
  assert.match(s.lookAt, /выпадение из ряда: 2/);
  assert.equal(summarize({ layout: { total: 0, counts: {}, alignment: { total: 0 } } }).lookAt, undefined);
});

test('page_ready: подсказки собираются из любой формы ответа и не становятся блокерами', async () => {
  const { alignmentHints, layoutBlockers } = await import('../src/checks/ready.js');
  const hint = { kind: 'rowHeight', selector: '.Box:nth-of-type(4)', edge: 'низ', delta: -26 };
  const summary = { total: 0, counts: {}, top: [], alignment: { total: 1, top: [hint] } };
  const result = {
    base: { byWidth: { 1024: summary, 1440: summary } },
    states: { меню: { byWidth: { 1440: { ...summary, alignment: { total: 1, top: [{ ...hint, selector: '.menu a' }] } } } } },
  };
  const hints = alignmentHints(result);
  assert.equal(hints.length, 2);
  assert.deepEqual(hints[0].where, ['страница, 1024px', 'страница, 1440px'], 'один элемент на двух ширинах — одна запись');
  assert.deepEqual(hints[1].where, ['состояние «меню», 1440px']);
  assert.deepEqual(layoutBlockers(result), []);
  /* Отчёт одной ширины — полный, с findings вместо top. */
  assert.equal(alignmentHints({ total: 0, counts: {}, alignment: { total: 1, findings: [hint] } })[0].where[0], 'страница');
  assert.deepEqual(alignmentHints({ total: 0, counts: {} }), []);
});
