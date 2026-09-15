/**
 * Правки по разбору сдачи одного лендинга: то, что инструменты могли поймать сами.
 *
 * Каждый тест — про ошибку, которая ушла в сдачу: null в действиях прототипа валил разбор,
 * одноцветная иконка приезжала без цвета, рендер не знал об обрезке родителем, узел из задачи
 * оказывался не кадром, кадры за сотым были недостижимы, свёрнутые по глубине узлы терялись
 * молча, секции сверялись по высоте, а не по картинке. Всё считается по снимку, без браузера.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBehavior } from '../src/figma/analyze/behavior.js';
import { collectTokens } from '../src/figma/analyze/tokens.js';
import { findParallels } from '../src/figma/analyze/components.js';
import { assetInventory } from '../src/figma/assets.js';
import { clipHint, normalizeSvg, oversizedHint } from '../src/figma/export.js';
import { frameSections, sectionShift } from '../src/figma/compare.js';
import { outlineLines, unresolvedOf } from '../src/figma/inspect.js';
import { normalizeRestTree, pathOf, summarize } from '../src/figma/snapshot.js';
import { applyIgnore, buildIgnore, splitVnuMessages } from '../src/checks/static.js';
import { suggestWidths } from '../src/tools/figma.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const solid = (r, g, b, a = 1) => ({ kind: 'solid', color: { r, g, b, a } });

function snapshotOf(nodes, root, extra = {}) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map, ...extra };
}

test('null в actions прототипа не валит поведение и токены, а триггер сохраняется', () => {
  const raw = {
    id: '1:1',
    type: 'FRAME',
    name: 'Кадр',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      {
        id: '1:2',
        type: 'FRAME',
        name: 'Кнопка',
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 20 },
        interactions: [
          { trigger: { type: 'ON_HOVER' }, actions: [null] },
          { trigger: { type: 'ON_CLICK' }, actions: [null, { type: 'NODE', navigation: 'OVERLAY', destinationId: '9:9', transition: null }] },
        ],
      },
    ],
  };
  const nodes = normalizeRestTree(raw);
  assert.equal(nodes['1:2'].interactions.length, 2, 'триггер без действия остаётся: элемент интерактивен');
  assert.deepEqual(nodes['1:2'].interactions[0].actions, []);
  assert.equal(nodes['1:2'].interactions[1].actions.length, 1);

  const snapshot = { fileKey: 'KEY', root: '1:1', version: '1', channel: 'rest', nodes };
  const frames = [{ snapshot, rootId: '1:1', ref: 'KEY:1:1', width: 100 }];
  assert.doesNotThrow(() => describeBehavior(frames));
  assert.doesNotThrow(() => collectTokens(frames, { minUses: 1 }));
  assert.equal(describeBehavior(frames).edges, 1);

  /* Старый кэш мог сохранить null как есть — разбор обязан пережить и его. */
  nodes['1:2'].interactions[0].actions = [null];
  assert.doesNotThrow(() => describeBehavior(frames));
});

test('одноцветная иконка несёт свой цвет и в экспорте, и в инвентаре', () => {
  const mono = normalizeSvg('<svg width="24" height="24"><path d="M0 0" fill="#1BCE1B"/></svg>', { prefix: 'ok' });
  assert.equal(mono.monochrome, true);
  assert.equal(mono.color, '#1bce1b');
  const multi = normalizeSvg('<svg width="24" height="24"><path d="M0 0" fill="#111"/><path d="M1 1" fill="#eee"/></svg>');
  assert.equal(multi.color, null);

  const snapshot = snapshotOf(
    [
      { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 200, 200), children: ['1:2'] },
      { id: '1:2', type: 'FRAME', name: 'icon', box: box(0, 0, 24, 24), children: ['1:3'] },
      { id: '1:3', type: 'VECTOR', name: 'Vector', box: box(2, 2, 20, 20), fills: [solid(36, 214, 255)], vectorHash: 'abc' },
    ],
    '1:1',
  );
  const inventory = assetInventory(snapshot, '1:1');
  const icon = inventory.items.find((item) => item.kind === 'svg');
  assert.ok(icon, 'иконка должна попасть в инвентарь');
  assert.equal(icon.color, '#24d6ff');
  assert.match(inventory.note, /color/);
});

