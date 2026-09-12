/**
 * Чтение узла: outline, css и полные тексты.
 *
 * Фикстура повторяет узлы, на которых вёрстка лендинга ЕАБР разошлась с макетом: линия, чья
 * толщина живёт только в обводке, приглушённый абзац, узкая декоративная полоса, фотография с
 * прозрачной заливкой и абзац длиннее любой строки дерева. По дереву без краски всё это
 * приходилось угадывать — и угадывалось неверно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { outlineLines, cssItems, textItems, usedVariables } from '../src/figma/inspect.js';
import { paintNotes, paintSummary } from '../src/figma/css.js';
import { collectTokens } from '../src/figma/analyze/tokens.js';
import { inferStructure } from '../src/figma/analyze/structure.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const solid = (r, g, b, a = 1, vars) => ({ kind: 'solid', color: { r, g, b, a }, ...(vars ? { vars } : {}) });

const long = 'Риски для мировой экономики заметно выросли, и банк пересматривает прогноз роста на следующий год';

function snapshotOf(nodes, root, extra = {}) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map, ...extra };
}

const frame = snapshotOf(
  [
    { id: '9:1', type: 'FRAME', name: 'Блок', box: box(0, 0, 1440, 900), children: ['9:2', '9:3', '9:4', '9:5', '9:6', '9:7', '9:8'] },
    {
      id: '9:2',
      type: 'LINE',
      name: 'Line 7',
      box: box(120, 231, 367, 0),
      strokes: [solid(217, 217, 217, 1, { color: 'VariableID:1:2' })],
      stroke: { weight: 1.5, align: 'CENTER' },
    },
    {
      id: '9:3',
      type: 'TEXT',
      name: 'lead',
      box: box(120, 300, 900, 96),
      fills: [solid(0, 0, 0, 0.6)],
      text: { chars: long, style: { family: 'Hanken Grotesk', size: 40, weight: 400 } },
    },
    { id: '9:4', type: 'RECTANGLE', name: 'bar', box: box(0, 0, 4, 850), fills: [solid(0, 151, 216)] },
    {
      id: '9:5',
      type: 'RECTANGLE',
      name: 'photo',
      box: box(0, 0, 1440, 920),
      fills: [{ kind: 'image', ref: 'abc', scaleMode: 'FILL', opacity: 0.6 }],
      effects: [{ type: 'blur', blur: 24 }],
    },
    {
      id: '9:6',
      type: 'RECTANGLE',
      name: 'cover',
      box: box(120, 500, 300, 400),
      fills: [solid(255, 255, 255)],
      strokes: [solid(0, 0, 0, 0.1)],
      stroke: { weights: [0, 0, 3, 0], align: 'INSIDE' },
      radius: [8, 8, 0, 0],
    },
    { id: '9:7', type: 'RECTANGLE', name: 'mask', box: box(0, 0, 100, 100), fills: [solid(0, 0, 0)], isMask: true },
    { id: '9:8', type: 'TEXT', name: 'hidden', visible: false, box: box(0, 0, 10, 10), fills: [solid(0, 0, 0)], text: { chars: 'скрытый', style: { size: 14 } } },
  ],
  '9:1',
  {
    variables: {
      'VariableID:1:2': { name: 'line', type: 'COLOR', modes: { a: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:3' } } },
      'VariableID:1:3': { name: 'grey', type: 'COLOR', modes: { a: { r: 0.85, g: 0.85, b: 0.85 } } },
      'VariableID:9:9': { name: 'unrelated', type: 'COLOR', modes: {} },
    },
  },
);

const lineOf = (lines, id) => lines.find((line) => line.trim().startsWith(`${id} `));

test('outline: у линии видна толщина обводки, хотя высота рамки 0', () => {
  const line = lineOf(outlineLines(frame, '9:1'), '9:2');
  assert.match(line, /367x0/);
  assert.match(line, /\{stroke #d9d9d9 1\.5\}/, line);
});

test('outline: цвет текста, радиус, обводка по сторонам, эффекты и маска', () => {
  const lines = outlineLines(frame, '9:1');
  assert.match(lineOf(lines, '9:3'), /\{color rgba\(0, 0, 0, 0\.6\)\}/);
  assert.match(lineOf(lines, '9:4'), /4x850 \{#0097d8\}/);
  assert.match(lineOf(lines, '9:5'), /\{img op0\.6, blur\(12px\)\}/, 'blur в outline — уже в единицах CSS');
  assert.match(lineOf(lines, '9:6'), /\{#ffffff, stroke rgba\(0, 0, 0, 0\.1\) 0\/0\/3\/0, r8\/8\/0\/0\}/);
  assert.match(lineOf(lines, '9:7'), /mask/);
});

test('paintSummary: узел без краски ничего не добавляет', () => {
  assert.equal(paintSummary({ type: 'FRAME', box: box(0, 0, 10, 10) }), '');
});

test('обрезанные тексты считаются, а mode text отдаёт их целиком', () => {
  const stats = {};
  const lines = outlineLines(frame, '9:1', { stats });
  assert.match(lineOf(lines, '9:3'), /…»/);
  assert.equal(stats.clippedTexts, 1);

  const texts = textItems(frame, '9:1');
  assert.deepEqual(
    texts.map((item) => item.id),
    ['9:3'],
    'скрытый текст без hidden не показывается',
  );
  assert.equal(texts[0].text, long);
  assert.equal(texts[0].color, 'rgba(0, 0, 0, 0.6)');
  assert.equal(texts[0].font, '40/400');
  assert.equal(textItems(frame, '9:1', { hidden: true }).length, 2);
});

test('css: прозрачность картинки и маска не теряются молча', () => {
  const items = cssItems(frame, '9:1', { depth: 1 });
  const photo = items.find((item) => item.id === '9:5');
  assert.match(photo.css, /filter:blur\(12px\)/);
  assert.ok(photo.notes?.some((note) => note.includes('opacity 0.6')), JSON.stringify(photo));
  assert.ok(paintNotes(frame.nodes['9:7'])?.some((note) => note.includes('маска')));
  assert.equal(paintNotes(frame.nodes['9:4']), undefined);
});

test('css: переменные — только те, на которые ссылаются показанные узлы, с алиасами', () => {
  const vars = usedVariables(frame, ['9:2']);
  assert.deepEqual(Object.keys(vars).sort(), ['VariableID:1:2', 'VariableID:1:3']);
  assert.equal(usedVariables(frame, ['9:4']), undefined);
});

test('токены: размытие и прозрачная заливка-картинка попадают в effects даже при одном использовании', () => {
  const tokens = collectTokens([{ snapshot: frame, rootId: '9:1', ref: 'KEY:9:1' }]);
  const values = tokens.effects.map((entry) => entry.value);
  assert.ok(values.includes('filter: blur(12px)'), JSON.stringify(values));
  assert.ok(values.includes('image-fill opacity: 0.6'), JSON.stringify(values));
});

test('структура: считает тексты, обрезанные в строках дерева', () => {
  assert.equal(inferStructure(frame, '9:1').clippedTexts, 1);
});
