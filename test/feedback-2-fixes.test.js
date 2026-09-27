/**
 * Правки по второму заходу вёрстки по макету: что мешало агенту и что стенд мог решить сам.
 *
 * figma_spec падал на кадре с нарисованной строкой браузера, clip молча резался по окну, вторая
 * заливка перезаписывала первую, «Спасибо» после отправки читалось как пачка ошибок. Сверка
 * путала текст кнопки с кнопкой, не видела кадра со сдвинутым контентом, разного числа строк,
 * разного контента и состояний без пары. Комментарии на копиях кадров приходили без имён, а
 * переход в UI-кит выглядел обычной целью. Здесь всё, что считается без браузера.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromeNote } from '../src/tools/figma.js';
import { outlineLines } from '../src/figma/inspect.js';
import { trimClip } from '../src/checks/visual.js';
import { sameUrl } from '../src/browser/pool.js';
import { imageFileName, svgOffset } from '../src/figma/export.js';
import { judgeStep, successOf } from '../src/checks/forms.js';
import { absentBlocks, compareGeometry, designItems, pairTexts, sectionGroups } from '../src/figma/compare.js';
import { placeThreads } from '../src/figma/analyze/comments.js';
import { describeBehavior, uiKitTarget } from '../src/figma/analyze/behavior.js';
import { compareBreakpoints, textRole } from '../src/figma/analyze/breakpoints.js';
import { scrollbarCss } from '../src/browser/stabilize.js';
import { normalizeProfile } from '../src/browser/profile.js';

const box = (x, y, w, h) => ({ x, y, w, h });
const px = (value) => ({ unit: 'px', value });
const text = (id, chars, b, { style = {}, text: extraText = {}, ...rest } = {}) => ({
  id,
  type: 'TEXT',
  name: chars,
  box: b,
  text: { chars, style: { size: 16, lineHeight: px(20), ...style }, ...extraText },
  ...rest,
});
const frame = (id, name, b, children, extra = {}) => ({ id, type: 'FRAME', name, box: b, children, ...extra });

function snapshotOf(nodes, root, extra = {}) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map, ...extra };
}

/** Страница в том виде, в каком её отдаёт probePage. */
const pageText = (textValue, b, extra = {}) => ({ kind: 'text', text: textValue, selector: extra.selector ?? `.t-${textValue.length}`, box: b, style: {}, ...extra });
const pageOf = (items, w = 380, h = 2000) => ({ origin: { w, h }, items });

/* ---------- Блок 1: баги ---------- */

test('figma_spec: заметка о строке браузера собирается без ReferenceError', () => {
  const note = chromeNote({ node: '1:2', name: 'Browser', height: 60.004 });
  assert.match(note.note, /Вычитайте 60px/);
  assert.equal(chromeNote(null), null);
});

test('ошибка разбора дерева называет узел, на котором сломалась', () => {
  const broken = { id: '1:2', type: 'TEXT', name: 'Сломанный', box: box(0, 0, 10, 10), get text() { throw new Error('нет стиля'); } };
  const snapshot = snapshotOf([frame('1:1', 'Кадр', box(0, 0, 100, 100), ['1:2']), broken], '1:1');
  assert.throws(() => outlineLines(snapshot, '1:1', { depth: 3 }), /узел 1:2 «Сломанный»: нет стиля/);
});

test('clip ниже первого экрана не режется окном, а за документом обрезается с пометкой', () => {
  assert.deepEqual(trimClip({ x: 0, y: 0, width: 380, height: 2100 }, { w: 380, h: 3000 }), { clip: { x: 0, y: 0, width: 380, height: 2100 }, trimmed: false });
  const cut = trimClip({ x: 0, y: 2500, width: 380, height: 1000 }, { w: 380, h: 3000 });
  assert.deepEqual(cut, { clip: { x: 0, y: 2500, width: 380, height: 500 }, trimmed: true });
  assert.equal(trimClip({ x: 0, y: 3200, width: 10, height: 10 }, { w: 380, h: 3000 }), null);
});

