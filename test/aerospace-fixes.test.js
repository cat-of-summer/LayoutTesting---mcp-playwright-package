/**
 * Правки по разбору контрольной точки одного лендинга: то, что стенд мог поймать сам.
 *
 * Шапка при открытом меню уезжала на 60px, а сверять два состояния страницы было нечем. Шаг
 * ссылок подвала на мобильном был 32 вместо 40, и сверка показывала растущий сдвиг у каждой
 * ссылки вместо одной причины. Мобильный кадр не сверялся ни разу, и покрытие этого не видело.
 * Ошибки форм — маска без input, дёргающаяся ошибка, наложение — жили между конечными точками.
 * Здесь всё, что считается без браузера: по снимку, по готовым замерам и по чистым функциям.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findStepDrift, designItems, comparePaint } from '../src/figma/compare.js';
import { collapseSteps, measureSpacing } from '../src/figma/spacing.js';
import { browserChrome } from '../src/figma/analyze/common.js';
import { buildThreads } from '../src/figma/analyze/comments.js';
import { svgFromGeometry, geometryFromRest } from '../src/figma/export.js';
import { noteCoverage, rememberScreens, screenReason, suggestWidths } from '../src/tools/figma.js';
import { diffBoxes } from '../src/browser/boxes.js';
import { findJitter, judgeStep, sampleFor, hasInvalidSample } from '../src/checks/forms.js';
import { admitted, withDeadline } from '../src/figma/editor.js';
import { logged } from '../src/protocol.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const text = (id, chars, b, extra = {}) => ({ id, type: 'TEXT', name: chars, box: b, text: { chars, style: { size: 16 } }, ...extra });

function snapshotOf(nodes, root, extra = {}) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map, ...extra };
}

/* Пара «макет ↔ страница» в том виде, в каком её отдаёт pairTexts. */
const pair = (id, textValue, dy, py, x = 20) => ({
  design: { id, text: textValue, box: box(x, dy, 100, 16) },
  page: { text: textValue, selector: `a.${id}`, box: box(x, py, 100, 16) },
});

test('разный шаг в колонке — одна находка stepDrift, а не восемь сдвигов', () => {
  const pairs = Array.from({ length: 8 }, (_, i) => pair(`n${i}`, `Ссылка ${i}`, 100 + i * 40, 100 + i * 32));
  const drifts = findStepDrift(pairs);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].designStep, 40);
  assert.equal(drifts[0].pageStep, 32);
  assert.equal(drifts[0].delta, -8);
  assert.equal(drifts[0].nodes.length, 8);
  assert.match(drifts[0].stepDrift, /шаг в макете 40px, на странице 32px/);
});

test('одинаковый шаг и общий сдвиг блока stepDrift не дают', () => {
  const same = Array.from({ length: 5 }, (_, i) => pair(`s${i}`, `Пункт ${i}`, 100 + i * 40, 160 + i * 40));
  assert.deepEqual(findStepDrift(same), [], 'сдвиг на 60 у всех — это shiftedBlock, не шаг');
  const two = [pair('a', 'A', 0, 0), pair('b', 'B', 40, 32)];
  assert.deepEqual(findStepDrift(two), [], 'двух элементов мало для серии');
});

test('интервалы: источник — gap родителя, повторяющийся шаг сворачивается', () => {
  const kids = Array.from({ length: 4 }, (_, i) => `l${i}`);
  const snapshot = snapshotOf(
    [
      { id: 'nav', type: 'FRAME', name: 'Навигация', box: box(0, 0, 200, 300), layout: { mode: 'column', gap: 24, padding: [0, 0, 0, 0] }, children: kids },
      ...kids.map((id, i) => text(id, `Пункт ${i}`, box(0, i * 40, 100, 16))),
    ],
    'nav',
  );
  const probed = {
    origin: { w: 200, h: 300 },
    items: kids.map((id, i) => ({ kind: 'text', text: `Пункт ${i}`, selector: `li:nth-child(${i + 1}) a`, box: box(0, i * 32, 100, 16), style: {} })),
  };
  const spacing = measureSpacing(snapshot, 'nav', probed);
  assert.equal(spacing.rows.length, 3);
  assert.equal(spacing.off.length, 3);
  assert.equal(spacing.off[0].designGap, 24);
  assert.deepEqual(spacing.off[0].textToText, { design: 24, page: 16 });
  assert.match(spacing.off[0].source, /gap 24 у «Навигация»/);
  assert.equal(spacing.steps.length, 1);
  assert.match(spacing.steps[0].step, /шаг 24 → 16, ×3/);
});

