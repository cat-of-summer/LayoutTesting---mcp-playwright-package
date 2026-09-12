/**
 * Конвертация узла снимка в CSS.
 *
 * Самые дорогие ошибки здесь тихие: градиент с неверными остановками и FILL, переписанный в
 * фиксированную ширину, выглядят правдоподобно и совпадают с макетом ровно на его ширине.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundValue, boxShorthand, colorCss, linearGradientCss, nodeCss } from '../src/figma/css.js';

const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 255, g: 255, b: 255, a: 1 };
const decl = (decls, prop) => decls.find(([p]) => p === prop)?.[1];

test('цвет: непрозрачный — hex, полупрозрачный — rgba', () => {
  assert.equal(colorCss({ r: 8, g: 35, b: 68, a: 1 }), '#082344');
  assert.equal(colorCss({ r: 94, g: 87, b: 77, a: 0.4 }), 'rgba(94, 87, 77, 0.4)');
});

test('линейный градиент: направление из ручек', () => {
  const stops = [
    { color: white, pos: 0 },
    { color: black, pos: 1 },
  ];
  const down = { handles: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 0 }], stops };
  assert.equal(linearGradientCss(down, 300, 100), 'linear-gradient(180deg, #ffffff 0%, #000000 100%)');

  const right = { handles: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 0 }], stops };
  assert.equal(linearGradientCss(right, 300, 100), 'linear-gradient(90deg, #ffffff 0%, #000000 100%)');
});

test('линейный градиент: остановки проецируются на линию CSS, а не копируются', () => {
  const stops = [
    { color: white, pos: 0 },
    { color: black, pos: 1 },
  ];
  /* Диагональ неквадратного блока: угол не 135°, а остановки по-прежнему по краям. */
  const diagonal = { handles: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }], stops };
  assert.equal(linearGradientCss(diagonal, 200, 100), 'linear-gradient(116.57deg, #ffffff 0%, #000000 100%)');

  /* Градиент на средней половине блока: в CSS это 25% и 75%. */
  const middle = { handles: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }, { x: 0, y: 0 }], stops };
  assert.equal(linearGradientCss(middle, 400, 100), 'linear-gradient(90deg, #ffffff 25%, #000000 75%)');
});

test('несколько заливок: порядок слоёв развёрнут, сплошной цвет сверху — вырожденный градиент', () => {
  const value = backgroundValue(
    [
      { kind: 'solid', color: white },
      { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 0.5 } },
    ],
    { w: 10, h: 10 },
  );
  assert.equal(value, 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), #ffffff');
});

test('сокращения отступов', () => {
  assert.equal(boxShorthand([0, 0, 0, 0]), null);
  assert.equal(boxShorthand([8, 8, 8, 8]), '8px');
  assert.equal(boxShorthand([8, 16, 8, 16]), '8px 16px');
  assert.equal(boxShorthand([10, 16, 11, 16]), '10px 16px 11px');
  assert.equal(boxShorthand([10, 16, 11, 24]), '10px 16px 11px 24px');
});

test('auto-layout превращается во flex с gap и padding', () => {
  const node = {
    type: 'FRAME',
    box: { x: 0, y: 0, w: 1148, h: 48 },
    layout: { mode: 'row', gap: 12, padding: [10, 16, 11, 24], main: 'CENTER', cross: 'CENTER' },
    item: { sizingH: 'FIXED', sizingV: 'HUG' },
    radius: 20,
    fills: [{ kind: 'solid', color: white }],
  };
  const css = nodeCss(node);
  assert.equal(decl(css, 'display'), 'flex');
  assert.equal(decl(css, 'justify-content'), 'center');
  assert.equal(decl(css, 'align-items'), 'center');
  assert.equal(decl(css, 'gap'), '12px');
  assert.equal(decl(css, 'padding'), '10px 16px 11px 24px');
  assert.equal(decl(css, 'width'), '1148px');
  assert.equal(decl(css, 'height'), undefined, 'HUG не даёт размера');
  assert.equal(decl(css, 'border-radius'), '20px');
  assert.equal(decl(css, 'background'), '#ffffff');
});

test('FILL и HUG переводятся в намерение, а не в числа', () => {
  const parent = { type: 'FRAME', box: { x: 0, y: 0, w: 500, h: 50 }, layout: { mode: 'row', gap: 0 } };
  const fill = nodeCss(
    { type: 'FRAME', box: { x: 0, y: 0, w: 380, h: 50 }, item: { sizingH: 'FILL', sizingV: 'FILL' } },
    { parent },
  );
  assert.equal(decl(fill, 'flex'), '1 1 0');
  assert.equal(decl(fill, 'align-self'), 'stretch');
  assert.equal(decl(fill, 'width'), undefined);

  const fixed = nodeCss(
    { type: 'FRAME', box: { x: 380, y: 0, w: 120, h: 50 }, item: { sizingH: 'FIXED', sizingV: 'FIXED' } },
    { parent },
  );
  assert.equal(decl(fixed, 'width'), '120px');
  assert.equal(decl(fixed, 'flex-shrink'), '0');
});

test('ребёнок обычного фрейма позиционируется абсолютно, родитель получает relative', () => {
  const parent = { type: 'FRAME', box: { x: 100, y: 200, w: 400, h: 300 } };
  const child = { type: 'RECTANGLE', box: { x: 120, y: 230, w: 50, h: 50 }, visible: true };
  const css = nodeCss(child, { parent });
  assert.equal(decl(css, 'position'), 'absolute');
  assert.equal(decl(css, 'left'), '20px');
  assert.equal(decl(css, 'top'), '30px');
  assert.equal(decl(nodeCss(parent, { children: [child] }), 'position'), 'relative');
});

test('текст: типографика и цвет, размер по autoResize', () => {
  const css = nodeCss({
    type: 'TEXT',
    box: { x: 0, y: 0, w: 300, h: 28 },
    fills: [{ kind: 'solid', color: { r: 94, g: 87, b: 77, a: 0.4 } }],
    text: {
      chars: 'Поиск',
      autoResize: 'WIDTH_AND_HEIGHT',
      style: { family: 'Manrope', size: 20, weight: 600, lineHeight: { unit: 'px', value: 28 }, case: 'UPPER' },
    },
  });
  assert.equal(decl(css, 'color'), 'rgba(94, 87, 77, 0.4)');
  assert.equal(decl(css, 'font-family'), 'Manrope');
  assert.equal(decl(css, 'font-size'), '20px');
  assert.equal(decl(css, 'font-weight'), '600');
  assert.equal(decl(css, 'line-height'), '28px');
  assert.equal(decl(css, 'text-transform'), 'uppercase');
  assert.equal(decl(css, 'width'), undefined);
});

test('обводка снаружи и тень складываются в один box-shadow', () => {
  const css = nodeCss({
    type: 'FRAME',
    box: { x: 0, y: 0, w: 100, h: 100 },
    strokes: [{ kind: 'solid', color: black }],
    stroke: { weight: 2, align: 'OUTSIDE' },
    effects: [{ type: 'drop', x: 0, y: 4, blur: 16, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } }],
  });
  assert.equal(decl(css, 'box-shadow'), '0 0 0 2px #000000, 0 4px 16px rgba(0, 0, 0, 0.25)');
  assert.equal(decl(css, 'border'), undefined);
});

test('размытие делится пополам, как понимает filter', () => {
  const css = nodeCss({ type: 'FRAME', box: { x: 0, y: 0, w: 10, h: 10 }, effects: [{ type: 'blur', blur: 8 }] });
  assert.equal(decl(css, 'filter'), 'blur(4px)');
});