test('рендер узла, обрезанного родителем с clip, говорит, сколько видно и с какой стороны', () => {
  const snapshot = snapshotOf(
    [
      { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 1440, 900), children: ['1:2'] },
      { id: '1:2', type: 'FRAME', name: 'Вкладка', box: box(243, 0, 137, 84), clips: true, children: ['1:3'] },
      { id: '1:3', type: 'INSTANCE', name: 'Кнопка', box: box(335, 42, 137, 42) },
    ],
    '1:1',
  );
  const hint = clipHint(snapshot, '1:3');
  assert.ok(hint.clipped, 'обрезка должна быть замечена');
  assert.equal(hint.clipped.by, '1:2');
  assert.equal(hint.clipped.visible, '45x42 из 137x42');
  assert.deepEqual(hint.clipped.sides, ['right']);
  assert.match(hint.clipped.note, /задумка/);

  assert.deepEqual(clipHint(snapshot, '1:2'), {}, 'сам обрезающий фрейм не обрезан');

  const tall = oversizedHint(snapshot.nodes['1:1'], { width: 1440, height: 2300 }, 1);
  assert.equal(tall.oversized.rendered, '1440x2300');
  assert.deepEqual(oversizedHint(snapshot.nodes['1:1'], { width: 1440, height: 905 }, 1), {}, 'допуск 2% не срабатывает');
});

test('путь до узла: с предками от редактора и без них', () => {
  const nodes = [
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 100, 100), children: ['1:2'] },
    { id: '1:2', type: 'FRAME', name: 'Сайдбар', box: box(0, 0, 50, 100), children: ['1:3'] },
    { id: '1:3', type: 'RECTANGLE', name: 'Rectangle 298', box: box(0, 0, 50, 50) },
  ];
  const rest = snapshotOf(nodes, '1:1');
  const deep = pathOf(rest, '1:3');
  assert.equal(deep.path, 'Кадр / Сайдбар / Rectangle 298');
  assert.equal(deep.parent.id, '1:2');
  assert.ok(deep.pathNote, 'без предков корня путь честно начинается с корня');

  const editor = snapshotOf(nodes, '1:1', { ancestors: [{ id: '0:1', name: 'Дизайн', type: 'PAGE' }] });
  assert.equal(pathOf(editor, '1:3').path, 'Дизайн / Кадр / Сайдбар / Rectangle 298');
  assert.equal(pathOf(editor, '1:1').parent.id, '0:1');
  assert.equal(pathOf(editor, '1:1').pathNote, undefined);
  assert.equal(summarize(editor).path, 'Дизайн / Кадр');
});

test('свёрнутые по глубине узлы, иконки без цвета и чужие связи попадают в unresolved', () => {
  const snapshot = snapshotOf(
    [
      { id: '1:1', type: 'FRAME', name: 'Блок', box: box(0, 0, 400, 200), children: ['1:2', '1:5', '1:6'] },
      { id: '1:2', type: 'FRAME', name: 'Пункт', box: box(0, 0, 400, 20), children: ['1:3'] },
      { id: '1:3', type: 'FRAME', name: 'Тире', box: box(0, 0, 14, 14), children: ['1:4'] },
      { id: '1:4', type: 'VECTOR', name: 'dash', box: box(0, 6, 14, 2), fills: [solid(17, 17, 17, 0.5)], vectorHash: 'd' },
      { id: '1:5', type: 'VECTOR', name: 'nocolor', box: box(0, 40, 20, 20), vectorHash: 'n' },
      {
        id: '1:6',
        type: 'FRAME',
        name: 'pdf',
        box: box(0, 80, 40, 40),
        interactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', navigation: 'CHANGE_TO', destinationId: '851:12826' }] }],
      },
    ],
    '1:1',
  );
  const stats = {};
  outlineLines(snapshot, '1:1', { depth: 1, stats });
  assert.equal(stats.collapsed, 1, 'одна ветка свёрнута');
  assert.equal(stats.collapsedNodes, 2, 'за ней два узла');

  const unresolved = unresolvedOf(snapshot, '1:1', { stats, assets: assetInventory(snapshot, '1:1') });
  assert.deepEqual(unresolved.collapsedByDepth, { branches: 1, nodes: 2 });
  assert.equal(unresolved.svgWithoutColor, 1);
  assert.deepEqual(unresolved.interactionsNotSynced, { count: 1, ids: ['851:12826'] });

  const deepStats = {};
  outlineLines(snapshot, '1:1', { depth: 6, stats: deepStats });
  const full = unresolvedOf(snapshot, '1:1', { stats: deepStats, assets: assetInventory(snapshot, '1:1') });
  assert.equal(full.collapsedByDepth, undefined, 'на полной глубине свёрнутого нет');
});

