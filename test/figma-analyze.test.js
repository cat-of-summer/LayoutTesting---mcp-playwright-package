/**
 * Разбор макета: структура, компоненты, токены, брейкпоинты, сверка с проектом.
 *
 * Кадр здесь собран из того, на чём разбор ломается в жизни: фон отдельным прямоугольником,
 * карточка, чьи тексты лежат в слоях соседями, декоративный круг за краем, список одинаковых
 * блоков, две кнопки с разной заливкой и третья, у которой радиус на пиксель другой.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferStructure } from '../src/figma/analyze/structure.js';
import { findComponents } from '../src/figma/analyze/components.js';
import { collectTokens } from '../src/figma/analyze/tokens.js';
import { compareBreakpoints, fluid, sameScreen } from '../src/figma/analyze/breakpoints.js';
import { describeBehavior } from '../src/figma/analyze/behavior.js';
import { buildThreads } from '../src/figma/analyze/comments.js';
import { loadProject, matchColor, matchRules, normalizeDecl } from '../src/figma/project.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const solid = (r, g, b, a = 1, vars) => ({ kind: 'solid', color: { r, g, b, a }, ...(vars ? { vars } : {}) });
const text = (id, chars, at, { size = 14, weight = 400, fill = solid(94, 87, 77) } = {}) => ({
  id,
  type: 'TEXT',
  name: chars,
  box: at,
  fills: [fill],
  text: { chars, style: { family: 'Manrope', size, weight, lineHeight: { unit: 'px', value: Math.round(size * 1.4) } } },
});

function snapshotOf(nodes, root, extra = {}) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  /* Как в настоящем снимке: родитель проставляется по спискам детей. */
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map, ...extra };
}

const button = (id, at, { bg = solid(190, 158, 111), radius = 16, label = 'Отправить' } = {}) => [
  {
    id,
    type: 'FRAME',
    name: 'button',
    box: at,
    fills: [bg],
    radius,
    layout: { mode: 'row', gap: 8, padding: [12, 24, 12, 24], main: 'CENTER', cross: 'CENTER' },
    children: [`${id}-t`],
  },
  text(`${id}-t`, label, box(at.x + 24, at.y + 12, 80, 20), { size: 16, weight: 700, fill: solid(255, 255, 255) }),
];

/* Кадр без auto-layout: фон, карточка с «соседними» текстами, декор за краем, список. */
const page = snapshotOf(
  [
    { id: '1:1', type: 'FRAME', name: 'Вакансии', box: box(0, 0, 400, 800), children: ['1:2', '1:3', '1:4', '1:5', '1:9', '1:20'] },
    { id: '1:2', type: 'RECTANGLE', name: 'bg', box: box(0, 0, 400, 800), fills: [solid(255, 255, 255)] },
    { id: '1:3', type: 'RECTANGLE', name: 'card', box: box(20, 100, 360, 120), fills: [solid(249, 244, 239)], radius: 16 },
    text('1:4', 'Открытые вакансии', box(40, 120, 200, 32), { size: 24, weight: 700, fill: solid(8, 35, 68) }),
    text('1:5', 'Описание вакансии длиной побольше тридцати символов', box(40, 160, 300, 40)),
    { id: '1:9', type: 'ELLIPSE', name: 'blob', box: box(-80, 700, 200, 200), fills: [solid(190, 158, 111, 0.06)] },
    {
      id: '1:20',
      type: 'FRAME',
      name: 'Список',
      box: box(20, 260, 360, 300),
      layout: { mode: 'column', gap: 12, padding: [0, 0, 0, 0], main: 'MIN', cross: 'MIN' },
      children: ['1:21', '1:23', '1:25'],
    },
    ...['1:21', '1:23', '1:25'].flatMap((id, index) => [
      {
        id,
        type: 'FRAME',
        name: 'item',
        box: box(20, 260 + index * 100, 360, 88),
        fills: [solid(255, 255, 255)],
        radius: 20,
        layout: { mode: 'row', gap: 12, padding: [16, 16, 16, 16], main: 'MIN', cross: 'CENTER' },
        children: [`${id}-t`],
      },
      text(`${id}-t`, ['Хирург', 'Терапевт', 'Педиатр'][index], box(36, 280 + index * 100, 200, 24), { size: 16, weight: 700 }),
    ]),
  ],
  '1:1',
);

