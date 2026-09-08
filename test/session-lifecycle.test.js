/**
 * Жизненный цикл сессий: простой, потолок, падение страницы, журнал закрытых.
 *
 * Нужен настоящий браузер, поэтому по умолчанию пропускается — как и остальные такие тесты:
 *
 *   LT_BROWSER_TESTS=1 npm test
 *
 * Границы задаются через окружение до импорта pool.js: CONFIG читается один раз при загрузке
 * модуля, и поменять их после импорта уже нельзя.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

process.env.LT_SESSION_IDLE_MS = '200';
process.env.LT_SESSION_SWEEP_MS = '50';
process.env.LT_SESSION_MAX_AGE_MS = '0';
process.env.LT_MAX_SESSIONS = '3';

let pool;

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
});

test.after(async () => {
  if (pool) await pool.closeAll();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('сессия закрывается по простою, и журнал объясняет чем', options, async () => {
  const session = await pool.createSession({ viewport: 'mobile', colorScheme: 'dark' });
  const { id } = session;
  assert.ok(pool.listSessions().some((s) => s.id === id), 'сессия должна быть среди живых');

  await wait(700);

  assert.equal(pool.listSessions().some((s) => s.id === id), false, 'по простою должна закрыться');

  const past = pool.listEvicted().find((e) => e.id === id);
  assert.ok(past, 'закрытая сессия должна попасть в журнал');
  assert.equal(past.reason, 'idle');
  // Условия сохраняются ровно те, что передали: по ним открывают равноценную сессию.
  assert.deepEqual(past.reopen, { viewport: 'mobile', colorScheme: 'dark' });
});

test('обращение к закрытой сессии объясняет причину, а не только факт', options, async () => {
  const session = await pool.createSession({ viewport: 'mobile' });
  const { id } = session;
  await wait(700);

  assert.throws(
    () => pool.getSession(id),
    (err) => {
      assert.match(err.message, /закрыта/);
      assert.match(err.message, /простой/);
      assert.match(err.message, /browser_open/);
      assert.match(err.message, /viewport/);
      return true;
    },
  );
});

test('о несуществовавшей сессии не сочиняется история', options, async () => {
  assert.throws(() => pool.getSession('нетакой'), /такой и не было/);
});

test('доступ не утекает в подсказку по восстановлению', options, async () => {
  const session = await pool.createSession({ viewport: 'mobile', auth: 'user:secret' });
  const { id } = session;
  await pool.closeSession(id);

  const past = pool.listEvicted().find((e) => e.id === id);
  assert.equal(past.reason, 'closed');
  assert.equal(JSON.stringify(past.reopen).includes('secret'), false, 'пароля в журнале быть не должно');
  assert.deepEqual(past.reopen, { viewport: 'mobile' });
});

test('обращение к сессии продлевает ей жизнь', options, async () => {
  const session = await pool.createSession({ viewport: 'mobile' });
  const { id } = session;
  for (let i = 0; i < 6; i += 1) {
    await wait(80);
    pool.getSession(id);
  }
  assert.ok(pool.listSessions().some((s) => s.id === id), 'пока к ней обращаются, закрываться не должна');
  await pool.closeSession(id);
});

test('живая страница переживает мёртвую соседку в списке', options, async () => {
  const dead = await pool.createSession({ viewport: 'mobile' });
  const alive = await pool.createSession({ viewport: 'desktop' });
  // Закрываем страницу мимо closeSession — так же выглядит падение вкладки.
  await dead.page.close();

  const listed = pool.listSessions();
  assert.ok(listed.some((s) => s.id === alive.id), 'живая сессия должна остаться в списке');
  const row = listed.find((s) => s.id === dead.id);
  if (row) assert.equal(row.alive, false, 'мёртвая помечается, а не роняет ответ');

  await pool.closeSession(alive.id);
  await pool.closeSession(dead.id);
});
