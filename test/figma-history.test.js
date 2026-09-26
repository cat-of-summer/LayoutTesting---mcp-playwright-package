/**
 * История макета: версии за период, выбор точек сравнения и разница двух снимков узла.
 *
 * Сеть не трогается: клиент REST подменён объектом с теми же методами.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diffSnapshots, fetchVersions, parseMoment, pickVersions, snapshotAt } from '../src/figma/history.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-history-'));
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-26T12:00:00Z');

/* Сто двадцать версий раз в шесть часов, от новых к старым — как отдаёт Figma. */
const all = Array.from({ length: 120 }, (_, i) => ({
  id: String(1000 - i),
  created_at: new Date(now - i * 6 * 60 * 60 * 1000).toISOString(),
  user: { handle: i % 2 ? 'designer' : 'pm' },
  label: i === 3 ? 'Сдача 1' : null,
  description: i === 3 ? 'Первая сдача' : '',
}));

function fakeClient() {
  const calls = [];
  return {
    calls,
    versions: async (key, { before, pageSize = 50 } = {}) => {
      calls.push({ key, before });
      const start = before ? all.findIndex((v) => v.id === before) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      return { versions: page, pagination: start + pageSize < all.length ? { next_page: 'https://api/next' } : {} };
    },
  };
}

test('дата без времени — сутки целиком; мусор — понятная ошибка', () => {
  assert.equal(parseMoment('2026-09-20'), Date.parse('2026-09-20T00:00:00Z'));
  assert.equal(parseMoment('2026-09-20', { end: true }), Date.parse('2026-09-21T00:00:00Z') - 1);
  assert.equal(parseMoment(undefined), null);
  assert.throws(() => parseMoment('вчера'), /Не разобрать дату/);
});

test('версии листаются, пока не дойдут до начала периода, и дочитываются из кэша', async () => {
  const client = fakeClient();
  const cacheDir = path.join(tmp, 'a');
  const week = await fetchVersions('KEY', { since: now - 7 * DAY, client, cacheDir, now: () => now });
  assert.equal(week.requests, 1, 'неделя — это 28 версий, хватает первой страницы');
  assert.equal(week.versions[3].label, 'Сдача 1');
  assert.equal(week.versions[3].autosave, false);
  assert.equal(week.versions[0].autosave, true);

  const month = await fetchVersions('KEY', { since: now - 20 * DAY, client, cacheDir, now: () => now + 1000 });
  assert.equal(month.requests, 1, 'за более ранним периодом дочитывается только хвост');
  assert.equal(client.calls.at(-1).before, week.versions.at(-1).id);
  assert.ok(Date.parse(month.versions.at(-1).at) < now - 20 * DAY);

  const again = await fetchVersions('KEY', { since: now - 20 * DAY, client, cacheDir, now: () => now + 2000 });
  assert.equal(again.fromCache, true);

  const stale = await fetchVersions('KEY', { since: now - 7 * DAY, client, cacheDir, now: () => now + 10 * 60 * 1000 });
  assert.equal(stale.requests, 1, 'кэш старше пяти минут перечитывается');
});

test('base — последняя версия не позже начала, head — не позже конца или текущее состояние', () => {
  const versions = all.slice(0, 50).map((v) => ({ id: v.id, at: v.created_at, by: v.user.handle }));
  const pick = pickVersions(versions, { since: now - DAY - 1, until: now - 3 * 60 * 60 * 1000 });
  assert.equal(pick.base.id, String(1000 - 5), 'на начало периода — версия, сделанная до него');
  assert.equal(pick.head.id, String(1000 - 1));
  assert.equal(pick.baseIsOldest, false);

  const current = pickVersions(versions, { since: now - DAY - 1 });
  assert.equal(current.head.current, true, 'без until сравнивается с текущим файлом, а не с автосохранением');

  const early = pickVersions(versions, { since: now - 400 * DAY });
  assert.equal(early.baseIsOldest, true);
  assert.equal(early.base.id, versions.at(-1).id);
});