test('collapseSteps не склеивает разные интервалы', () => {
  const row = (parent, d, p) => ({ parent, between: ['a', 'b'], textToText: { design: d, page: p }, source: '' });
  assert.deepEqual(collapseSteps([row('x', 60, 20), row('x', 24, 16)]), []);
});

test('ширины для прогона — только по экранам; тексты и холсты уходят в ignored', () => {
  const result = {
    files: [
      {
        frames: [
          { ref: 'K:1:1', name: 'Главная', type: 'FRAME', size: '1440x6000' },
          { ref: 'K:2:1', name: 'Главная моб', type: 'FRAME', size: '380x9000' },
          { ref: 'K:3:1', name: 'Подпись', type: 'TEXT', size: '52x20' },
          { ref: 'K:4:1', name: 'Объяснение', type: 'SECTION', size: '5273x3000' },
        ],
      },
    ],
  };
  const { widths } = suggestWidths(result);
  assert.deepEqual(widths.design, [380, 1440]);
  assert.ok(!widths.suggested.includes(52) && !widths.suggested.includes(5273));
  assert.deepEqual(widths.ignored.map((item) => item.width).sort((a, b) => a - b), [52, 5273]);
  assert.match(screenReason({ type: 'SECTION', size: '5273x100' }), /не кадр/);
  assert.equal(screenReason({ type: 'FRAME', size: '1440x900' }), null);
});

test('покрытие: ширина окна записывается, несверенный мобильный кадр назван', () => {
  rememberScreens({
    files: [
      {
        frames: [
          { ref: 'COV:1:1', name: 'Подвал', type: 'FRAME', size: '1440x600', breakpoint: 'desktop' },
          { ref: 'COV:2:1', name: 'Подвал моб', type: 'FRAME', size: '380x1300', breakpoint: 'mobile' },
        ],
      },
    ],
  });
  const first = noteCoverage('COV:1:1', 'v1', { mode: 'semantic', width: 1440, frameWidth: 1440 });
  assert.deepEqual(first.widths, [1440]);
  assert.equal(first.widthWarning, undefined);
  assert.deepEqual(first.notCompared.map((item) => item.node), ['COV:2:1'], 'мобильный кадр ещё не сверяли');

  const wrong = noteCoverage('COV:2:1', 'v1', { mode: 'semantic', width: 1440, frameWidth: 380 });
  assert.match(wrong.widthWarning, /1440px.*380px/);
  assert.equal(wrong.notCompared, undefined, 'обе ширины сверены — пропусков нет');
});

test('нарисованная строка браузера: найдена, координаты потока считаются от её низа', () => {
  const snapshot = snapshotOf(
    [
      { id: 'f', type: 'FRAME', name: 'Главная', box: box(0, 0, 1440, 2000), children: ['bar', 'h', 'up'] },
      { id: 'bar', type: 'RECTANGLE', name: 'Rectangle 57', box: box(0, 0, 1440, 60), scrollBehavior: 'FIXED', fills: [{ kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }] },
      text('h', 'Заголовок', box(20, 100, 300, 40)),
      text('up', 'Наверх', box(1380, 800, 40, 40), { scrollBehavior: 'FIXED' }),
    ],
    'f',
  );
  const chrome = browserChrome(snapshot, 'f');
  assert.equal(chrome.node, 'bar');
  assert.equal(chrome.height, 60);
  const design = designItems(snapshot, 'f');
  assert.equal(design.size.h, 1940);
  const heading = design.items.find((item) => item.id === 'h');
  assert.equal(heading.box.y, 40, 'заголовок на 100 в кадре — на 40 от начала страницы');
  assert.ok(!design.items.some((item) => item.id === 'bar' || item.id === 'up'), 'строка и fixed-узлы вне сверки потока');

  const plain = snapshotOf([{ id: 'g', type: 'FRAME', name: 'Кадр', box: box(0, 0, 1440, 900), children: ['t'] }, text('t', 'Текст', box(0, 0, 1440, 60))], 'g');
  assert.equal(browserChrome(plain, 'g'), null, 'текст у верхнего края — не строка браузера');
});