test('url при sessionId: тот же адрес не перезагружается, другой — открывается', () => {
  assert.equal(sameUrl('http://host/contacts/', 'http://host/contacts#map'), true);
  assert.equal(sameUrl('http://host/contacts', 'http://host/about'), false);
});

test('две картинки-заливки одного узла получают разные файлы', () => {
  const node = { id: '338:14174', name: 'Фото' };
  assert.equal(imageFileName(node, 2), 'фото-338-14174@2x.webp', 'одна заливка — имя как раньше');
  const first = imageFileName(node, 1, 0);
  const second = imageFileName(node, 1, 1);
  assert.notEqual(first, second);
  assert.match(first, /-f1@1x\.webp$/);
  assert.match(second, /-f2@1x\.webp$/);
});

test('svg с внешним штрихом: offset говорит, на сколько он больше узла и с какой стороны', () => {
  const node = { box: box(10, 20, 100, 50), render: box(7.33, 17.33, 105.34, 55.34) };
  assert.deepEqual(svgOffset(node, {}), { box: '100x50', offset: { left: 2.67, top: 2.67, right: 2.67, bottom: 2.67, by: 'renderBounds' } });
  assert.deepEqual(svgOffset({ box: box(0, 0, 100, 50) }, { width: 104, height: 54 }).offset.by, 'size');
  assert.deepEqual(svgOffset({ box: box(0, 0, 100, 50) }, { width: 100, height: 50 }), {});
});

test('form_audit: спрятанная или сброшенная после отправки форма — успех, а не ошибки', () => {
  const hidden = { hidden: true, box: { w: 0, h: 0 }, fields: { '#name': { invalid: true, value: '' } } };
  assert.deepEqual(successOf(hidden, { linesBefore: ['Имя'], linesAfter: ['Спасибо!'] }), { kind: 'hidden', message: 'Спасибо!' });
  const reset = { box: { w: 360, h: 120 }, fields: { '#email': { invalid: true, value: '' } } };
  assert.equal(successOf(reset, { linesBefore: ['Почта'], linesAfter: ['Почта', 'Вы подписаны.'] }).kind, 'reset');
  assert.equal(successOf(reset, { linesBefore: ['Почта'], linesAfter: ['Почта'] }), null, 'сброс без сообщения успехом не считается');

  const issues = judgeStep('valid', hidden, { baseHeight: 200, expectValid: ['#name'], success: { kind: 'hidden' } });
  assert.deepEqual(issues, []);
  assert.ok(judgeStep('valid', hidden, { baseHeight: 200, expectValid: ['#name'] }).length, 'без распознавания успеха были бы находки');
});

/* ---------- Блок 2: шум сверки ---------- */

test('текст кнопки сверяется рамкой кнопки с кнопкой страницы, а не слоем текста', () => {
  const snapshot = snapshotOf(
    [
      frame('1:1', 'Экран', box(0, 0, 380, 800), ['1:2']),
      frame('1:2', 'Кнопка', box(20, 100, 340, 56), ['1:3']),
      text('1:3', 'РЕГИСТРАЦИЯ', box(20, 118, 340, 20), { text: { autoResize: 'NONE' }, style: { align: 'CENTER' } }),
    ],
    '1:1',
  );
  const design = designItems(snapshot, '1:1');
  const same = pageOf([pageText('РЕГИСТРАЦИЯ', box(145, 118, 90, 20), { control: { selector: 'a.btn', box: box(20, 100, 340, 56) } })]);
  assert.deepEqual(compareGeometry(design, same).findings, [], 'совпадающая кнопка — не находка');

  const narrow = pageOf([pageText('РЕГИСТРАЦИЯ', box(145, 118, 90, 20), { control: { selector: 'a.btn', box: box(20, 100, 300, 56) } })]);
  const [finding] = compareGeometry(design, narrow).findings;
  assert.equal(finding.frame, '1:2');
  assert.equal(finding.control, 'a.btn');
  assert.deepEqual(finding.shift, { w: -40 });
});

