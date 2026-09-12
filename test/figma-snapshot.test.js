/**
 * Снимок макета: нормализация ответа REST, кэш, чтение дерева, выгрузка.
 *
 * Ответ Figma синтетический, но повторяет форму /nodes: мобильный кадр с заголовком, тремя
 * одинаковыми карточками, скрытым слоем, инстансом кнопки и повёрнутым вектором. Именно на таком
 * наборе видно, свернулись ли пункты списка и не потратился ли лишний запрос.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureNodes, findNode, normalizeRestTree, syncFigma } from '../src/figma/snapshot.js';
import { cssItems, outlineLines } from '../src/figma/inspect.js';
import { autoScale, cropImageFill, cropWindow, isCropped, normalizeSvg } from '../src/figma/export.js';

const KEY = 'gBFiSlx3sDctc1zizPYlFS';
const hex = (value) => ({
  r: parseInt(value.slice(1, 3), 16) / 255,
  g: parseInt(value.slice(3, 5), 16) / 255,
  b: parseInt(value.slice(5, 7), 16) / 255,
  a: 1,
});
const box = (x, y, width, height) => ({ x, y, width, height });
const text = (id, chars, y) => ({
  id,
  name: 'Title',
  type: 'TEXT',
  absoluteBoundingBox: box(132, y, 316, 28),
  characters: chars,
  style: { fontFamily: 'Manrope', fontWeight: 700, fontSize: 20, lineHeightPx: 28, lineHeightUnit: 'PIXELS' },
  fills: [{ type: 'SOLID', color: hex('#082344') }],
});
const card = (id, title, y) => ({
  id,
  name: 'Card',
  type: 'FRAME',
  absoluteBoundingBox: box(116, y, 348, 116),
  layoutMode: 'VERTICAL',
  itemSpacing: 8,
  paddingTop: 20,
  paddingRight: 16,
  paddingBottom: 16,
  paddingLeft: 16,
  cornerRadius: 20,
  layoutSizingHorizontal: 'FILL',
  layoutSizingVertical: 'HUG',
  fills: [{ type: 'SOLID', color: hex('#ffffff') }],
  children: [text(`${id}1`, title, y + 20)],
});

const frame = {
  id: '1:1',
  name: 'Mobile',
  type: 'FRAME',
  absoluteBoundingBox: box(100, 0, 380, 2000),
  layoutMode: 'VERTICAL',
  itemSpacing: 16,
  paddingTop: 20,
  paddingRight: 16,
  paddingBottom: 20,
  paddingLeft: 16,
  fills: [{ type: 'SOLID', color: hex('#ffffff') }],
  children: [
    {
      ...text('1:2', 'Вакансии', 20),
      fills: [
        {
          type: 'SOLID',
          color: hex('#082344'),
          boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:299:778' } },
        },
      ],
    },
    card('1:3', 'Хирург', 68),
    card('1:4', 'Терапевт', 200),
    card('1:5', 'Педиатр', 332),
    { id: '1:9', name: 'Hidden', type: 'RECTANGLE', visible: false, absoluteBoundingBox: box(116, 460, 10, 10) },
    {
      id: '1:10',
      name: 'Button',
      type: 'INSTANCE',
      componentId: '5:1',
      componentProperties: { 'State#12:0': { type: 'VARIANT', value: 'Default' } },
      absoluteBoundingBox: box(116, 470, 348, 60),
      interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '9:9', navigation: 'OVERLAY' }] }],
    },
    {
      id: '1:11',
      name: 'Arrow',
      type: 'VECTOR',
      absoluteBoundingBox: box(116, 540, 24, 24),
      relativeTransform: [
        [0, -1, 24],
        [1, 0, 0],
      ],
      layoutPositioning: 'ABSOLUTE',
    },
  ],
};

const response = (version) => ({
  name: 'Земский доктор',
  version,
  lastModified: '2026-09-01T00:00:00Z',
  nodes: {
    '1:1': {
      document: frame,
      components: { '5:1': { key: 'k1', name: 'State=Default', componentSetId: '5:0' } },
      componentSets: { '5:0': { key: 's1', name: 'Button' } },
      styles: {},
    },
    '9:99': null,
  },
});

function fakeClient() {
  const calls = { fileNodes: 0, fileMeta: 0, ids: null };
  const state = { version: '100' };
  return {
    calls,
    state,
    fileNodes: async (key, ids) => {
      calls.fileNodes += 1;
      calls.ids = ids;
      return response(state.version);
    },
    fileMeta: async () => {
      calls.fileMeta += 1;
      return { file: { name: 'Земский доктор', version: state.version } };
    },
  };
}

test('нормализация: раскладка, текст, цвет, инстанс, скрытый слой, поворот', () => {
  const nodes = normalizeRestTree(frame, response('100').nodes['1:1']);
  assert.deepEqual(nodes['1:1'].layout, { mode: 'column', gap: 16, padding: [20, 16, 20, 16], main: 'MIN', cross: 'MIN' });
  assert.deepEqual(nodes['1:31'].text, {
    chars: 'Хирург',
    style: { family: 'Manrope', weight: 700, size: 20, lineHeight: { unit: 'px', value: 28 } },
  });
  assert.deepEqual(nodes['1:31'].fills, [{ kind: 'solid', color: { r: 8, g: 35, b: 68, a: 1 } }]);
  assert.deepEqual(nodes['1:10'].component, {
    id: '5:1',
    name: 'State=Default',
    set: 'Button',
    key: 'k1',
    props: { State: 'Default' },
  });
  assert.equal(nodes['1:9'].visible, false);
  assert.equal(nodes['1:11'].rotation, 90);
  assert.equal(nodes['1:11'].item.absolute, true);
  assert.deepEqual(nodes['1:1'].children, ['1:2', '1:3', '1:4', '1:5', '1:9', '1:10', '1:11']);
});

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-snapshot-'));
let clock = Date.parse('2026-09-11T10:00:00Z');
const now = () => clock;
const api = fakeClient();

test('снятие: один запрос на файл, ненайденный узел назван, повтор из кэша бесплатен', async () => {
  const first = await syncFigma([`${KEY}:1:1`, `https://www.figma.com/design/${KEY}/x?node-id=9-99`], {
    client: api,
    cacheDir,
    now,
  });
  assert.deepEqual(first.requests, { tier1: 1, tier2: 0, tier3: 0 });
  assert.deepEqual(api.calls.ids, ['1:1', '9:99']);
  const file = first.files[0];
  assert.deepEqual(file.notFound, ['9:99']);
  assert.equal(file.frames[0].breakpoint, 'mobile');
  assert.equal(file.frames[0].size, '380x2000');
  assert.equal(file.frames[0].counts.texts, 4);
  assert.equal(file.frames[0].counts.instances, 1);

  const again = await syncFigma([`${KEY}:1:1`], { client: api, cacheDir, now });
  assert.deepEqual(again.requests, { tier1: 0, tier2: 0, tier3: 0 });
  assert.deepEqual(again.files[0].cache.hit, ['1:1']);
});

test('версия сверяется дешёвым запросом, изменившийся макет снимается заново', async () => {
  clock += 11 * 60 * 1000;
  const same = await syncFigma([`${KEY}:1:1`], { client: api, cacheDir, now });
  assert.deepEqual(same.requests, { tier1: 0, tier2: 0, tier3: 1 });

  clock += 11 * 60 * 1000;
  api.state.version = '101';
  const changed = await syncFigma([`${KEY}:1:1`], { client: api, cacheDir, now });
  assert.deepEqual(changed.requests, { tier1: 1, tier2: 0, tier3: 1 });
  assert.deepEqual(changed.files[0].changed, { from: '100', to: '101' });
});

test('узел внутри снятого кадра находится без запросов', async () => {
  const hit = await findNode(KEY, '1:41', { cacheDir });
  assert.equal(hit.node.text.chars, 'Терапевт');
  const { requests } = await ensureNodes(KEY, ['1:41', '1:10'], { client: api, cacheDir });
  assert.equal(requests, null);
});

test('outline: порядок потока, одинаковые карточки свёрнуты с текстами, скрытое не показано', async () => {
  const { snapshot } = await findNode(KEY, '1:1', { cacheDir });
  const lines = outlineLines(snapshot, '1:1');
  assert.match(lines[0], /^1:1 FRAME "Mobile" 0,0 380x2000 \[column gap16 pad20\/16\/20\/16\]$/);
  assert.match(lines[1], /^ {2}1:2 TEXT "Title" 32,20 316x28 «Вакансии» Manrope 20\/700$/);
  assert.match(lines[2], /^ {2}1:3 FRAME "Card" 16,68 348x116 \[column gap8 pad20\/16\/16\/16, w:fill, h:hug\]$/);
  const collapsed = lines.find((line) => line.includes('×2'));
  assert.match(collapsed, /×2 как 1:3: 1:4 «Терапевт», 1:5 «Педиатр»/);
  assert.ok(!lines.some((line) => line.includes('1:4 FRAME')));
  assert.ok(!lines.some((line) => line.includes('Hidden')));
  assert.ok(lines.some((line) => line.includes('<Button / State=Default {State=Default}>') && line.includes('→1')));
  assert.ok(lines.at(-1).includes('1:11 VECTOR') && lines.at(-1).includes('abs'), 'абсолютный ребёнок — в конце потока');
});

test('css: корень раскладкой, повторяющиеся карточки ссылаются на первую', async () => {
  const { snapshot } = await findNode(KEY, '1:1', { cacheDir });
  const items = cssItems(snapshot, '1:1', { depth: 2 });
  /* relative — из-за абсолютного вектора внутри: без него стрелка позиционировалась бы от
     ближайшего предка за пределами кадра. */
  assert.equal(
    items[0].css,
    'position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:16px;width:380px;height:2000px;padding:20px 16px;background:#ffffff',
  );
  assert.match(items.find((item) => item.id === '1:11').css, /^position:absolute;left:16px;top:540px/);
  const first = items.find((item) => item.id === '1:3');
  assert.match(first.css, /align-self:stretch/);
  assert.match(first.css, /border-radius:20px/);
  assert.deepEqual(items.find((item) => item.id === '1:4'), { id: '1:4', level: 1, sameAs: '1:3', text: 'Терапевт' });
});

