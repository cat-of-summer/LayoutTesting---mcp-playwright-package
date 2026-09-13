/**
 * Сверка оформления с макетом без браузера: страница задана готовым результатом probePage.
 *
 * Главное свойство — бокс находится рядом со своими текстами, даже когда блок выше на странице
 * короче макета и всё ниже съехало. Без этой поправки сверка по месту молчала бы ровно на тех
 * блоках, где расхождений больше всего.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePaint, designItems, designPaint } from '../src/figma/compare.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const solid = (r, g, b, a = 1) => ({ kind: 'solid', color: { r, g, b, a } });

function snapshotOf(nodes, root) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map };
}

const text = (id, chars, at) => ({
  id,
  type: 'TEXT',
  name: chars,
  box: at,
  fills: [solid(0, 0, 0)],
  text: { chars, style: { size: 16, weight: 400 } },
});

const design = designItems(
  snapshotOf(
    [
      { id: '1:1', type: 'FRAME', name: 'Кадр', box: box(0, 0, 1440, 1200), children: ['1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8', '1:9'] },
      text('1:2', 'Ссылка на отчёт', box(120, 200, 300, 24)),
      { id: '1:3', type: 'LINE', name: 'Line 7', box: box(120, 231, 367, 0), strokes: [solid(217, 217, 217)], stroke: { weight: 2 } },
      text('1:4', 'Наш вклад', box(40, 600, 300, 24)),
      { id: '1:5', type: 'RECTANGLE', name: 'bar', box: box(20, 580, 4, 200), fills: [solid(0, 151, 216)] },
      {
        id: '1:6',
        type: 'RECTANGLE',
        name: 'cover',
        box: box(600, 560, 300, 400),
        fills: [solid(255, 255, 255)],
        strokes: [solid(0, 0, 0)],
        stroke: { weight: 1, align: 'INSIDE' },
        radius: 8,
      },
      text('1:7', 'Обложка', box(620, 580, 200, 24)),
      { id: '1:8', type: 'RECTANGLE', name: 'Только в макете', box: box(1000, 1000, 100, 100), fills: [solid(255, 0, 0)] },
      /* Тот же декор на странице есть, но уехал дальше, чем правит поправка по соседнему тексту. */
      { id: '1:9', type: 'RECTANGLE', name: 'Декор внизу', box: box(1100, 1100, 60, 60), fills: [solid(1, 2, 3)] },
    ],
    '1:1',
  ),
  '1:1',
);

const pageBox = (selector, at, { background = null, borders = [0, 0, 0, 0], borderColors, radius = ['0px', '0px', '0px', '0px'] } = {}) => ({
  kind: 'box',
  selector,
  box: at,
  paint: { background, borders, borderColors: borderColors || borders.map(() => 'rgb(0, 0, 0)'), radius },
});
const pageText = (textValue, at) => ({ kind: 'text', text: textValue, selector: `.t-${at.y}`, box: at, style: {} });

/* Верх страницы совпадает с макетом, нижний блок съехал на 50px вверх. */
const page = {
  items: [
    pageText('Ссылка на отчёт', box(120, 200, 300, 24)),
    pageBox('.media__link', box(120, 200, 367, 32), { borders: [0, 0, 1, 0], borderColors: ['', '', 'rgb(217, 217, 217)', ''] }),
    pageText('Наш вклад', box(40, 550, 300, 24)),
    pageBox('.contrib__bar', box(20, 530, 10, 200), { background: 'rgb(0, 151, 216)' }),
    pageText('Обложка', box(620, 530, 200, 24)),
    pageBox('.doc__cover', box(600, 510, 300, 400), { background: 'rgb(255, 255, 255)', radius: ['8px', '8px', '8px', '8px'] }),
    pageBox('.footer__decor', box(1100, 1250, 60, 60), { background: 'rgb(1, 2, 3)' }),
  ],
};

const byNode = (result, id) => result.findings.find((finding) => finding.node === id);

test('линия: толщина обводки сверяется со стороной рамки соседнего блока', () => {
  const result = comparePaint(design, page);
  const line = byNode(result, '1:3');
  assert.ok(line, JSON.stringify(result));
  assert.equal(line.selector, '.media__link');
  assert.deepEqual(line.diffs.thickness, { design: '2px', page: '1px' });
  assert.equal(line.diffs.color, undefined, 'цвет совпал — расхождением не считается');
});

test('полоса находится по месту с поправкой на сдвиг блока и отдаёт разницу ширины', () => {
  const bar = byNode(comparePaint(design, page), '1:5');
  assert.ok(bar);
  assert.equal(bar.selector, '.contrib__bar');
  assert.deepEqual(bar.diffs.thickness, { design: '4px', page: '10px' });
});

test('обводка из макета, которой нет на странице', () => {
  const cover = byNode(comparePaint(design, page), '1:6');
  assert.ok(cover);
  assert.equal(cover.selector, '.doc__cover');
  assert.deepEqual(cover.diffs.border, { design: '1px 1px 1px 1px', page: '0px 0px 0px 0px' });
  assert.equal(cover.diffs.radius, undefined);
  assert.equal(cover.diffs.background, undefined);
});

/*
 * «Не нашёлся здесь» и «не нашёлся нигде» — разные ответы, и лежать они должны врозь.
 *
 * Обе записи раньше попадали в одну кучу под общей оговоркой «возможно, псевдоэлемент»: по ней
 * нельзя решить, идти чинить вёрстку или не идти. Здесь 1:9 на странице есть, а 1:8 не свёрстан
 * вовсе.
 *
 * off — остаток сверх уже применённой поправки, а не расстояние от макетных координат. Соседний
 * текст говорит «здесь всё выше на 50px», сверка ищет узел на 1050 и находит на 1250: сдвиг
 * блока объяснён, а вот эти 200px — нет, и чинить надо их.
 */
test('несопоставленный узел: смещённый отделён от пропавшего', () => {
  const result = comparePaint(design, page);

  assert.deepEqual(result.notFound.map((entry) => entry.node), ['1:8'], JSON.stringify(result.notFound));

  assert.equal(result.shifted.length, 1, JSON.stringify(result.shifted));
  assert.equal(result.shifted[0].node, '1:9');
  assert.equal(result.shifted[0].selector, '.footer__decor', 'у смещённого есть адрес на странице');
  assert.deepEqual(result.shifted[0].off, { x: 0, y: 200 });

  assert.equal(result.boxes, 5);
  assert.equal(result.matched, 3);
});

test('краска: тексты и векторы не сверяются, пустой узел — тоже', () => {
  assert.equal(designPaint({ type: 'TEXT', fills: [solid(0, 0, 0)] }), null);
  assert.equal(designPaint({ type: 'VECTOR', fills: [solid(0, 0, 0)] }), null);
  assert.equal(designPaint({ type: 'FRAME' }), null);
  assert.deepEqual(designPaint({ type: 'FRAME', radius: [4, 4, 0, 0] }).radius, [4, 4, 0, 0]);
});
