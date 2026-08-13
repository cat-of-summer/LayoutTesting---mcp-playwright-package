/**
 * Сравнение двух живых страниц. Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Главное проверяемое свойство — сравнение не отменяется из-за разной высоты страниц.
 * У макета демо-контент, у собранной страницы боевой, и высоты почти никогда не совпадают;
 * если на этом останавливаться, инструмент бесполезен ровно в своём основном сценарии.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

let pool;
let comparePages;
let server;
let base;

/*
 * Три страницы: образец, его точная копия и заметно отличающаяся версия.
 *
 * Блоки намеренно выше любого пресета вьюпорта: у страницы короче экрана fullPage-кадр
 * всё равно выходит размером с экран, и разницу высот на такой фикстуре не поймать.
 */
const PAGES = {
  '/a.html': `<!doctype html><meta charset="utf-8"><style>body{margin:0}
    .b{height:1200px;background:#d6e4ff}</style><div class="b">одинаково</div>`,
  '/same.html': `<!doctype html><meta charset="utf-8"><style>body{margin:0}
    .b{height:1200px;background:#d6e4ff}</style><div class="b">одинаково</div>`,
  '/taller.html': `<!doctype html><meta charset="utf-8"><style>body{margin:0}
    .b{height:1200px;background:#d6e4ff}.extra{height:900px;background:#ffe8b3}</style>
    <div class="b">одинаково</div><div class="extra">лишний блок</div>`,
  '/different.html': `<!doctype html><meta charset="utf-8"><style>body{margin:0}
    .b{height:1200px;background:#ff5a4d}</style><div class="b">совсем другое</div>`,
};

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ comparePages } = await import('../src/checks/compare.js'));

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

const run = (aPath, bPath, extra = {}) =>
  comparePages({
    pool,
    runId: `test-compare-${aPath.replace(/\W/g, '')}-${bPath.replace(/\W/g, '')}`,
    name: 'pair',
    a: { url: `${base}${aPath}` },
    b: { url: `${base}${bPath}` },
    ...extra,
  });

test('одинаковые страницы сходятся', options, async () => {
  const res = await run('/a.html', '/same.html');

  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].diffPercentage, 0);
  assert.equal(res.clean, true);
});

test('разная высота не отменяет сравнение, а становится отдельным числом', options, async () => {
  const res = await run('/a.html', '/taller.html');
  const [cell] = res.results;

  assert.equal(cell.ok, true, 'сравнение обязано состояться, а не упереться в размеры');
  assert.equal(cell.size.cropped, true, 'кадры обрезаны до общей области');
  assert.ok(cell.size.heightDelta > 0, `у правой страницы блок длиннее: ${cell.size.heightDelta}`);
  assert.ok(cell.size.coverage < 1, `сравнили не всю длинную страницу: ${cell.size.coverage}`);
});

test('лишний блок внизу не выдаётся за расхождение вёрстки', options, async () => {
  const res = await run('/a.html', '/taller.html');
  const [cell] = res.results;

  /*
   * Верхняя часть у обеих страниц одинаковая, отличается только хвост. Раньше короткую
   * сторону добивали белым до высоты длинной и считали белизну расхождением — выходило
   * под 70% там, где общая область совпадает пиксель в пиксель. Теперь процент говорит
   * про сравненное, а про несравненное говорит coverage.
   */
  assert.equal(
    cell.diffPercentage,
    0,
    'на общей области страницы одинаковы — расхождению взяться неоткуда',
  );
  assert.ok(cell.size.heightDelta > 0, 'при этом факт разной длины обязан остаться виден');
});

test('непохожие страницы расходятся заметно', options, async () => {
  const res = await run('/a.html', '/different.html');

  assert.equal(res.clean, false);
  assert.ok(res.results[0].diffPercentage > 5, `ожидали заметное расхождение, вышло ${res.results[0].diffPercentage}%`);
  assert.ok(res.worst, 'худшая ширина должна быть названа');
});

test('сравнение идёт по каждой запрошенной ширине', options, async () => {
  const res = await run('/a.html', '/same.html', { viewports: ['mobile', 'desktop'] });

  assert.deepEqual(
    res.results.map((r) => r.viewport),
    ['mobile', 'desktop'],
  );
  assert.ok(res.results.every((r) => r.ok));
});

test('недоступная сторона не роняет весь прогон', options, async () => {
  const res = await comparePages({
    pool,
    runId: 'test-compare-missing',
    name: 'pair',
    a: { url: `${base}/a.html` },
    b: { url: `${base}/no-such-page.html` },
  });

  // 404 отдаёт страницу с текстом ошибки: сравнение состоится и покажет расхождение.
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].navigation.b.status, 404, 'статус второй стороны обязан быть виден');
});

test('без обоих адресов инструмент отказывается сразу', options, async () => {
  await assert.rejects(
    () => comparePages({ pool, runId: 'test-compare-bad', a: { url: `${base}/a.html` } }),
    /Нужны обе стороны/,
  );
});