test('структура: фон, переподчинение, декор и список', () => {
  const result = inferStructure(page, '1:1');
  const lines = result.lines.join('\n');
  const kinds = result.notes.map((note) => note.kind);

  assert.ok(kinds.includes('background'), `фон не найден: ${JSON.stringify(result.notes)}`);
  assert.ok(kinds.includes('reparented'), 'тексты, нарисованные внутри карточки, не переподчинены');
  assert.ok(kinds.includes('decor'), 'круг за краем кадра не отмечен декором');

  const reparented = result.notes.find((note) => note.kind === 'reparented');
  assert.deepEqual(reparented.ids, ['1:4', '1:5']);
  assert.equal(reparented.into, '1:3');

  assert.match(lines, /h1\.[\w-]+ 1:4 «Открытые вакансии»/, 'крупный жирный текст должен стать заголовком');
  assert.match(lines, /p\.[\w-]+ 1:5/, 'длинный текст — абзац');
  assert.match(lines, /ul\.[\w-]+ 1:20/, 'три одинаковых блока — список');
  assert.match(lines, /li\.[\w-]+ 1:21/, 'элементы списка — li');
  assert.match(lines, /×2 как 1:21: 1:23 «Терапевт», 1:25 «Педиатр»/, 'повторы должны сворачиваться');
  assert.ok(result.slots.lists.some((slot) => slot.id === '1:20' && slot.items === 3), 'список не попал в слоты контента');
});

