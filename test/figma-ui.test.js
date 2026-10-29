/**
 * Разбор панели свойств Figma (канал ui) по снимкам с живого файла. Эталон — значения Plugin API
 * на копии того же файла: панель должна давать то же самое там, где она это показывает.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { box, num, parsePanel, sizing } from '../src/figma/ui.js';

const PANELS = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'fixtures', 'figma-ui', 'panels.json'), 'utf8'));

test('числа, размеры и отступы из текста панели', () => {
  assert.equal(num('1,920px'), 1920);
  assert.equal(num('133.85'), 133.85);
  assert.equal(num('-17px'), -17);
  assert.deepEqual(sizing('Hug (434px)'), { sizing: 'hug', px: 434 });
  assert.deepEqual(sizing('Fill (1,992px)'), { sizing: 'fill', px: 1992 });
  assert.deepEqual(sizing('368px'), { px: 368 });
  assert.deepEqual(box('8px'), [8, 8, 8, 8]);
  assert.deepEqual(box('8px 16px'), [8, 16, 8, 16]);
});

test('auto layout: поток, размеры, отступы и радиус — значения переменных, а не их имена', () => {
  const node = parsePanel(PANELS['frame-autolayout']);
  assert.equal(node.name, 'Frame 3');
  assert.equal(node.kind, 'frame');
  assert.deepEqual(node.size, { w: 434, sizingH: 'hug', h: 229, sizingV: 'hug' });
  assert.deepEqual(node.position, { top: 398, left: 503 });
  assert.deepEqual(node.layout, { flow: 'vertical', padding: [32, 32, 32, 32], gap: 20 });
  assert.equal(node.radius, 24);
  assert.deepEqual(node.fills, [{ color: '#FFFFFF', variable: 'bg/white/primary' }]);
  assert.equal(node.variables.Radius, 'border radius/br-24px');
});

test('текст: содержимое, типографика и цвет', () => {
  const node = parsePanel(PANELS.text);
  assert.equal(node.kind, 'text');
  assert.equal(node.name, 'Подтвердите, что вы не робот');
  assert.deepEqual(node.text, {
    content: 'Подтвердите, что вы не робот',
    style: 'paragraphs/24 bold',
    font: 'Inter',
    weight: 700,
    fontStyle: 'Bold',
    size: 24,
    lineHeight: '130%',
    letterSpacing: '0%',
    color: '#060709',
    colorVariable: 'text/black/primary',
  });
  assert.equal(node.fills, undefined);

  /* Абзацные отступы появляются у многострочного текста — живой снимок 33908:9270. */
  const para = parsePanel({ ...PANELS.text, pairs: [...PANELS.text.pairs, { label: 'Paragraph spacing: 16px' }, { label: 'List spacing: 16px' }] });
  assert.equal(para.text.paragraphSpacing, 16);
  assert.equal(para.text.listSpacing, 16);
  assert.equal(para.unparsed, undefined);
});

test('обводка: толщина, цвет с прозрачностью и сторона выравнивания', () => {
  const node = parsePanel(PANELS['frame-border']);
  assert.deepEqual(node.border, { weight: 3, color: '#FF496C', opacity: 20, sides: 'All sides', align: 'outer' });
  assert.deepEqual(node.size, { w: 60, sizingH: 'fixed', h: 40, sizingV: 'hug' });
  assert.deepEqual(node.layout.padding, [8, 8, 8, 8]);
});

test('картинка: имя файла и позиция от родителя', () => {
  const node = parsePanel(PANELS.image);
  assert.equal(node.kind, 'image');
  assert.equal(node.image, '8164.png');
  assert.deepEqual(node.size, { w: 1584, h: 1057 });
  assert.deepEqual(node.position, { top: -17, left: -72 });
});

test('тени: значения, цвета по порядку и честное «показаны не все»', () => {
  const node = parsePanel(PANELS['component-shadows']);
  assert.equal(node.kind, 'component');
  assert.deepEqual(node.componentProps, { Size: 'L', Preset: 'Text' });
  assert.deepEqual(node.effects, [
    { type: 'drop', x: 0, y: 3, blur: 6, spread: 0, showBehind: true, color: '#000000', opacity: 5 },
    { type: 'drop', x: 0, y: 11, blur: 11, spread: 0, color: '#000000', opacity: 4 },
  ]);
  assert.equal(node.effectStyle, 'shadow/dropdown');
  assert.ok(node.notes.some((n) => /ещё 1/.test(n)));
  assert.deepEqual(node.border, { weight: 1, color: '#D1D4D9', variable: 'stroke/gray/quaternary', sides: 'All sides', align: 'inner' });
  assert.equal(node.text, undefined, 'Size компонента — не кегль');
});

test('отступы по сторонам, Fill и переменная без значения', () => {
  const node = parsePanel(PANELS['padding-sides']);
  assert.deepEqual(node.layout, { flow: 'horizontal', justify: 'space-between', padding: [48, 124, 48, 124] });
  assert.deepEqual(node.size, { w: 1992, sizingH: 'fill', h: 176, sizingV: 'hug' });
  assert.equal(node.radius, null);
  assert.ok(node.notes.some((n) => /br-0px/.test(n)));
});

test('прозрачность, blend и размытие слоя; внутренняя тень', () => {
  const blurred = parsePanel(PANELS['opacity-blend-blur']);
  assert.equal(blurred.opacity, 0.5);
  assert.equal(blurred.blend, 'Hard light');
  assert.deepEqual(blurred.effects, [{ type: 'blur', blur: 133.85 }]);
  assert.deepEqual(blurred.fills, [{ color: '#2A3336' }]);

  const inner = parsePanel(PANELS['inner-shadow']);
  assert.deepEqual(inner.effects, [{ type: 'inner', x: 0, y: 1, blur: 0, spread: 0, color: '#FFFFFF', opacity: 8 }]);
  assert.equal(inner.radius, 32);
});
