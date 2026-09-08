/**
 * Потолок числа сессий и вытеснение.
 *
 * Отдельным файлом от session-lifecycle: границы читаются из окружения один раз при загрузке
 * CONFIG, а здесь нужен длинный простой (чтобы сессии не закрывались сами) и низкий потолок.
 * В одном процессе эти два набора не уживаются.
 *
 *   LT_BROWSER_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

process.env.LT_MAX_SESSIONS = '2';
process.env.LT_SESSION_IDLE_MS = '600000';
process.env.LT_SESSION_MAX_AGE_MS = '0';
process.env.LT_SESSION_SWEEP_MS = '600000';

let pool;

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
});

test.after(async () => {
  if (pool) await pool.closeAll();
});

test('на потолке вытесняется та, к которой дольше не обращались', options, async () => {
  const first = await pool.createSession({ viewport: 'mobile' });
  const second = await pool.createSession({ viewport: 'tablet' });

  // Обе созданы вплотную и могут попасть в одну миллисекунду; ждём, чтобы отметка обращения
  // заведомо оказалась позже, иначе порядок вытеснения определяется не тем, чем проверяем.
  await new Promise((r) => setTimeout(r, 5));
  // Трогаем первую: теперь дольше всех простаивает вторая, её и должно вытеснить.
  pool.getSession(first.id);

  const third = await pool.createSession({ viewport: 'desktop' });

  const live = pool.listSessions().map((s) => s.id);
  assert.equal(live.length, 2, 'потолок LT_MAX_SESSIONS=2 должен соблюдаться');
  assert.ok(live.includes(first.id), 'к первой обращались — она остаётся');
  assert.ok(live.includes(third.id), 'новая должна открыться');
  assert.equal(live.includes(second.id), false, 'самая давняя по обращению вытесняется');

  const past = pool.listEvicted().find((e) => e.id === second.id);
  assert.ok(past, 'вытесненная попадает в журнал');
  assert.equal(past.reason, 'lru');
  assert.match(past.why, /потолок/);
});

test('сессии внутренних прогонов не вытесняются, а отказ называет причину', options, async () => {
  await pool.closeAll();

  const ids = await pool.withSession({ viewport: 'mobile' }, async (outer) =>
    pool.withSession({ viewport: 'tablet' }, async (inner) => {
      // Оба места заняты внутренними прогонами. Вытеснять нечего, и стенд обязан сказать это
      // прямо, а не убить чужой обход ради разовой проверки.
      await assert.rejects(
        () => pool.createSession({ viewport: 'desktop' }),
        /Стенд занят/,
      );
      return [outer.id, inner.id];
    }),
  );

  // Обе закрылись своим finally, а не вытеснением.
  for (const id of ids) {
    const past = pool.listEvicted().find((e) => e.id === id);
    assert.ok(past, 'внутренняя сессия должна попасть в журнал');
    assert.equal(past.reason, 'closed');
  }
});