test('растянутый центрированный заголовок сверяется по центру, ширина слоя — не находка', () => {
  const snapshot = snapshotOf(
    [frame('1:1', 'Экран', box(0, 0, 380, 800), ['1:2']), text('1:2', 'О нас', box(0, 200, 380, 20), { text: { autoResize: 'HEIGHT' }, style: { align: 'CENTER' } })],
    '1:1',
  );
  const design = designItems(snapshot, '1:1');
  assert.deepEqual(compareGeometry(design, pageOf([pageText('О нас', box(150, 200, 80, 20))])).findings, []);
  const [off] = compareGeometry(design, pageOf([pageText('О нас', box(170, 200, 80, 20))])).findings;
  assert.deepEqual(off.shift, { x: 20 });
  assert.equal(off.textBox.w, -300, 'разница ширины слоя видна, но отдельно');
});

test('разное число строк называется прямо, с text-wrap страницы', () => {
  const snapshot = snapshotOf(
    [frame('1:1', 'Экран', box(0, 0, 380, 800), ['1:2']), text('1:2', 'Длинный заголовок в три строки', box(20, 300, 340, 72), { style: { lineHeight: px(24) } })],
    '1:1',
  );
  const design = designItems(snapshot, '1:1');
  const page = pageOf([pageText('Длинный заголовок в три строки', box(20, 300, 340, 48), { lines: 2, style: { textWrap: 'balance' } })]);
  const [finding] = compareGeometry(design, page).findings;
  assert.deepEqual({ design: finding.lines.design, page: finding.lines.page, textWrap: finding.lines.textWrap }, { design: 3, page: 2, textWrap: 'balance' });
  assert.match(finding.lines.note, /в макете 3 стр\., на странице 2/);
});

test('кадр со сдвинутым контентом: поправка на отступ вместо «N элементов смещены»', () => {
  const texts = [100, 300, 500, 700].map((y, i) => text(`2:${10 + i}`, `Пункт ${i}`, box(40, 60 + y, 200, 20)));
  const snapshot = snapshotOf(
    [
      frame('1:1', 'Системы отделения', box(0, 0, 1440, 2000), ['2:1', '2:2']),
      frame('2:2', 'Desktop', box(0, 60, 1440, 1940), texts.map((node) => node.id)),
      frame('2:1', 'Шапка', box(0, 0, 1440, 60), ['2:3']),
      text('2:3', 'Меню', box(40, 20, 60, 20)),
      ...texts,
    ],
    '1:1',
  );
  const design = designItems(snapshot, '1:1');
  assert.equal(design.lead?.y, 60);
  const page = pageOf(
    [pageText('Меню', box(40, 20, 60, 20)), ...[100, 300, 500, 700].map((y, i) => pageText(`Пункт ${i}`, box(40, y, 200, 20)))],
    1440,
    1940,
  );
  const result = compareGeometry(design, page);
  assert.deepEqual(result.findings, []);
  assert.equal(result.lead.name, 'Desktop');
});

test('сдвинутый блок с разным контентом выше помечается cause: content', () => {
  const snapshot = snapshotOf(
    [
      frame('1:1', 'Контакты', box(0, 0, 380, 2000), ['1:2', '1:3', '1:4', '1:5', '1:6']),
      text('1:2', 'Контакты', box(20, 100, 200, 20)),
      text('1:3', 'ул. Космическая, д. 42', box(20, 200, 200, 20)),
      text('1:4', 'Карта', box(20, 600, 200, 20)),
      text('1:5', 'Как добраться', box(20, 700, 200, 20)),
      text('1:6', 'Парковка', box(20, 800, 200, 20)),
    ],
    '1:1',
  );
  const design = designItems(snapshot, '1:1');
  const page = pageOf([
    pageText('Контакты', box(20, 100, 200, 20)),
    pageText('Карта', box(20, 350, 200, 20)),
    pageText('Как добраться', box(20, 450, 200, 20)),
    pageText('Парковка', box(20, 550, 200, 20)),
  ]);
  const block = compareGeometry(design, page).findings.find((finding) => finding.shiftedBlock);
  assert.equal(block.cause, 'content');
  assert.equal(block.above.onlyDesign[0].text, 'ул. Космическая, д. 42');
});

