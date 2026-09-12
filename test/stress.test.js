/**
 * Прогон вёрстки контентом. Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Фикстура stress.html собрана так, что на исходном содержимом она цела, а ломается ровно от
 * подмены: карточка фиксированной высоты — от длинного заголовка, список фиксированной высоты —
 * от лишних элементов, строка без переносов — на узкой ширине. Так проверяется главное свойство
 * прогона: он показывает то, что появилось от подмены, а не то, что на странице было и так.
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
let runStress;
let server;
let base;

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ runStress } = await import('../src/checks/stress.js'));
  server = http.createServer(async (req, res) => {
    try {
      const body = await fs.readFile(path.join(FIXTURES, path.basename(req.url.split('?')[0])));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('прогон находит поломки от подмены и возвращает страницу как было', options, async () => {
  const session = await pool.createSession({ viewport: '1280x900' }, { owned: 'internal' });
  try {
    await pool.gotoAndSettle(session, `${base}/stress.html`);
    const before = await session.page.evaluate(() => document.querySelector('.card__title').textContent);

    const report = await runStress(session.page, { widths: [320, 768, 1280] });

    assert.equal(report.baseline.counts.boxOverflow, 0, 'на исходном содержимом фикстура цела');

    const longText = report.scenarios.find((entry) => entry.scenario.startsWith('текст ×'));
    assert.ok(
      longText.issues.some((issue) => issue.category === 'boxOverflow' && issue.clipped),
      `длинный текст должен обрезаться карточкой: ${JSON.stringify(longText.issues)}`,
    );

    const longList = report.scenarios.find((entry) => entry.scenario.startsWith('список до'));
    assert.ok(
      longList.issues.some((issue) => issue.category === 'boxOverflow'),
      `лишние элементы списка должны вылезти за его коробку: ${JSON.stringify(longList.issues)}`,
    );

    assert.equal(report.widths.firstBreak.width, 320, 'строка без переносов ломается на узкой ширине');

    const after = await session.page.evaluate(() => document.querySelector('.card__title').textContent);
    assert.equal(after, before, 'после прогона содержимое должно вернуться на место');
    assert.equal((await session.page.viewportSize()).width, 1280, 'ширина окна должна вернуться');
  } finally {
    await pool.closeSession(session.id);
  }
});