test('структура: раскладка обычного фрейма выводится по зазорам', () => {
  const result = inferStructure(page, '1:1');
  const card = result.lines.find((line) => line.includes('1:3'));
  assert.match(card, /\[column gap8/, `внутри карточки колонка с зазором: ${card}`);
});

const buttons = snapshotOf(
  [
    { id: '2:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 400, 400), layout: { mode: 'column', gap: 20, padding: [0, 0, 0, 0], main: 'MIN', cross: 'MIN' }, children: ['2:10', '2:20', '2:30'] },
    ...button('2:10', box(0, 0, 200, 44)),
    ...button('2:20', box(0, 64, 200, 44), { bg: solid(255, 255, 255), label: 'Отмена' }),
    ...button('2:30', box(0, 128, 200, 44), { radius: 17 }),
  ],
  '2:1',
);

test('компоненты: одинаковые по составу кнопки — один блок с модификатором и дрейфом', () => {
  const { clusters } = findComponents([{ snapshot: buttons, rootId: '2:1', ref: 'KEY:2:1' }]);
  const cluster = clusters.find((entry) => entry.role === 'button');
  assert.ok(cluster, `кнопки не сгруппированы: ${JSON.stringify(clusters.map((c) => c.role))}`);
  assert.equal(cluster.count, 3);
  assert.equal(cluster.block, 'button');

  const modifiers = cluster.variants.map((variant) => variant.modifier);
  assert.ok(modifiers.includes('base'), 'нет базового варианта');
  assert.ok(cluster.variants.some((variant) => variant.differs?.bg), 'другая заливка должна стать модификатором');
  assert.ok(cluster.drift?.some((entry) => entry.prop === 'radius'), `радиус на пиксель — это дрейф: ${JSON.stringify(cluster.drift)}`);
});

const tokenFrame = snapshotOf(
  [
    { id: '3:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 400, 400), layout: { mode: 'column', gap: 24, padding: [16, 16, 16, 16], main: 'MIN', cross: 'MIN' }, children: ['3:2', '3:5'] },
    { id: '3:5', type: 'FRAME', name: 'Строки', box: box(16, 60, 368, 120), layout: { mode: 'column', gap: 24, padding: [0, 0, 0, 0], main: 'MIN', cross: 'MIN' }, children: ['3:3', '3:4'] },
    text('3:2', 'Первый', box(16, 20, 200, 20), { fill: solid(94, 87, 77, 1, { color: 'VariableID:1:1' }) }),
    text('3:3', 'Второй', box(16, 64, 200, 20), { fill: solid(94, 87, 77) }),
    text('3:4', 'Третий', box(16, 108, 200, 20), { fill: solid(95, 87, 77) }),
  ],
  '3:1',
  { variables: { 'VariableID:1:1': { name: 'Color 3', type: 'COLOR', collection: 'zem', modes: {} } } },
);

test('токены: неразличимые цвета сводятся, литералы при живой переменной считаются', () => {
  const tokens = collectTokens([{ snapshot: tokenFrame, rootId: '3:1', ref: 'KEY:3:1' }]);
  const color = tokens.colors.find((entry) => entry.name === '--color-3');
  assert.ok(color, `цвет не получил имя переменной Figma: ${JSON.stringify(tokens.colors)}`);
  assert.equal(color.uses, 3, '#5e574d и #5f574d — один токен');
  assert.equal(color.unbound, 2, 'два использования вбиты литералом при живой переменной');
  assert.deepEqual(color.merged, ['#5f574d']);

  assert.ok(tokens.spacing.values.some((entry) => entry.value === '24px'), 'зазор не стал токеном отступа');
  assert.ok(tokens.spacing.values.some((entry) => entry.value === '16px'));
  assert.equal(tokens.spacing.step, 8, 'шаг сетки отступов — 8');
});

const wide = snapshotOf(
  [
    { id: '4:1', type: 'FRAME', name: 'Экран', box: box(0, 0, 1200, 800), layout: { mode: 'column', gap: 40, padding: [0, 0, 0, 0], main: 'MIN', cross: 'MIN' }, children: ['4:2', '4:3', '4:4'] },
    text('4:2', 'Открытые вакансии', box(0, 0, 600, 48), { size: 40, weight: 700 }),
    text('4:3', 'Специальность', box(0, 60, 260, 24), { size: 16 }),
    text('4:4', 'Только десктоп', box(0, 100, 260, 24), { size: 16 }),
  ],
  '4:1',
);
const narrow = snapshotOf(
  [
    { id: '5:1', type: 'FRAME', name: 'Экран mobile', box: box(0, 0, 380, 900), layout: { mode: 'column', gap: 16, padding: [0, 0, 0, 0], main: 'MIN', cross: 'MIN' }, children: ['5:2', '5:3'] },
    text('5:2', 'Открытые вакансии', box(0, 0, 340, 32), { size: 24, weight: 700 }),
    text('5:3', 'Специальность', box(0, 40, 340, 24), { size: 16 }),
  ],
  '5:1',
);

test('брейкпоинты: элементы сопоставлены по содержимому, разница даёт clamp', () => {
  const report = compareBreakpoints([
    { snapshot: wide, rootId: '4:1', ref: 'KEY:4:1', width: 1200, name: 'Экран' },
    { snapshot: narrow, rootId: '5:1', ref: 'KEY:5:1', width: 380, name: 'Экран mobile' },
  ]);
  const comparison = report.comparisons[0];
  assert.equal(comparison.matched, 2, 'совпасть должны два текста из трёх');

  const heading = comparison.changes.find((change) => change.label === 'Открытые вакансии');
  assert.equal(heading.changes['font-size'].from, '40px');
  assert.equal(heading.changes['font-size'].to, '24px');
  assert.match(heading.changes['font-size'].fluid, /^clamp\(24px, calc\(.*vw\), 40px\)$/);

  assert.deepEqual(comparison.onlyBase.map((item) => item.label), ['Только десктоп']);
  assert.equal(comparison.order.length, 0, 'порядок чтения совпадает');
});

test('брейкпоинты: модалка не выдаётся за другую ширину того же экрана', () => {
  const modal = snapshotOf(
    [
      { id: '6:1', type: 'FRAME', name: 'Модалка', box: box(0, 0, 590, 588), layout: { mode: 'column', gap: 12, padding: [0, 0, 0, 0], main: 'MIN', cross: 'MIN' }, children: ['6:2'] },
      text('6:2', 'Ваше имя', box(0, 0, 200, 24)),
    ],
    '6:1',
  );
  const { group, apart } = sameScreen([
    { snapshot: wide, rootId: '4:1', ref: 'KEY:4:1', width: 1200 },
    { snapshot: narrow, rootId: '5:1', ref: 'KEY:5:1', width: 380 },
    { snapshot: modal, rootId: '6:1', ref: 'KEY:6:1', width: 590 },
  ]);
  assert.deepEqual(group.map((frame) => frame.ref), ['KEY:4:1', 'KEY:5:1']);
  assert.deepEqual(apart.map((frame) => frame.ref), ['KEY:6:1']);
});

test('линейное изменение превращается в clamp, скачок — нет', () => {
  assert.equal(fluid('40px', 1200, '24px', 380), 'clamp(24px, calc(16.59px + 1.951vw), 40px)');
  assert.equal(fluid('40px', 1200, '40px', 380), null);
  assert.equal(fluid('row', 1200, 'column', 380), null);
});

const CSS = `
:root { --brand: #be9e6f; --space-md: 16px; }
.search-page__form { display: flex; align-items: center; gap: 12px; background-color: #fff; padding: 10px 16px 10px 24px; border-radius: 20px; }
.vacancy__title { color: #5e574d; font-size: 24px; font-weight: 700; }
@media (max-width: 767px) { .search-page__form { padding-left: 16px; } }
`;

test('сверка с проектом: правило узнаётся по набору свойств', async () => {
  const project = await loadProject({ css: CSS });
  assert.equal(project.vars.length, 2);

  const figma = [
    ['display', 'flex'],
    ['align-items', 'center'],
    ['gap', '12px'],
    ['background', '#ffffff'],
    ['padding', '10px 16px 11px 24px'],
    ['border-radius', '20px'],
  ];
  const [best] = matchRules(project, figma);
  assert.equal(best.selector, '.search-page__form');
  assert.ok(best.score >= 0.8, `совпадение должно быть уверенным: ${JSON.stringify(best)}`);
});

test('сверка с проектом: цвет находится и в переменной, и в правилах', async () => {
  const project = await loadProject({ css: CSS, scss: '$gold: #be9e6f;\n$text: $gold;' });
  const brand = matchColor(project, { r: 190, g: 158, b: 111, a: 1 });
  assert.ok(brand.exact.includes('--brand'));
  assert.ok(brand.exact.includes('$gold'), 'переменные SCSS тоже учитываются');
  assert.ok(brand.exact.includes('$text'), 'ссылка $text: $gold раскрывается');

  const textColor = matchColor(project, { r: 94, g: 87, b: 77, a: 1 });
  assert.deepEqual(textColor.exact, []);
  assert.deepEqual(textColor.selectors, ['.vacancy__title'], 'цвет без переменной ищется по правилам');
});

test('сокращения раскрываются перед сравнением', () => {
  assert.deepEqual(normalizeDecl('padding', '10px 16px'), [
    ['padding-top', 10],
    ['padding-right', 16],
    ['padding-bottom', 10],
    ['padding-left', 16],
  ]);
  assert.deepEqual(normalizeDecl('gap', '12px'), [
    ['row-gap', 12],
    ['column-gap', 12],
  ]);
  assert.deepEqual(normalizeDecl('background', '#fff center / cover no-repeat'), [['background-color', { r: 255, g: 255, b: 255, a: 1 }]]);
});

const proto = snapshotOf(
  [
    {
      id: '7:1',
      type: 'FRAME',
      name: 'Вакансии',
      box: box(0, 0, 1440, 900),
      layout: { mode: 'column', gap: 20, padding: [0, 0, 0, 0], main: 'MIN', cross: 'MIN' },
      children: ['7:2', '7:3', '7:4', '7:5', '7:6', '7:7', '7:9'],
    },
    ...['7:2', '7:3', '7:4'].map((id) => ({
      id,
      type: 'INSTANCE',
      name: 'Chevron right',
      box: box(0, 0, 24, 24),
      component: { id: '9:1', set: 'Chevron', name: 'right' },
      interactions: [
        {
          trigger: { type: 'ON_CLICK' },
          actions: [
            {
              type: 'NODE',
              navigation: 'CHANGE_TO',
              destinationId: '8:1',
              transition: { type: 'SMART_ANIMATE', duration: 0.4, easing: { type: 'EASE_OUT' } },
            },
          ],
        },
      ],
    })),
    {
      id: '7:5',
      type: 'FRAME',
      name: 'Откликнуться',
      box: box(0, 100, 200, 60),
      interactions: [
        {
          trigger: { type: 'ON_CLICK' },
          actions: [{ type: 'NODE', navigation: 'OVERLAY', destinationId: '7:9', transition: { type: 'DISSOLVE', duration: 0.3, easing: { type: 'EASE_IN_AND_OUT' } } }],
        },
      ],
    },
    {
      id: '7:9',
      type: 'FRAME',
      name: 'модалОчка',
      box: box(400, 200, 590, 588),
      overlay: { position: 'CENTER', background: 'SOLID_COLOR', interaction: 'CLOSE_ON_CLICK_OUTSIDE' },
    },
    { id: '7:6', type: 'FRAME', name: 'menu', box: box(0, 0, 1440, 110), scrollBehavior: 'FIXED' },
    { id: '7:7', type: 'FRAME', name: 'Карточка hover', box: box(0, 300, 300, 100) },
  ],
  '7:1',
);

test('поведение: одинаковые связи сводятся в один обработчик, оверлей описан', () => {
  const behavior = describeBehavior([{ snapshot: proto, rootId: '7:1', ref: 'KEY:7:1' }]);
  assert.equal(behavior.edges, 4);

  const variant = behavior.states[0];
  assert.equal(variant.count, 3, 'три одинаковых шеврона — один обработчик');
  assert.equal(variant.to, '8:1');
  assert.equal(variant.transition.css, 'transition: изменившиеся свойства 400ms ease-out');

  const overlay = behavior.overlays[0];
  assert.equal(overlay.to, '7:9');
  assert.equal(overlay.toName, 'модалОчка');
  assert.equal(overlay.overlay.interaction, 'CLOSE_ON_CLICK_OUTSIDE');
  assert.match(overlay.transition.css, /transition: opacity 300ms ease-in-out/);

  assert.deepEqual(behavior.sticky, [{ id: '7:6', name: 'menu', behavior: 'FIXED', css: 'position: fixed' }]);
  assert.ok(
    behavior.unconfirmed.nodes.some((node) => node.id === '7:7'),
    'слой с hover в имени и без связей должен попасть в неподтверждённые',
  );
});

test('комментарии: треды с ответами, привязка к узлу и к точке холста', () => {
  const comments = [
    { id: 'c1', created_at: '2026-09-10T10:00:00Z', user: { handle: 'designer' }, message: 'Поправить отступ', client_meta: { node_id: '1:3', node_offset: { x: 4, y: 4 } } },
    { id: 'c2', created_at: '2026-09-10T11:00:00Z', user: { handle: 'dev' }, message: 'Сделано', parent_id: 'c1' },
    { id: 'c3', created_at: '2026-09-09T10:00:00Z', user: { handle: 'pm' }, message: 'Закрытый вопрос', resolved_at: '2026-09-09T12:00:00Z', client_meta: { x: 60, y: 300 } },
    { id: 'c4', created_at: '2026-09-08T10:00:00Z', user: { handle: 'pm' }, message: 'На холсте', client_meta: { x: 60, y: 300 } },
  ];
  const frames = [{ snapshot: page, rootId: '1:1', ref: 'KEY:1:1' }];

  const open = buildThreads(comments, frames);
  assert.deepEqual(open.map((thread) => thread.id), ['c1', 'c4'], 'закрытый тред по умолчанию скрыт, ответ не отдельный тред');
  assert.equal(open[0].replies[0].message, 'Сделано');
  assert.equal(open[0].anchor.node, '1:3');
  assert.match(open[0].anchor.path, /Вакансии \/ card/);
  assert.equal(open[1].anchor.node, '1:21-t', 'комментарий точкой привязан к самому глубокому узлу под ней');
  assert.equal(open[1].anchor.by, 'точке на холсте');

  assert.equal(buildThreads(comments, frames, { resolved: true }).length, 3);
});