test('кадрирование заливки по imageTransform совпадает с ручным расчётом', () => {
  /* Иллюстрация сердца из «Вакансий»: в CSS left -33.1%, top -5%, width 166.21%, height 110.8%
     при исходнике 1536×1024. Руками тогда получилось окно 924×924 со смещением (306, 46). */
  const transform = [
    [100 / 166.21, 0, 33.1 / 166.21],
    [0, 100 / 110.8, 5 / 110.8],
  ];
  assert.deepEqual(cropWindow(transform, 1536, 1024), { left: 306, top: 46, width: 924, height: 924 });
  assert.equal(
    cropWindow(
      [
        [0.7, 0.7, 0],
        [-0.7, 0.7, 0],
      ],
      100,
      100,
    ),
    null,
    'поворот кадрированием не выражается',
  );
});

test('STRETCH с матрицей кадрируется по окну, а не растягивается', async () => {
  const sharp = (await import('sharp')).default;
  /* Исходник 200×100: левая половина красная, правая синяя. Окно — правая половина. */
  const source = await sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .composite([{ input: { create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } } }, left: 100, top: 0 }])
    .png()
    .toBuffer();
  const paint = {
    kind: 'image',
    scaleMode: 'STRETCH',
    transform: [
      [0.5, 0, 0.5],
      [0, 1, 0],
    ],
  };
  assert.equal(isCropped(paint), true);
  assert.equal(isCropped({ scaleMode: 'STRETCH' }), false, 'без матрицы это настоящее растяжение');
  const out = await cropImageFill(source, { w: 50, h: 50 }, paint, 1);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 50);
  const [r, , b] = data;
  assert.ok(b > 200 && r < 50, `в кадр должна попасть синяя половина, пришло rgb(${r}, ?, ${b})`);
});

