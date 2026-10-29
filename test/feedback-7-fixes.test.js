/**
 * Правки по седьмому отзыву — вёрстка по Figma, когда аккаунту стенда файл открыт только на
 * просмотр, а запросы к файлам по REST выбраны за месяц. Здесь всё, что считается без браузера:
 * квота при неизвестном типе места, совет по состоянию каналов, роль на файле и копии в
 * черновиках, состояние редактора по файлу. Страница — в feedback-7-e2e.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRestClient } from '../src/figma/rest.js';
import { seatLimitType } from '../src/figma/api.js';
import { readCopy, removeCopy, writeCopy } from '../src/figma/copies.js';

const TOKEN = 'figd_feedback7_token';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-7-'));
let clock = Date.parse('2026-10-29T10:00:00Z');
let fileNo = 0;

function fakeFetch(respond = () => ({ body: {} })) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const next = respond(calls.length, String(url));
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: new Headers(next.headers || {}) });
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
    seat: '',
    ...extra,
  });
}

/* Запросы к файлам с паузой: минутное окно tier 1 здесь ни при чём. */
async function spend(api, n) {
  for (let i = 0; i < n; i += 1) {
    await api.fileNodes('KEY', ['1:2']);
    clock += 7000;
  }
}

test('тип места неизвестен: запросы к файлам считаются как у места View, двадцатый — последний', async () => {
  const net = fakeFetch();
  const api = client(net.impl);
  await spend(api, 20);
  await assert.rejects(api.fileNodes('KEY', ['1:2']), (err) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /Тип места Figma неизвестен/);
    assert.match(err.message, /FIGMA_SEAT=full/);
    return true;
  });
  assert.equal(net.calls.length, 20, 'двадцать первый запрос не должен уйти в сеть');
  const budget = await api.budget();
  assert.equal(budget.rateLimitType, null);
  assert.match(budget.assumed, /View/);
  assert.equal(budget.tiers[1].perMonth, 20);
  assert.equal(budget.tiers[1].remaining, 0);
});

test('FIGMA_SEAT=full снимает месячный потолок, view — ставит его сразу', async () => {
  const full = client(fakeFetch().impl, { seat: 'full' });
  await spend(full, 21);
  const budget = await full.budget();
  assert.equal(budget.rateLimitType, 'high');
  assert.equal(budget.source, 'FIGMA_SEAT');
  assert.equal(budget.tiers[1].perMonth, undefined);

  const view = client(fakeFetch().impl, { seat: 'view' });
  assert.equal((await view.budget()).tiers[1].perMonth, 20);
  assert.equal(seatLimitType('collab'), 'low');
  assert.equal(seatLimitType('dev'), 'high');
  assert.equal(seatLimitType('что-то'), null);
});

test('тип, названный Figma в 429, важнее FIGMA_SEAT', async () => {
  const net = fakeFetch((n) => (n === 1 ? { status: 429, headers: { 'retry-after': '5', 'x-figma-rate-limit-type': 'low' } } : { body: {} }));
  const api = client(net.impl, { seat: 'full' });
  await api.fileNodes('KEY', ['1:2']);
  const budget = await api.budget();
  assert.equal(budget.rateLimitType, 'low');
  assert.equal(budget.source, undefined);
  assert.equal(budget.tiers[1].perMonth, 20);
});

test('tier1Note: молчит при запасе, предупреждает при остатке ≤ 5 и при исчерпании', async () => {
  const api = client(fakeFetch().impl);
  assert.equal(await api.tier1Note(), null);
  await spend(api, 16);
  const low = await api.tier1Note();
  assert.equal(low.remaining, 4);
  assert.match(low.note, /Осталось 4 из 20/);
  await spend(api, 4);
  const out = await api.tier1Note();
  assert.equal(out.remaining, 0);
  assert.match(out.note, /исчерпаны/);
  assert.equal(await client(fakeFetch().impl, { seat: 'full' }).tier1Note(), null);
});

test('совет к отказу REST строит провайдер по файлу; без провайдера — прежний текст', async () => {
  const seen = [];
  const api = client(fakeFetch().impl, {
    hint: async (ctx) => {
      seen.push(ctx);
      return 'Канал редактора для этого файла недоступен: только просмотр.';
    },
  });
  await spend(api, 20);
  await assert.rejects(api.fileNodes('FILEKEY', ['1:2']), /только просмотр/);
  assert.deepEqual(seen, [{ fileKey: 'FILEKEY', tier: 1 }]);

  const plain = client(fakeFetch().impl);
  await spend(plain, 20);
  await assert.rejects(plain.fileNodes('KEY', ['1:2']), /канал редактора, у него лимита нет/);
});

test('копия в черновиках: запись, чтение и удаление связи', async () => {
  const cacheDir = path.join(tmp, 'figma');
  assert.equal(await readCopy('ORIG', { cacheDir }), null);
  await writeCopy('ORIG', { copyKey: 'COPY', name: 'Макет (Copy)', team: 'Команда', at: '2026-10-29T10:00:00Z' }, { cacheDir });
  assert.equal((await readCopy('ORIG', { cacheDir })).copyKey, 'COPY');
  await removeCopy('ORIG', { cacheDir });
  assert.equal(await readCopy('ORIG', { cacheDir }), null);
});