test('снимок версии кэшируется бессрочно, текущий — нет', async () => {
  const cacheDir = path.join(tmp, 'b');
  let calls = 0;
  const client = {
    fileNodes: async (key, ids, { version } = {}) => {
      calls += 1;
      return {
        version: version ?? '2000',
        nodes: { [ids[0]]: { document: { id: ids[0], type: 'FRAME', name: `кадр ${version ?? 'сейчас'}`, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } } } },
      };
    },
  };
  const first = await snapshotAt('KEY', '1:1', '990', { client, cacheDir });
  const second = await snapshotAt('KEY', '1:1', '990', { client, cacheDir });
  assert.equal(first.requests, 1);
  assert.equal(second.requests, 0);
  assert.equal(second.snapshot.nodes['1:1'].name, 'кадр 990');
  await snapshotAt('KEY', '1:1', null, { client, cacheDir });
  await snapshotAt('KEY', '1:1', null, { client, cacheDir });
  assert.equal(calls, 3);
});

const solid = (r, g, b) => ({ kind: 'solid', color: { r, g, b, a: 1 } });
function snap(nodes) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root: '1:1', nodes: map };
}

test('разница: верхушки добавленного и удалённого, поля изменённого', () => {
  const before = snap([
    { id: '1:1', type: 'FRAME', name: 'Карточка', box: { x: 100, y: 100, w: 300, h: 200 }, children: ['1:2', '1:3', '1:4'] },
    { id: '1:2', type: 'TEXT', name: 'Заголовок', box: { x: 120, y: 120, w: 200, h: 24 }, text: { chars: 'Хирург', style: { family: 'Manrope', size: 16, weight: 700 } } },
    { id: '1:3', type: 'FRAME', name: 'Кнопка', box: { x: 120, y: 240, w: 120, h: 40 }, fills: [solid(190, 158, 111)], radius: 16, children: ['1:5'] },
    { id: '1:5', type: 'TEXT', name: 'Записаться', box: { x: 130, y: 250, w: 100, h: 20 }, text: { chars: 'Записаться' } },
    { id: '1:4', type: 'RECTANGLE', name: 'Старый декор', box: { x: 380, y: 100, w: 20, h: 20 } },
  ]);
  /* Весь кадр уехал по холсту на 500px: это не правка вёрстки и в разнице быть не должно. */
  const after = snap([
    { id: '1:1', type: 'FRAME', name: 'Карточка', box: { x: 600, y: 100, w: 300, h: 220 }, children: ['1:2', '1:3', '1:6'] },
    { id: '1:2', type: 'TEXT', name: 'Заголовок', box: { x: 620, y: 120, w: 200, h: 24 }, text: { chars: 'Хирург-онколог', style: { family: 'Manrope', size: 18, weight: 700 } } },
    { id: '1:3', type: 'FRAME', name: 'Кнопка', box: { x: 620, y: 260, w: 120, h: 40 }, fills: [solid(8, 35, 68)], radius: 16, children: ['1:5'] },
    { id: '1:5', type: 'TEXT', name: 'Записаться', box: { x: 630, y: 270, w: 100, h: 20 }, text: { chars: 'Записаться' } },
    { id: '1:6', type: 'FRAME', name: 'Бейдж', box: { x: 620, y: 150, w: 60, h: 20 }, children: ['1:7'] },
    { id: '1:7', type: 'TEXT', name: 'Новое', box: { x: 625, y: 152, w: 50, h: 16 }, text: { chars: 'Новое' } },
  ]);

  const diff = diffSnapshots(before, after, '1:1');
  assert.deepEqual(diff.added.map((item) => item.node), ['1:6'], 'добавленный бейдж — одна запись, без своего текста');
  assert.equal(diff.added[0].url, 'https://www.figma.com/design/KEY/?node-id=1-6');
  assert.deepEqual(diff.removed.map((item) => item.node), ['1:4']);

  const byId = Object.fromEntries(diff.changed.map((item) => [item.node, item.changes]));
  assert.deepEqual(byId['1:1'], { size: { from: '300x200', to: '300x220' } }, 'сдвиг кадра по холсту — не изменение');
  assert.deepEqual(byId['1:2'].text, { from: 'Хирург', to: 'Хирург-онколог' });
  assert.deepEqual(byId['1:2'].font, { from: 'Manrope 700 16px', to: 'Manrope 700 18px' });
  assert.deepEqual(byId['1:3'].fill, { from: '#be9e6f', to: '#082344' });
  assert.deepEqual(byId['1:3'].position, { from: '20,140', to: '20,160' });
  assert.equal(diff.changed.find((item) => item.node === '1:2').path, 'Карточка / Заголовок');
  assert.ok(byId['1:5'].position, 'текст кнопки съехал вместе с ней');
});