test('состояние из макета без пары на странице собирается в один блок', () => {
  const partners = ['Роскосмос', 'ЦНИИмаш', 'НПО Лавочкина'].map((name, i) => text(`3:${i + 2}`, name, box(20, 400 + i * 30, 200, 20)));
  const snapshot = snapshotOf(
    [
      frame('1:1', 'Экран', box(0, 0, 380, 1000), ['1:2', '3:1']),
      text('1:2', 'Партнёры', box(20, 360, 200, 20)),
      frame('3:1', 'Партнёры раскрыто', box(0, 390, 380, 100), partners.map((node) => node.id)),
      ...partners,
    ],
    '1:1',
  );
  const design = designItems(snapshot, '1:1');
  const page = pageOf([pageText('Партнёры', box(20, 360, 200, 20))]);
  const { onlyDesignBlocks } = compareGeometry(design, page);
  assert.equal(onlyDesignBlocks.length, 1);
  assert.deepEqual({ node: onlyDesignBlocks[0].node, name: onlyDesignBlocks[0].name, texts: onlyDesignBlocks[0].texts }, { node: '3:1', name: 'Партнёры раскрыто', texts: 3 });
  const { pairs, onlyDesign } = pairTexts(design.items, page.items);
  assert.deepEqual(absentBlocks(design, onlyDesign, pairs, { min: 4 }), [], 'порог числа текстов соблюдается');
});

test('тексты секции и соседей раскладываются для поиска обёртки секции на странице', () => {
  const pairs = [
    { design: { box: box(0, 10, 10, 10) }, page: { selector: '.a' } },
    { design: { box: box(0, 510, 10, 10) }, page: { selector: '.b' } },
  ];
  const groups = sectionGroups([{ box: box(0, 0, 380, 500) }, { box: box(0, 500, 380, 500) }], pairs);
  assert.deepEqual(groups, [
    { own: ['.a'], other: ['.b'] },
    { own: ['.b'], other: ['.a'] },
  ]);
});

test('overlay-полосы прокрутки: по умолчанию только в узком окне, режим виден в профиле', () => {
  assert.match(scrollbarCss('auto'), /^@media \(max-width:767\.98px\)/);
  assert.match(scrollbarCss('overlay'), /scrollbar-gutter:auto!important/);
  assert.equal(scrollbarCss('classic'), null);
  assert.equal(normalizeProfile({ viewport: 'mobile' }).scrollbars, 'auto');
});

/* ---------- Блок 3: прочие figma-инструменты ---------- */

test('комментарий на неснятом кадре называет кадр и страницу', () => {
  const threads = [
    { anchor: { frame: '588:1', note: 'кадр комментария не снят' } },
    { anchor: { node: '281:5174', name: 'Системы' } },
    { anchor: null },
  ];
  placeThreads(threads, { '588:1': { name: 'Контакты', page: 'Объяснение' }, '281:5174': { name: 'Системы', page: 'Макет' } });
  assert.equal(threads[0].anchor.frameName, 'Контакты');
  assert.equal(threads[0].anchor.page, 'Объяснение');
  assert.equal(threads[1].anchor.page, 'Макет');
});