test('fileAccess: роль из /meta, кэш на полчаса, refresh спрашивает заново', async () => {
  const { fileAccess } = await import('../src/figma/access.js');
  const cacheDir = path.join(tmp, 'access');
  let calls = 0;
  const fake = {
    usable: async () => true,
    fileMeta: async () => {
      calls += 1;
      return { file: { role: 'viewer', link_access: 'view', version: '42', name: 'Хочу дешевле' } };
    },
  };
  const now = () => clock;
  const first = await fileAccess('ROLEKEY', { client: fake, cacheDir, now });
  assert.equal(first.role, 'viewer');
  assert.equal(first.linkAccess, 'view');
  assert.equal(first.version, '42');
  await fileAccess('ROLEKEY', { client: fake, cacheDir, now });
  assert.equal(calls, 1, 'второй вызов — из кэша');
  await fileAccess('ROLEKEY', { client: fake, cacheDir, now, refresh: true });
  assert.equal(calls, 2);
  assert.equal(await fileAccess('NOTOKEN', { client: { usable: async () => false }, cacheDir, now }), null);
});

test('channelAdvice: редактор лежит — не советует его; REST исчерпан — говорит прямо', async () => {
  const { channelAdvice } = await import('../src/figma/access.js');
  const editor = { usable: async () => false, why: async () => 'Аккаунту стенда файл открыт только на просмотр.' };
  const spent = { tier1Note: async () => ({ remaining: 0, note: 'Запросы к файлам и рендерам на этот месяц исчерпаны (20).' }) };
  const advice = await channelAdvice('KEY', { editor, client: spent });
  assert.match(advice, /только на просмотр/);
  assert.match(advice, /REST не поможет/);
  assert.doesNotMatch(advice, /у него лимита нет/);

  const ok = await channelAdvice('KEY', { editor: { usable: async () => true, why: async () => null }, client: spent, except: 'rest' });
  assert.match(ok, /у него лимита нет/);
  assert.doesNotMatch(ok, /REST/);
});

test('редактор по файлу: роль viewer по REST — канал не годится сразу, причина с вариантами', async () => {
  process.env.FIGMA_EMAIL = 'stand@example.test';
  process.env.FIGMA_PASSWORD = 'not-a-real-password';
  const editor = await import('../src/figma/editor.js');
  editor.registerAccessProbe(async (fileKey) => ({ role: fileKey === 'VIEWONLY7' ? 'viewer' : 'editor' }));
  /* copy: false — только ответ; без него стенд пошёл бы делать копию в настоящем браузере. */
  try {
    assert.equal(await editor.editorUsable('VIEWONLY7', { copy: false }), false);
    const why = await editor.editorWhy('VIEWONLY7');
    assert.match(why, /только на просмотр/);
    assert.match(why, /duplicate/);
    assert.equal(await editor.editorUsable('EDITABLE7'), true);
    /* Вход в аккаунт исправен: общее состояние про вход, а не про файл. */
    const status = await editor.editorStatus();
    assert.notEqual(status.state, 'error');
    assert.equal(status.storageState, editor.editorStateName());
    assert.equal(status.files.VIEWONLY7.state, 'view_only');
    assert.equal((await editor.editorFileStatus('VIEWONLY7')).state, 'view_only');
  } finally {
    editor.registerAccessProbe(null);
    delete process.env.FIGMA_EMAIL;
    delete process.env.FIGMA_PASSWORD;
  }
});

test('команда для неявной копии: FIGMA_DUPLICATE_TEAM без вопроса, без форм — отказ со списком', async () => {
  const { chooseCopyTeam } = await import('../src/figma/access.js');
  const teams = ['#dieztech', "Eugene's Starter team"];
  assert.equal(await chooseCopyTeam('KEY', teams, { team: "Eugene's Starter team" }), "Eugene's Starter team");
  /* Вне вызова инструмента спросить некого — как у клиента без elicitation. */
  const refused = await chooseCopyTeam('KEY', teams, { team: '', access: async () => null });
  assert.match(refused.declined, /не поддерживает формы/);
  assert.match(refused.declined, /Eugene's Starter team/);
  assert.match(refused.declined, /FIGMA_DUPLICATE_TEAM/);
});

test('askHuman: форма уходит клиенту с elicitation, ответ и отказ различаются', async () => {
  const { askHuman, bindRequests } = await import('../src/request.js');
  const asked = [];
  const make = (caps, reply) => {
    const handlers = {};
    const server = {
      server: { getClientCapabilities: () => caps, elicitInput: async (params) => (asked.push(params), reply) },
      registerTool: (name, _config, handler) => {
        handlers[name] = handler;
      },
    };
    bindRequests(server);
    server.registerTool('t', {}, () => askHuman('вопрос', { type: 'object', properties: {} }));
    return handlers.t;
  };
  assert.deepEqual(await make({ elicitation: {} }, { action: 'accept', content: { team: 'A' } })(), { action: 'accept', content: { team: 'A' } });
  assert.equal((await make({ elicitation: {} }, { action: 'decline' })()).action, 'decline');
  assert.equal((await make({}, null)()).action, 'unsupported');
  assert.equal((await askHuman('вне инструмента', {})).action, 'unsupported');
  assert.equal(asked.length, 2);
});