test('SVG: одноцветная иконка получает currentColor, id градиента — префикс', () => {
  const mono = normalizeSvg(
    '<svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg"><path id="p1" d="M1 1" stroke="#082344" stroke-width="1.5"/></svg>',
    { prefix: 'settings' },
  );
  assert.equal(mono.monochrome, true);
  assert.match(mono.svg, /stroke="currentColor"/);
  assert.doesNotMatch(mono.svg, /id="p1"/);
  assert.equal(mono.width, 26);

  const gradient = normalizeSvg(
    '<svg width="20" height="20"><path d="M0 0" fill="url(#paint0_linear)"/><defs><linearGradient id="paint0_linear"><stop stop-color="#D7A84F"/></linearGradient></defs></svg>',
    { prefix: 'kit' },
  );
  assert.equal(gradient.monochrome, false);
  assert.match(gradient.svg, /fill="url\(#kit-paint0_linear\)"/);
  assert.match(gradient.svg, /id="kit-paint0_linear"/);
});

test('канал редактора: без токена снимок бесплатен, переменные и CSS Figma приезжают с узлами', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-editor-'));
  const noToken = {
    usable: async () => false,
    fileNodes: async () => {
      throw new Error('REST не должен вызываться');
    },
  };
  let cssAsked = null;
  const editor = {
    usable: async () => true,
    dump: async (key, ids, { css }) => {
      cssAsked = css;
      return {
        nodes: { '1:1': response('x').nodes['1:1'] },
        notFound: [],
        css: { '1:31': { color: 'rgba(8, 35, 68, 1)' } },
        motion: {},
        motionSupported: true,
        variables: {
          'VariableID:299:778': { name: 'Color 1', type: 'COLOR', collection: 'zem-doc.ru', modes: { 'Mode 1': hex('#082344') } },
          'VariableID:1:1': { name: 'Unused', type: 'COLOR', modes: {} },
        },
      };
    },
  };
  const result = await syncFigma([`${KEY}:1:1`], { client: noToken, editor, cacheDir: dir, now, css: true });
  assert.deepEqual(result.requests, { tier1: 0, tier2: 0, tier3: 0 });
  assert.equal(cssAsked, true);
  assert.equal(result.files[0].channel, 'editor');
  assert.match(result.files[0].version, /^local-/);
  assert.equal(result.files[0].frames[0].variables, 1);

  const { snapshot, node } = await findNode(KEY, '1:31', { cacheDir: dir });
  assert.equal(snapshot.channel, 'editor');
  assert.deepEqual(node.css, { color: 'rgba(8, 35, 68, 1)' });
  assert.deepEqual(Object.keys(snapshot.variables), ['VariableID:299:778'], 'в снимок попадают только используемые переменные');
  assert.equal(snapshot.nodes['1:2'].fills[0].vars.color, 'VariableID:299:778');
});

test('отказ редактора в режиме auto уходит в REST и называет причину', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-fallback-'));
  const editor = {
    usable: async () => true,
    dump: async () => {
      throw new Error('Редактор не отдал window.figma');
    },
  };
  const result = await syncFigma([`${KEY}:1:1`], { client: fakeClient(), editor, cacheDir: dir, now });
  assert.equal(result.files[0].channel, 'rest');
  assert.match(result.files[0].editorFallback, /window\.figma/);
  assert.equal(result.requests.tier1, 1);
});

test('явный канал не подменяется молча', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-explicit-'));
  await assert.rejects(
    syncFigma([`${KEY}:1:1`], { client: fakeClient(), editor: { usable: async () => false }, cacheDir: dir, now, channel: 'editor' }),
    /редактора недоступен/,
  );
  const neither = { usable: async () => false };
  await assert.rejects(syncFigma([`${KEY}:1:1`], { client: neither, editor: null, cacheDir: dir, now }), /ни токена REST/);
});

test('масштаб рендера подбирается под читаемую ширину', () => {
  assert.equal(autoScale(380), 3);
  assert.equal(autoScale(768), 1.5);
  assert.equal(autoScale(1440), 1);
});