test('переход на компонент UI-кита помечается, смена своего варианта — нет', () => {
  const kit = snapshotOf(
    [
      { id: '338:9870', type: 'COMPONENT_SET', name: 'Pagination', box: box(0, 0, 100, 40), children: ['338:9873'] },
      { id: '338:9873', type: 'COMPONENT', name: 'Default', box: box(0, 0, 100, 40), component: { definition: true } },
    ],
    '338:9870',
  );
  const target = kit.nodes['338:9873'];
  assert.deepEqual(
    { ...uiKitTarget(target, kit, 'Dropdown'), note: undefined },
    { toType: 'COMPONENT', toComponent: true, toSet: 'Pagination', note: undefined },
  );
  assert.equal(uiKitTarget(target, kit, 'Pagination'), null, 'вариант своего набора — это состояние');
  assert.equal(uiKitTarget({ type: 'FRAME', name: 'Экран' }, kit, null), null);

  const screen = snapshotOf(
    [
      frame('1:1', 'Экран', box(0, 0, 380, 800), ['1:2']),
      {
        id: '1:2',
        type: 'INSTANCE',
        name: 'Год',
        box: box(0, 0, 100, 40),
        component: { id: 'c', name: 'Closed', set: 'Dropdown' },
        interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', navigation: 'CHANGE_TO', destinationId: '338:9873' }] }],
      },
    ],
    '1:1',
  );
  const behavior = describeBehavior([
    { snapshot: screen, rootId: '1:1', ref: 'KEY:1:1' },
    { snapshot: kit, rootId: '338:9870', ref: 'KEY:338:9870' },
  ]);
  assert.equal(behavior.grouped[0].toComponent, true);
  assert.equal(behavior.grouped[0].fromSet, 'Dropdown');
});

test('макет расходится сам с собой: заглушки десктопа против данных мобильного', () => {
  assert.equal(textRole('info@space.ru'), 'email');
  assert.equal(textRole('+7 (495) 000-00-00'), 'phone');
  assert.equal(textRole('ул. Космическая, д. 42'), 'address');
  assert.equal(textRole('Контакты'), null);

  const screen = (prefix, width, contacts) =>
    snapshotOf(
      [
        frame(`${prefix}:1`, 'Контакты', box(0, 0, width, 800), [`${prefix}:2`, `${prefix}:3`, `${prefix}:4`]),
        text(`${prefix}:2`, 'Контакты', box(20, 20, 200, 20)),
        text(`${prefix}:3`, contacts.address, box(20, 60, 300, 20)),
        text(`${prefix}:4`, contacts.phone, box(20, 100, 300, 20)),
      ],
      `${prefix}:1`,
    );
  const desktop = screen('1', 1440, { address: 'ул. Космическая, д. 42', phone: '000-00-00-00' });
  const mobile = screen('2', 380, { address: 'ул. Ленина, д. 1', phone: '+7 495 123-45-67' });
  const report = compareBreakpoints([
    { snapshot: desktop, rootId: '1:1', ref: 'KEY:1:1', width: 1440 },
    { snapshot: mobile, rootId: '2:1', ref: 'KEY:2:1', width: 380 },
  ]);
  const roles = Object.fromEntries(report.comparisons[0].contentMismatch.map((item) => [item.role, item]));
  assert.deepEqual(roles.address.base, ['ул. Космическая, д. 42']);
  assert.deepEqual(roles.address.other, ['ул. Ленина, д. 1']);
  assert.ok(roles.phone, JSON.stringify(report.comparisons[0].contentMismatch));
});

/* ---------- Сторож: помощник вызывается — значит, импортирован ---------- */

test('общие помощники не вызываются без импорта (figma_spec падал на round)', () => {
  const root = path.resolve(import.meta.dirname, '../src');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  /* Имена, экспортируемые модулями стенда: их чаще всего и зовут, забыв импорт. */
  const exported = new Set();
  for (const file of files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/export (?:async )?(?:function|const) (\w+)/g)) exported.add(m[1]);
  }
  const missing = [];
  for (const file of files) {
    /* Комментарии не в счёт: «см. stabilize()» в пояснении — не вызов. */
    const source = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const name of exported) {
      if (name.length < 4 || !new RegExp(`(?<![\\w.$'"\`])${name}\\(`).test(source)) continue;
      const declared =
        new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source) ||
        new RegExp(`(?:function\\*?|const|let|var|class)\\s+${name}\\b`).test(source) ||
        new RegExp(`[({,]\\s*${name}\\s*[,})=]`).test(source) ||
        new RegExp(`\\(\\s*${name}\\s*\\)\\s*=>`).test(source);
      if (!declared) missing.push(`${path.relative(root, file)}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});
