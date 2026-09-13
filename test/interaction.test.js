/**
 * Прогон интерактива. Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Фикстура interaction.html держит четыре случая, которые на неподвижном снимке неразличимы:
 * честный аккордеон с переходом на 300 мс, кнопку без обработчика, слайдер, двигающийся
 * прокруткой (а не геометрией), и бесконечную бегущую строку. Проверяется, что прогон их
 * различает — и что бесконечной он не выдумывает конец.
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
let runInteractions;
let server;
let base;

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ runInteractions } = await import('../src/checks/interaction.js'));
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

const open = async () => {
  /* animations: allow — иначе переход через сто миллисекунд уже в конечном состоянии. */
  const session = await pool.createSession({ viewport: '1280x900', animations: 'allow' }, { owned: 'internal' });
  await pool.gotoAndSettle(session, `${base}/interaction.html`, { animations: 'allow' });
  return session;
};

test('кнопка без обработчика отделяется от работающего аккордеона', options, async () => {
  const session = await open();
  try {
    const report = await runInteractions(session.page, { selectors: ['.acc', '.dead'], timeoutMs: 1500 });

    const dead = report.targets.find((entry) => entry.selector.includes('dead'));
    assert.equal(dead.verdict, 'молчит', JSON.stringify(dead));
    assert.ok(report.silent.some((item) => item.includes('dead')), JSON.stringify(report.silent));

    const acc = report.targets.find((entry) => entry.selector.includes('acc'));
    assert.equal(acc.verdict, 'ответил', JSON.stringify(acc));
    assert.ok(
      acc.changed.attrs.some((change) => change.attr === 'aria-expanded' && change.to === 'true'),
      `состояние должно переключиться: ${JSON.stringify(acc.changed.attrs)}`,
    );
    /* Переход объявлен на 300 мс. Меряем по кадрам, поэтому вилка широкая, но не любая. */
    assert.ok(acc.timing.settled, JSON.stringify(acc.timing));
    assert.ok(acc.timing.durationMs >= 150 && acc.timing.durationMs <= 700, `длительность ${acc.timing.durationMs}мс`);
    assert.equal(acc.timing.smooth, true, 'переход идёт кадрами, а не одним скачком');
  } finally {
    await pool.closeSession(session.id);
  }
});

/* Слайдер двигает дорожку прокруткой: по геометрии слайдов этого не видно вовсе. */
test('движение прокруткой засчитывается как ответ', options, async () => {
  const session = await open();
  try {
    const report = await runInteractions(session.page, { selectors: ['.slider__next'], timeoutMs: 1500 });
    const arrow = report.targets[0];
    assert.equal(arrow.verdict, 'ответил', JSON.stringify(arrow));
    assert.equal(arrow.changed.moved, true);
  } finally {
    await pool.closeSession(session.id);
  }
});

/* Бесконечной анимации конца нет — выдумывать ей длительность нельзя. */
test('бесконечная анимация признаётся непрекращающейся, а не медленной', options, async () => {
  const session = await open();
  try {
    const report = await runInteractions(session.page, { selectors: ['.marquee__track'], actions: ['hover'], timeoutMs: 600 });
    const marquee = report.targets[0];
    assert.equal(marquee.timing.settled, false, JSON.stringify(marquee.timing));
    assert.equal(marquee.timing.kind, 'continuous');
    assert.equal(marquee.timing.durationMs, undefined, 'придуманной длительности быть не должно');
    /* Непрерывно движущийся элемент обычным наведением не берётся: об этом надо сказать, а не
       тихо подменить способ действия. */
    assert.match(marquee.forced, /не замирает/, 'принудительное действие должно быть названо');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('на замороженной странице прогон отказывается, а не мерит нули', options, async () => {
  const session = await pool.createSession({ viewport: '1280x900' }, { owned: 'internal' });
  try {
    await pool.gotoAndSettle(session, `${base}/interaction.html`);
    assert.equal(session.motionFrozen, true, 'сессия по умолчанию глушит движение');
  } finally {
    await pool.closeSession(session.id);
  }
});
