/**
 * Правки по пятому отзыву — вёрстка по Figma, заход 4: места, где агент обходил стенд руками.
 * Ховер отдельным компонентом, набор без пары-состояния, поиск, который терял компонент за его
 * экземплярами, координаты свёрнутых соседей, выравнивание ряда и проба молчащего сервера.
 * Здесь всё, что считается без браузера; страница — в feedback-5-e2e.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { DIRS } from '../src/constants.js';
import { MODEL, rankHits, searchRestDocument } from '../src/figma/snapshot.js';
import { pairSiblings, pickPair, stateBase } from '../src/figma/variants.js';
import { outlineLines } from '../src/figma/inspect.js';
import { compareGeometry, findRowAlign } from '../src/figma/compare.js';
import { probeHint, probeServer } from '../src/browser/response.js';
import { runFigmaVariants } from '../src/tools/figma.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const solid = (r, g, b, a = 1) => ({ kind: 'solid', color: { r, g, b, a } });

test('stateBase: имя без слова-состояния, и «on» внутри слова состоянием не считается', () => {
  assert.equal(stateBase('Mission card'), 'mission card');
  assert.equal(stateBase('Mission card Hover'), 'mission card');
  assert.equal(stateBase('Mission card / hover'), 'mission card');
  assert.equal(stateBase('Mission card (Default)'), 'mission card');
  assert.equal(stateBase('State=Hover'), '');
});

test('pairSiblings: одиночный компонент находит ховер соседом, ссылка на ховер — базовый', () => {
  const card = { id: '1:1', type: 'COMPONENT', name: 'Mission card' };
  const hover = { id: '1:2', type: 'COMPONENT', name: 'Mission card Hover' };
  const other = { id: '1:3', type: 'COMPONENT', name: 'News card' };
  const frame = { id: '1:4', type: 'FRAME', name: 'Mission card hover preview' };
  assert.deepEqual(pairSiblings(card, [card, hover, other, frame]), { from: card, to: hover });
  assert.deepEqual(pairSiblings(hover, [card, hover, other]), { from: card, to: hover });
  assert.deepEqual(pairSiblings(card, [card, other]).candidates, []);
  const pressed = { id: '1:5', type: 'COMPONENT', name: 'Mission card Pressed' };
  const selected = { id: '1:6', type: 'COMPONENT', name: 'Mission card Selected' };
  assert.equal(pairSiblings(card, [card, pressed, selected]).candidates.length, 2, 'два состояния без Hover — выбор за агентом');
});

test('pickPair: набор без варианта-состояния рядом с базовым — не ошибка, а базовый против всех', () => {
  const variants = [
    { id: 'a', name: 'Type=Primary, Size=L' },
    { id: 'b', name: 'Type=Secondary, Size=L' },
    { id: 'c', name: 'Type=Primary, Size=S' },
    { id: 'd', name: 'Type=Ghost, Size=S' },
  ];
  const pair = pickPair(variants, {});
  assert.equal(pair.error, undefined);
  assert.equal(pair.from.id, 'a');
  assert.deepEqual(
    pair.all.map((variant) => variant.id),
    ['b', 'c', 'd'],
  );
  assert.match(pickPair(variants, { to: 'Hover' }).error, /не найден/, 'явно названный и не найденный — по-прежнему ошибка');
});

/* Снимок во временном файле кэша: runFigmaVariants читает узлы оттуда и в Figma не ходит. */
const KEY = 'Feedback5TestKey00';
async function withCache(nodes, roots, fn) {
  const dir = path.join(DIRS.figma, KEY);
  await fs.mkdir(path.join(dir, 'v1'), { recursive: true });
  const meta = { version: 'v1', roots: {} };
  for (const root of roots) {
    const file = `v1/${root.replace(/:/g, '-')}.json`;
    meta.roots[root] = { version: 'v1', model: MODEL, file };
    const own = {};
    const visit = (id) => {
      own[id] = nodes[id];
      for (const child of nodes[id].children || []) visit(child);
    };
    visit(root);
    await fs.writeFile(path.join(dir, file), JSON.stringify({ fileKey: KEY, root, version: 'v1', nodes: own }));
  }
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  try {
    return await fn();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function cards() {
  const card = (id, name, { radius, btn, text }) => ({
    [id]: { id, type: 'COMPONENT', name, box: box(0, 0, 300, 200), radius, children: [`${id}b`], component: { definition: true } },
    [`${id}b`]: { id: `${id}b`, parent: id, type: 'FRAME', name: 'Button', box: box(20, 140, 160, 40), fills: [btn], children: [`${id}t`] },
    [`${id}t`]: { id: `${id}t`, parent: `${id}b`, type: 'TEXT', name: 'Label', box: box(36, 150, 128, 20), fills: [text], text: { chars: 'Детали миссии' } },
  });
  return {
    '5:1': { id: '5:1', type: 'FRAME', name: 'UI kit / Cards', box: box(0, 0, 700, 200), children: ['5:2', '5:3'] },
    ...card('5:2', 'Mission card', { radius: 4, btn: solid(20, 20, 20), text: solid(255, 255, 255) }),
    ...card('5:3', 'Mission card Hover', { radius: 12, btn: solid(231, 235, 112), text: solid(20, 20, 20) }),
  };
}

test('figma_variants: пара узлов from/to — тот же дифф по потомкам, что у вариантов набора', async () => {
  const nodes = cards();
  nodes['5:2'].parent = '5:1';
  nodes['5:3'].parent = '5:1';
  await withCache(nodes, ['5:1'], async () => {
    const res = await runFigmaVariants({ from: `${KEY}:5:2`, to: `${KEY}:5:3` });
    assert.equal(res.mode, 'nodes');
    assert.equal(res.from.name, 'Mission card');
    const props = res.changes.map((change) => `${change.path} ${change.prop}`);
    assert.ok(props.includes('/ radius'), props.join('; '));
    assert.ok(props.includes('/Button fills'));
    assert.ok(props.includes('/Button/Label fills'));
    /* Голый id в to — файл из figma. */
    const short = await runFigmaVariants({ figma: `${KEY}:5:2`, to: '5:3' });
    assert.equal(short.to.name, 'Mission card Hover');
  });
});

test('figma_variants: одиночный компонент без набора сам находит соседа-ховер', async () => {
  const nodes = cards();
  nodes['5:2'].parent = '5:1';
  nodes['5:3'].parent = '5:1';
  await withCache(nodes, ['5:1'], async () => {
    const res = await runFigmaVariants({ figma: `${KEY}:5:2` });
    assert.equal(res.mode, 'nodes');
    assert.match(res.pairedBy, /«Mission card» → «Mission card Hover»/);
    assert.ok(res.changed >= 3);
  });
});

test('figma_find: определение компонента впереди экземпляров, экземпляры свёрнуты по главному', () => {
  const instance = (id) => ({
    id,
    type: 'INSTANCE',
    name: 'Mission card',
    componentId: '176:6346',
    children: [{ id: `${id}:t`, type: 'TEXT', name: 'Label', characters: 'Детали миссии' }],
  });
  const document = {
    type: 'DOCUMENT',
    children: [
      { type: 'CANVAS', name: 'Главная', children: [{ id: '1:1', type: 'FRAME', name: 'Desktop', children: [instance('1:2'), instance('1:3'), instance('1:4')] }] },
      {
        type: 'CANVAS',
        name: 'UI kit',
        children: [
          {
            id: '176:6346',
            type: 'COMPONENT',
            name: 'Mission card',
            children: [{ id: '176:6350', type: 'TEXT', name: 'Label', characters: 'Детали миссии' }],
          },
        ],
      },
    ],
  };
  const hits = searchRestDocument(document, 'детали миссии', { components: { '176:6346': { name: 'Mission card' } } });
  assert.equal(hits.length, 4);
  const ranked = rankHits(hits, 30);
  assert.equal(ranked.results[0].id, '176:6350');
  assert.deepEqual(ranked.results[0].component, { id: '176:6346', name: 'Mission card' });
  assert.equal(ranked.results[1].instances, 3);
  assert.equal(ranked.results[1].mainComponent.id, '176:6346');
  assert.equal(ranked.results.length, 2, 'три экземпляра — одна строка');
  /* limit режет после ранжирования: компонент не вытесняется экземплярами, стоящими раньше. */
  assert.equal(rankHits(hits, 1).results[0].id, '176:6350');
});

test('outline: корень знает своё место в родителе, свёрнутые соседи — каждый свои координаты', () => {
  const snapshot = {
    root: '2:1',
    nodes: {
      '2:1': { id: '2:1', type: 'FRAME', name: 'Timeline', box: box(100, 50, 600, 40), children: ['2:2', '2:3', '2:4', '2:5'] },
      ...Object.fromEntries(
        ['2:2', '2:3', '2:4', '2:5'].map((id, i) => [id, { id, parent: '2:1', type: 'ELLIPSE', name: 'Dot', box: box(100 + i * 150, 60, 12, 12) }]),
      ),
    },
    ancestors: [{ id: '0:1', type: 'PAGE', name: 'Page' }, { id: '1:9', type: 'FRAME', name: 'Section', box: box(40, 10, 800, 400) }],
  };
  const lines = outlineLines(snapshot, '2:1');
  assert.match(lines[0], /@parent 60,40 в 1:9$/);
  assert.match(lines.find((line) => line.includes('×3')), /×3 как 2:2: 2:3@150,10, 2:4@300,10, 2:5@450,10 \(шаг x 150\)/);
  const dot = outlineLines(snapshot, '2:4');
  assert.match(dot[0], /^2:4 ELLIPSE "Dot" 0,0 12x12 @parent 300,10 в 2:1/);
});

/* Пара текстов для compareGeometry: design в координатах макета, page — страницы. */
const pair = (id, text, d, p) => ({
  design: { kind: 'text', id, text, box: d, style: {} },
  page: { kind: 'text', text, selector: `#${id.replace(':', '_')}`, box: p, style: {} },
});

test('figma_compare: разброс ряда в макете при ровном ряде на странице — не находка', () => {
  const pairs = [
    pair('3:1', 'Подробнее', box(40, 642, 100, 20), box(40, 640, 100, 20)),
    pair('3:2', 'Подробнее', box(400, 645, 100, 20), box(400, 640, 100, 20)),
    pair('3:3', 'Подробнее', box(760, 642, 100, 20), box(760, 640, 100, 20)),
  ];
  const [row] = findRowAlign(pairs);
  assert.equal(row.verdict, 'design-noise');
  assert.equal(row.designSpread, 3);
  assert.match(row.rowAlign, /642 \/ 645 \/ 642 \(разброс 3px\), на странице 640 \/ 640 \/ 640 — выровнено/);

  const geometry = compareGeometry({ items: pairs.map((item) => item.design) }, { items: pairs.map((item) => item.page) });
  assert.ok(!geometry.findings.some((finding) => finding.shift?.y), JSON.stringify(geometry.findings));
  assert.equal(geometry.rowNoise.length, 1);
});

test('figma_compare: ряд ровный в макете и разъехался на странице — одна находка с подсказкой', () => {
  const pairs = [
    pair('4:1', 'Подробнее', box(40, 642, 100, 20), box(40, 640, 100, 20)),
    pair('4:2', 'Подробнее', box(400, 642, 100, 20), box(400, 664, 100, 20)),
  ];
  const [row] = findRowAlign(pairs);
  assert.equal(row.verdict, 'misaligned');
  assert.equal(row.pageSpread, 24);
  assert.match(row.hint, /margin-top: auto/);
  /* Один текст в колонку — это не ряд. */
  assert.deepEqual(findRowAlign([pair('4:3', 'Ещё', box(40, 100, 100, 20), box(40, 100, 100, 20)), pair('4:4', 'Ещё', box(40, 104, 100, 20), box(40, 100, 100, 20))]), []);
});

/* Локальный сервер для пробы: принимает соединение и молчит, либо отвечает. */
async function listen(handler) {
  const server = net.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test('probeServer: принятое соединение без ответа, отказ и живой сервер различаются', async () => {
  const sockets = [];
  const silent = await listen((socket) => sockets.push(socket));
  const quiet = await probeServer(silent.url, { httpMs: 500 });
  assert.equal(quiet.state, 'acceptedNoResponse');
  assert.match(probeHint(quiet, silent.url), /принимает соединение, но не присылает ни байта/);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => silent.server.close(resolve));

  const refused = await probeServer(silent.url);
  assert.equal(refused.state, 'refused');

  const alive = await listen((socket) => socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')));
  const ok = await probeServer(alive.url);
  assert.equal(ok.state, 'responds');
  assert.equal(ok.status, 200);
  await new Promise((resolve) => alive.server.close(resolve));
});