test('SVG по геометрии заливки: размер узла, без обводки, смещение потомка', () => {
  const svg = svgFromGeometry({
    w: 592,
    h: 235,
    shapes: [{ matrix: [1, 0, 0, 1, 0, 0], paths: [{ d: 'M0 0L592 0L592 235Z', rule: 'NONZERO' }], color: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  assert.match(svg, /width="592" height="235" viewBox="0 0 592 235"/);
  assert.doesNotMatch(svg, /stroke/);
  assert.doesNotMatch(svg, /transform/, 'путь в начале координат — без transform');

  const geo = geometryFromRest({
    absoluteBoundingBox: { x: 100, y: 100, width: 50, height: 50 },
    children: [
      { absoluteBoundingBox: { x: 110, y: 120, width: 10, height: 10 }, fillGeometry: [{ path: 'M0 0L10 0L10 10Z', windingRule: 'EVENODD' }], fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] },
    ],
  });
  assert.equal(geo.shapes.length, 1);
  const out = svgFromGeometry(geo);
  assert.match(out, /transform="translate\(10 20\)"/);
  assert.match(out, /fill-rule="evenodd"/);
  assert.match(out, /fill="#ff0000"/);
});

test('комментарий на копии кадра показывается у оригинала с пометкой fromCopy', () => {
  const original = snapshotOf(
    [
      { id: '1:1', type: 'FRAME', name: 'Подвал', box: box(0, 0, 400, 200), children: ['1:2', '1:3'] },
      text('1:2', 'Политика', box(20, 20, 100, 20)),
      text('1:3', 'Соглашение', box(20, 60, 100, 20)),
    ],
    '1:1',
  );
  const copy = snapshotOf(
    [
      { id: '588:1', type: 'FRAME', name: 'Подвал copy', box: box(2000, 0, 400, 200), children: ['588:2', '588:3'] },
      text('588:2', 'Политика', box(2020, 20, 100, 20)),
      text('588:3', 'Соглашение', box(2020, 60, 100, 20)),
    ],
    '588:1',
  );
  const comments = [
    { id: 'c1', created_at: '2026-09-20T10:00:00Z', user: { handle: 'designer' }, message: 'Отступ 60', client_meta: { node_id: '588:1', node_offset: { x: 30, y: 65 } } },
  ];
  const frames = [
    { snapshot: original, rootId: '1:1', ref: 'KEY:1:1' },
    { snapshot: copy, rootId: '588:1', ref: 'KEY:588:1', context: true },
  ];
  const threads = buildThreads(comments, frames, { targets: ['1:1'] });
  assert.equal(threads.length, 1, 'тред с копии не потерян');
  assert.equal(threads[0].anchor.node, '1:3', 'элемент перенесён в оригинал тем же путём');
  assert.deepEqual(threads[0].anchor.fromCopy, { node: '588:3', copy: '588:1' });
  assert.equal(threads[0].on, 'descendant');
});

test('краска: второй проход не берёт занятый и далёкий узел того же размера', () => {
  const design = {
    items: [
      { kind: 'box', id: 'a', name: 'поле', box: box(0, 0, 300, 40), paint: { background: { r: 1, g: 1, b: 1, a: 1 } } },
      { kind: 'box', id: 'b', name: 'второе поле', box: box(0, 100, 300, 40), paint: { background: { r: 1, g: 1, b: 1, a: 1 } } },
    ],
  };
  const paintBox = (selector, b) => ({ kind: 'box', selector, box: b, paint: { background: 'rgb(255, 255, 255)', borders: [0, 0, 0, 0], borderColors: [], radius: ['0px', '0px', '0px', '0px'] } });
  /* На месте стоит только первое поле; второго нет, а такой же бокс есть лишь в 900px ниже. */
  const page = { items: [paintBox('.a', box(0, 0, 300, 40)), paintBox('.far', box(0, 1000, 300, 40))] };
  const result = comparePaint(design, page);
  assert.equal(result.matched, 1);
  assert.equal(result.shifted.length, 0, 'далёкий бокс того же размера — не «сдвинутый» узел');
  assert.equal(result.notFound.length, 1);
});

test('якоря: сдвиг, пропажа и неподвижность различаются, fixed сравнивается по окну', () => {
  const before = {
    '.burger': { x: 1380, y: 18, w: 32, h: 32, fixed: false, viewport: { x: 1380, y: 18 } },
    '.logo': { x: 20, y: 18, w: 120, h: 30, fixed: false, viewport: { x: 20, y: 18 } },
    '.bar': { x: 0, y: 500, w: 1440, h: 60, fixed: true, viewport: { x: 0, y: 0 } },
    '.close': null,
    '.gone': { x: 0, y: 0, w: 10, h: 10, fixed: false, viewport: { x: 0, y: 0 } },
  };
  const after = {
    '.burger': { x: 1320, y: 18, w: 32, h: 32, fixed: false, viewport: { x: 1320, y: 18 } },
    '.logo': { x: 20.4, y: 18, w: 120, h: 30, fixed: false, viewport: { x: 20.4, y: 18 } },
    '.bar': { x: 0, y: 900, w: 1440, h: 60, fixed: true, viewport: { x: 0, y: 0 } },
    '.close': { x: 10, y: 10, w: 15, h: 15, fixed: false, viewport: { x: 10, y: 10 } },
    '.gone': null,
  };
  const diff = diffBoxes(before, after);
  assert.deepEqual(diff.moved.map((m) => [m.selector, m.dx]), [['.burger', -60]]);
  assert.equal(diff.stable, 2, 'логотип в пределах порога и fixed-панель на месте окна');
  assert.deepEqual(diff.vanished, ['.gone']);
  assert.deepEqual(diff.appeared, ['.close']);
});

test('дёрганье: туда и обратно — находка, одиночный сдвиг — нет', () => {
  const trace = { names: ['button', 'label'], frames: [[100, 50], [80, 50], [100, 50], [80, 50]] };
  const jitter = findJitter(trace);
  assert.equal(jitter.length, 1);
  assert.equal(jitter[0].element, 'button');
  assert.ok(jitter[0].turns >= 1);
  assert.deepEqual(findJitter({ names: ['button'], frames: [[100], [80], [80], [80]] }), []);
});

test('шаг формы: помечено без текста, ошибка осталась после исправления, форма выросла', () => {
  const state = {
    box: { w: 360, h: 260 },
    fields: {
      '#name': { invalid: true, value: '' },
      '#phone': { invalid: true, error: 'Заполните поле', value: '+7 (999) 123-45-67' },
      '#mail': { invalid: true, native: true, value: '' },
    },
  };
  const issues = judgeStep('fix', state, { baseHeight: 220, expectValid: ['#phone'] });
  const kinds = issues.map((issue) => `${issue.kind}:${issue.selector ?? ''}`);
  assert.ok(kinds.includes('invalidWithoutText:#name'));
  assert.ok(kinds.includes('errorStays:#phone'));
  assert.ok(kinds.includes('nativeOnly:#mail'));
  assert.ok(issues.some((issue) => issue.kind === 'heightChanged' && issue.px === 40));
});

test('значения для форм: свои важнее, негодные — только где они осмысленны', () => {
  assert.equal(sampleFor({ type: 'email', selector: '#e' }, 'valid'), 'test@example.com');
  assert.equal(sampleFor({ type: 'email', selector: '#e', name: 'mail' }, 'valid', { mail: 'me@site.ru' }), 'me@site.ru');
  assert.equal(sampleFor({ type: 'tel', selector: '#p' }, 'invalid'), '12');
  assert.equal(sampleFor({ type: 'text', selector: '#t', minLength: 5 }, 'invalid'), 'x');
  assert.equal(hasInvalidSample({ type: 'text' }), false, 'у простого текста негодно только пустое — это сценарий empty');
  assert.equal(hasInvalidSample({ type: 'tel' }), true);
});

test('очередь редактора: сверх потолка — сразу «занято», дедлайн обрывает зависшее', async () => {
  let release;
  const hang = new Promise((resolve) => (release = resolve));
  const run = (job) => job();
  const first = admitted(() => hang, { max: 1, run });
  await assert.rejects(admitted(async () => 'x', { max: 1, run }), /Канал редактора занят/);
  release('ok');
  assert.equal(await first, 'ok');
  assert.equal(await admitted(async () => 'free', { max: 1, run }), 'free', 'после освобождения очередь снова принимает');

  await assert.rejects(withDeadline(new Promise(() => {}), 20), (err) => err.code === 'timeout');
  assert.equal(await withDeadline(Promise.resolve(5), 1000), 5);
});

test('журнал вызовов: имя, ключи без значений, исход', async () => {
  const lines = [];
  const write = (line) => lines.push(line);
  await logged({ params: { name: 'figma_inspect', arguments: { figma: 'K:1:1', auth: 'секрет' } } }, async () => ({ content: [] }), write, true);
  assert.match(lines[0], /\[call\] figma_inspect\(figma,auth\) начат/);
  assert.match(lines[1], /figma_inspect ok, \d+ мс/);
  assert.ok(!lines.join('').includes('секрет'), 'значения аргументов в журнал не попадают');
  await assert.rejects(logged({ params: { name: 'x' } }, async () => { throw new Error('упал'); }, write, true));
  const quiet = [];
  await logged({ params: { name: 'y' } }, async () => ({}), (line) => quiet.push(line), false);
  assert.deepEqual(quiet, [], 'выключенный журнал молчит');
  assert.match(lines.at(-1), /x отказ: упал/);
});