test('секции кадра и сдвиг каждой по её текстам', () => {
  const snapshot = snapshotOf(
    [
      { id: '1:1', type: 'FRAME', name: 'Страница', box: box(0, 0, 1440, 2000), children: ['1:2', '1:3', '1:4'] },
      { id: '1:2', type: 'FRAME', name: 'Хиро', box: box(0, 0, 1440, 800) },
      { id: '1:3', type: 'LINE', name: 'Линия', box: box(0, 800, 1440, 0) },
      { id: '1:4', type: 'FRAME', name: 'Проекты', box: box(0, 900, 1440, 1100) },
    ],
    '1:1',
  );
  const sections = frameSections(snapshot, '1:1');
  assert.deepEqual(
    sections.map((section) => section.name),
    ['Хиро', 'Проекты'],
    'линия нулевой высоты — не секция',
  );
  assert.deepEqual(sections[1].box, { x: 0, y: 900, w: 1440, h: 1100 });

  const pairs = [
    { design: { box: box(100, 950, 300, 40) }, page: { box: box(100, 1030, 300, 40) } },
    { design: { box: box(100, 1200, 300, 40) }, page: { box: box(104, 1282, 300, 40) } },
    { design: { box: box(100, 1500, 300, 40) }, page: { box: box(100, 1900, 300, 40) } },
    { design: { box: box(100, 100, 300, 40) }, page: { box: box(100, 100, 300, 40) } },
  ];
  const shift = sectionShift(sections[1], pairs);
  assert.equal(shift.texts, 3, 'текст из хиро в секцию проектов не попадает');
  assert.equal(shift.shift.y, 82, 'медиана, а не среднее: один уехавший текст секцию не утягивает');
  assert.equal(shift.shift.x, 0);
  assert.deepEqual(sectionShift(sections[0], []), { texts: 0, shift: { x: 0, y: 0 } });
});

test('параллели: даты на одном y при заголовках разной высоты — фиксированная высота', () => {
  const card = (id, titleH, chars) => {
    const nodes = {};
    const root = { id, type: 'INSTANCE', name: 'Книга', box: box(0, 0, 270, 520), children: [`${id}t`, `${id}d`] };
    nodes[id] = root;
    nodes[`${id}t`] = { id: `${id}t`, type: 'TEXT', name: 'title', box: box(0, 400, 270, titleH), item: { sizingV: 'HUG' }, text: { chars } };
    nodes[`${id}d`] = { id: `${id}d`, type: 'TEXT', name: 'date', box: box(0, 489, 270, 20), text: { chars: '2026' } };
    return { node: root, snapshot: { nodes } };
  };
  /* Высота 66 у всех при тексте в одну и в три строки — это фиксированная высота под hug. */
  const parallels = findParallels([card('a', 66, 'Короткий'), card('b', 66, 'Очень длинный заголовок на три строки текста'), card('c', 66, 'Средний заголовок')]);
  assert.equal(parallels.length, 1);
  assert.equal(parallels[0].child, 'date');
  assert.equal(parallels[0].fixedSibling.child, 'title');
  assert.equal(parallels[0].fixedSibling.h, 66);

  /* Одинаковые тексты одинаковой высоты — параллель тривиальна и не показывается. */
  assert.deepEqual(findParallels([card('a', 66, 'Заголовок'), card('b', 66, 'Заголовок')]), []);
});

test('ignore у валидатора убирает соглашения проекта в отдельную корзину', () => {
  const messages = [
    { type: 'error', message: 'Element “modal” not allowed as child of element “div” in this context.' },
    { type: 'error', message: 'Attribute “container” not allowed on element “section” at this point.' },
    { type: 'error', message: 'Bad value “group” for attribute “role” on element “article”.' },
    { type: 'error', message: 'Stray end tag “div”.' },
  ];
  const ignore = { tags: ['modal'], attributes: ['container'], messages: ['Bad value “group” for attribute “role”'] };
  const report = splitVnuMessages(messages, { ignore });
  assert.equal(report.total, 1, 'в total только настоящая ошибка');
  assert.equal(report.ignored.count, 3);
  assert.deepEqual(Object.keys(report.ignored.byRule).sort(), ['attribute:container', 'message:Bad value “group” for attribute “role”', 'tag:modal']);

  assert.deepEqual(splitVnuMessages(messages).ignored, undefined, 'без ignore корзины нет');
  assert.equal(applyIgnore(messages, buildIgnore({ messages: ['(unclosed'] })).kept.length, 4, 'битое выражение читается как подстрока, а не роняет вызов');
});

test('ширины для прогона — из ширин снятых кадров плюс стандартные между ними', () => {
  const result = { files: [{ frames: [{ size: '1440x6000' }, { size: '380x9000' }] }] };
  assert.deepEqual(suggestWidths(result).widths.design, [380, 1440]);
  assert.deepEqual(suggestWidths(result).widths.suggested, [380, 768, 1024, 1280, 1440]);
  assert.deepEqual(suggestWidths({ files: [{ frames: [{ size: '1440x100' }] }] }), {}, 'одна ширина — подсказки нет');
});
