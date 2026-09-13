/**
 * Инвентарь ассетов: что скачивать и чем.
 *
 * Проверяется по снимку, без браузера и без Figma: классификация на то и считается по снимку,
 * чтобы решение «svg, картинка или рендер» принималось до траты лимита, а не после.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetInventory } from '../src/figma/assets.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const solid = (r, g, b, a = 1) => ({ kind: 'solid', color: { r, g, b, a } });
const image = (ref, extra = {}) => ({ kind: 'image', ref, scaleMode: 'FILL', ...extra });

function snapshotOf(nodes, root) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map };
}

const inventory = (nodes) => assetInventory(snapshotOf(nodes, '1:1'), '1:1');
const find = (result, id) => result.items.find((item) => item.id === id);

test('вектор — svg, прямоугольник с заливкой — картинка, простая фигура — CSS', () => {
  const result = inventory([
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 1440, 900), children: ['1:2', '1:3', '1:4'] },
    { id: '1:2', type: 'VECTOR', name: 'Стрелка', box: box(0, 0, 16, 16), fills: [solid(0, 0, 0)], vectorHash: 'aaa' },
    { id: '1:3', type: 'RECTANGLE', name: 'Фото', box: box(0, 0, 600, 400), fills: [image('ref-1')] },
    { id: '1:4', type: 'RECTANGLE', name: 'Полоса', box: box(0, 0, 4, 200), fills: [solid(0, 151, 216)] },
  ]);

  assert.equal(find(result, '1:2').kind, 'svg');
  assert.equal(find(result, '1:3').kind, 'image');
  assert.equal(find(result, '1:3').imageRef, 'ref-1');
  assert.equal(find(result, '1:4'), undefined, 'то, что делается CSS, в список на скачивание не попадает');
  assert.ok(result.counts.css >= 1, JSON.stringify(result.counts));
});

/*
 * Тот самый случай, на котором хиро резался прямой границей вместо кривой: как svg фигура
 * приезжает без картинки, как image — прямоугольником без фигурного края.
 */
test('вектор с картинкой внутри требует рендера и говорит почему', () => {
  const result = inventory([
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 1440, 900), children: ['1:2'] },
    { id: '1:2', type: 'VECTOR', name: 'Пшеница', box: box(0, 0, 700, 900), fills: [image('ref-2')], vectorHash: 'bbb' },
  ]);

  const node = find(result, '1:2');
  assert.equal(node.kind, 'render');
  assert.match(node.why, /вектор с картинкой/);
  assert.deepEqual(result.plan.render, ['1:2']);
  assert.match(result.note, /догадка/, 'ответ обязан называть эвристику эвристикой');
});

test('повёрнутое кадрирование — рендер, прямое — обычная картинка', () => {
  const rotated = inventory([
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 400, 400), children: ['1:2'] },
    {
      id: '1:2',
      type: 'RECTANGLE',
      name: 'Сердце',
      box: box(0, 0, 200, 200),
      fills: [image('ref-3', { scaleMode: 'STRETCH', transform: [[0.5, 0.3, 0.1], [0.2, 0.5, 0.2]] })],
    },
  ]);
  assert.equal(find(rotated, '1:2').kind, 'render');
  assert.match(find(rotated, '1:2').why, /поворот/);

  const straight = inventory([
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 400, 400), children: ['1:2'] },
    {
      id: '1:2',
      type: 'RECTANGLE',
      name: 'Обложка',
      box: box(0, 0, 200, 200),
      fills: [image('ref-4', { scaleMode: 'STRETCH', transform: [[0.5, 0, 0.1], [0, 0.5, 0.2]] })],
    },
  ]);
  assert.equal(find(straight, '1:2').kind, 'image');
});

test('одинаковые иконки сводятся в один файл, и в план идёт один представитель', () => {
  const result = inventory([
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 400, 400), children: ['1:2', '1:3', '1:4'] },
    { id: '1:2', type: 'VECTOR', name: 'Шеврон', box: box(0, 0, 8, 17), fills: [solid(0, 0, 0)], vectorHash: 'same' },
    { id: '1:3', type: 'VECTOR', name: 'Шеврон', box: box(50, 0, 8, 17), fills: [solid(0, 0, 0)], vectorHash: 'same' },
    { id: '1:4', type: 'VECTOR', name: 'Шеврон', box: box(90, 0, 8, 17), fills: [solid(0, 0, 0)], vectorHash: 'same' },
  ]);

  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].uses, 3);
  assert.deepEqual(result.plan.svg, ['1:2'], 'заказывается один раз, а не три');
});

/* Без геометрии ключ хуже, и об этом надо сказать, а не сводить молча. */
test('вектор без геометрии сводится по имени и признаётся в этом', () => {
  const result = inventory([
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 400, 400), children: ['1:2', '1:3'] },
    { id: '1:2', type: 'VECTOR', name: 'Логотип', box: box(0, 0, 40, 40), fills: [solid(0, 0, 0)] },
    { id: '1:3', type: 'VECTOR', name: 'Логотип', box: box(80, 0, 40, 40), fills: [solid(0, 0, 0)] },
  ]);

  assert.equal(find(result, '1:2').dedup, 'byName');
  assert.equal(result.duplicates[0].uses, 2);
  assert.match(result.note, /по имени с размером/);
});

test('скрытый узел в список на скачивание не попадает', () => {
  const result = inventory([
    { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 400, 400), children: ['1:2'] },
    { id: '1:2', type: 'VECTOR', name: 'Скрытая', box: box(0, 0, 16, 16), visible: false, fills: [solid(0, 0, 0)], vectorHash: 'ccc' },
  ]);

  assert.equal(result.items.length, 0, 'Figma не рендерит скрытое — заказывать его нечем');
});
