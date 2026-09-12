/**
 * Учёт лимитов REST-клиента Figma.
 *
 * Сеть не трогается: fetch подменён, часы и ожидание — тоже. Проверяется главное свойство —
 * клиент не тратит запрос на заведомый отказ и не выдаёт токен в тексте ошибки.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRestClient } from '../src/figma/rest.js';

const TOKEN = 'figd_test_secret_token';
process.env.FIGMA_TOKEN = TOKEN;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-rest-'));
let clock = Date.parse('2026-09-11T10:00:00Z');
let fileNo = 0;

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {} });
    const next = respond(calls.length, String(url));
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, { status: next.status ?? 200, headers: new Headers(next.headers || {}) });
  };
  return { impl, calls };
}

function client(fetchImpl, extra = {}) {
  fileNo += 1;
  return createRestClient({
    fetchImpl,
    token: async () => ({ token: TOKEN, source: 'env' }),
    budgetFile: path.join(tmp, `limits-${fileNo}.json`),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    maxWaitMs: 20_000,
    apiBase: 'https://api.figma.test',
    ...extra,
  });
}

test('все id одного файла уходят одним запросом, токен — в заголовке', async () => {
  const net = fakeFetch(() => ({ body: { nodes: {} } }));
  await client(net.impl).fileNodes('KEY', ['1033:12944', '1062:13919']);
  assert.equal(net.calls.length, 1);
  assert.match(decodeURIComponent(net.calls[0].url), /\/v1\/files\/KEY\/nodes\?ids=1033:12944,1062:13919/);
  assert.equal(net.calls[0].headers['X-Figma-Token'], TOKEN);
  assert.ok(!net.calls[0].url.includes(TOKEN), 'токен не должен попадать в адрес');
});

test('минутное окно соблюдается без 429: одиннадцатый запрос отклонён без обращения к сети', async () => {
  const net = fakeFetch(() => ({ body: {} }));
  const api = client(net.impl);
  for (let i = 0; i < 10; i += 1) await api.fileNodes('KEY', ['1:2']);
  await assert.rejects(api.fileNodes('KEY', ['1:2']), (err) => err.status === 429 && /10 из 10/.test(err.message));
  assert.equal(net.calls.length, 10);
});

test('короткий Retry-After переживается одним повтором, тип места запоминается', async () => {
  const net = fakeFetch((n) =>
    n === 1
      ? { status: 429, headers: { 'retry-after': '5', 'x-figma-rate-limit-type': 'high', 'x-figma-plan-tier': 'pro' } }
      : { body: { ok: true } },
  );
  const api = client(net.impl);
  assert.deepEqual(await api.fileMeta('KEY'), { ok: true });
  assert.equal(net.calls.length, 2);
  const budget = await api.budget();
  assert.equal(budget.rateLimitType, 'high');
  assert.equal(budget.planTier, 'pro');
  assert.equal(budget.tiers[1].perMinute, 15);
});

test('после длинного Retry-After следующий вызов отказывает сразу, не тратя попытку', async () => {
  const net = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '3600' } }));
  const api = client(net.impl);
  await assert.rejects(api.images('KEY', ['1:2']), (err) => err.status === 429 && err.retryAfter === 3600);
  await assert.rejects(api.fileNodes('KEY', ['1:2']), /уже отказала/);
  assert.equal(net.calls.length, 1);
  assert.ok((await api.budget()).tiers[1].blockedUntil);
});

test('место View/Collab: запросы к файлам считаются в месяц', async () => {
  const net = fakeFetch(() => ({ body: {}, headers: { 'x-figma-rate-limit-type': 'low' } }));
  const api = client(net.impl);
  for (let i = 0; i < 20; i += 1) {
    await api.fileNodes('KEY', ['1:2']);
    clock += 1000;
  }
  await assert.rejects(api.fileNodes('KEY', ['1:2']), /Месячный лимит/);
  assert.equal(net.calls.length, 20);
  /* Комментарии и метаданные — другие tier, у них свой минутный лимит. */
  await api.fileMeta('KEY');
  assert.equal(net.calls.length, 21);
});

test('403 объясняет, какого scope не хватает, и не повторяет токен', async () => {
  const net = fakeFetch(() => ({ status: 403, body: { status: 403, err: `Invalid token ${TOKEN}` } }));
  await assert.rejects(client(net.impl).fileNodes('KEY', ['1:2']), (err) => {
    assert.match(err.message, /file_content:read/);
    assert.ok(!err.message.includes(TOKEN), 'токен утёк в текст ошибки');
    return true;
  });
});

test('без токена запрос не уходит', async () => {
  const net = fakeFetch(() => ({ body: {} }));
  const api = client(net.impl, { token: async () => ({ token: null, source: null }) });
  await assert.rejects(api.me(), /FIGMA_TOKEN/);
  assert.equal(net.calls.length, 0);
});

test('учёт переживает перезапуск: новый клиент видит запросы старого', async () => {
  const net = fakeFetch(() => ({ body: {} }));
  const budgetFile = path.join(tmp, 'shared.json');
  const first = client(net.impl, { budgetFile });
  await first.fileNodes('KEY', ['1:2']);
  await first.fileNodes('KEY', ['1:2']);
  const second = client(net.impl, { budgetFile });
  assert.equal((await second.budget()).tiers[1].lastMinute, 2);
});
