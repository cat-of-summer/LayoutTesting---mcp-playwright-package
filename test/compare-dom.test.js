/**
 * Сравнение вёрстки по DOM. Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Проверяемое свойство одно и главное: результат не должен зависеть от контента.
 * Страницы с разными текстами и картинками, но одинаковой вёрсткой обязаны сходиться,
 * а подмена одного значения в CSS — всплывать поимённо.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

let pool;
let compareLayout;
let server;
let base;

const CSS = `body{margin:0;font:16px/1.5 system-ui}
  .card{width:300px;padding:20px;background:#eef}
  .card__title{font-size:24px;line-height:30px;color:rgb(20,20,20)}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:24px}`;

const page = (css, body) => `<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`;

/** Разметка одна, контент разный — вёрстка обязана считаться совпавшей. */
const SHORT = '<div class="grid"><article class="card"><h3 class="card__title">Раз</h3></article></div>';
const LONG =
  '<div class="grid"><article class="card"><h3 class="card__title">' +
  'Совсем другой и заметно более длинный заголовок карточки' +
  '</h3></article><article class="card"><h3 class="card__title">Ещё одна</h3></article></div>';

const PAGES = {
  '/base.html': page(CSS, SHORT),
  // Тот же CSS, другой контент.
  '/other-content.html': page(CSS, LONG),
  // Тот же контент, подменён один размер шрифта.
  '/other-font.html': page(CSS.replace('font-size:24px', 'font-size:20px'), SHORT),
  // Тот же контент, изменён зазор сетки.
  '/other-gap.html': page(CSS.replace('gap:24px', 'gap:8px'), SHORT),
  // Блок вёрстки потерян.
  '/missing-block.html': page(CSS, '<div class="grid"><article class="card"></article></div>'),
  // Появился лишний блок.
  '/extra-block.html': page(CSS, `${SHORT}<div class="promo">лишний блок</div>`),
};

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ compareLayout } = await import('../src/checks/compare-dom.js'));

  server = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

const cmp = (aPath, bPath, extra = {}) =>
  compareLayout({ pool, a: { url: `${base}${aPath}` }, b: { url: `${base}${bPath}` }, ...extra });

test('одинаковая вёрстка с разным контентом считается совпавшей', options, async () => {
  const res = await cmp('/base.html', '/other-content.html');

  // Ровно то, чего не умеет попиксельное сравнение: длина текста не должна влиять.
  assert.deepEqual(res.classes.onlyInA, [], 'ни один блок вёрстки не потерян');
  assert.deepEqual(res.classes.onlyInB, [], 'лишних блоков не появилось');
  const heightOnly = res.differences.every((d) => d.deltas.every((x) => x.what === 'height'));
  assert.ok(heightOnly, `расходиться может только высота от длины текста: ${JSON.stringify(res.differences)}`);
});

test('подменённый размер шрифта всплывает поимённо', options, async () => {
  const res = await cmp('/base.html', '/other-font.html');

  const title = res.differences.find((d) => d.class === 'card__title');
  assert.ok(title, 'блок с расхождением обязан быть назван');

  const font = title.deltas.find((d) => d.what === 'font-size');
  assert.ok(font, `ожидали расхождение по font-size, получили ${JSON.stringify(title.deltas)}`);
  assert.equal(font.a, '24px');
  assert.equal(font.b, '20px');
  assert.equal(res.clean, false);
});

test('изменённый зазор сетки виден как расхождение gap', options, async () => {
  const res = await cmp('/base.html', '/other-gap.html');

  const grid = res.differences.find((d) => d.class === 'grid');
  assert.ok(grid, 'сетка обязана попасть в расхождения');
  assert.ok(
    grid.deltas.some((d) => d.what === 'gap' && d.a.includes('24px') && d.b.includes('8px')),
    `ожидали gap 24px против 8px: ${JSON.stringify(grid.deltas)}`,
  );
});

test('потерянный блок вёрстки попадает в onlyInA', options, async () => {
  const res = await cmp('/base.html', '/missing-block.html');

  assert.ok(res.classes.onlyInA.includes('card__title'), 'заголовок карточки не доехал до страницы');
  assert.equal(res.classes.onlyInATotal, 1);
  assert.equal(res.clean, false);
});

test('лишний блок попадает в onlyInB и не путается с потерянным', options, async () => {
  const res = await cmp('/base.html', '/extra-block.html');

  assert.deepEqual(res.classes.onlyInA, [], 'слева ничего не потеряно');
  assert.ok(res.classes.onlyInB.includes('promo'), 'справа появился лишний блок');
});

test('страница, сравнённая сама с собой, чиста', options, async () => {
  const res = await cmp('/base.html', '/base.html');

  assert.equal(res.clean, true, `ожидали чистый результат: ${JSON.stringify(res.differences)}`);
  assert.equal(res.differencesTotal, 0);
  assert.ok(res.classes.shared > 0, 'общие классы обязаны быть найдены');
});

test('допуск по размеру настраивается', options, async () => {
  const strict = await cmp('/base.html', '/other-content.html', { tolerance: 0 });
  const loose = await cmp('/base.html', '/other-content.html', { tolerance: 10000 });

  assert.ok(
    loose.differencesTotal <= strict.differencesTotal,
    'с большим допуском расхождений не должно стать больше',
  );
});

test('служебные классы стенда в сравнение не попадают', options, async () => {
  const res = await cmp('/base.html', '/base.html');
  const all = [...res.classes.onlyInA, ...res.classes.onlyInB, ...res.differences.map((d) => d.class)];

  assert.ok(
    all.every((cls) => !cls.startsWith('js-') && !cls.startsWith('lt-')),
    'поведенческие и служебные классы к вёрстке отношения не имеют',
  );
});

test('без обоих адресов инструмент отказывается сразу', options, async () => {
  await assert.rejects(() => compareLayout({ pool, a: { url: `${base}/base.html` } }), /Нужны обе стороны/);
});
