/**
 * Замечания приёмки ТОПГАН: смысловая сверка не видела шрифт и регистр, структура падала на
 * холсте, рендер холста одной операцией терял весь результат.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactCompare,
  compareGeometry,
  familyKey,
  firstFamily,
  fontSubstitutions,
  renderedText,
} from '../src/figma/compare.js';
import { inferStructure } from '../src/figma/analyze/structure.js';
import { renderBatches } from '../src/figma/export.js';
import { compareMotion, cubicBezier, easingFn, frameTimes, layerMap, motionTracks, springAt } from '../src/figma/motion.js';
import { measuredChange, pauseClock, playerLayout, protoUrl, shootTimes } from '../src/figma/motion-capture.js';
import { animatedInteraction, playerFrame, screenOf } from '../src/tools/figma.js';
import { checklistItems, consoleBlockers, layoutBlockers, waiverBook } from '../src/checks/ready.js';
import { diffKeyState, likelyDefects } from '../src/checks/settled.js';

const box = (x, y, w = 200, h = 24) => ({ x, y, w, h });
const designText = (id, text, y, { family = 'Manrope', textTransform = 'none' } = {}) => ({
  kind: 'text',
  id,
  text,
  box: box(0, y),
  ancestors: [],
  style: { family, fontSize: 16, fontWeight: 400, lineHeight: null, letterSpacing: 0, color: null, textTransform },
});
const pageText = (text, y, { fontFamily = 'Manrope, sans-serif', textTransform = 'none' } = {}) => ({
  kind: 'text',
  text,
  selector: `.t-${y}`,
  box: box(0, y),
  style: { fontFamily, fontSize: '16px', fontWeight: '400', lineHeight: 'normal', letterSpacing: 'normal', color: 'rgb(0, 0, 0)', textTransform },
});
const compare = (design, page) => compareGeometry({ items: design, size: { w: 1440, h: 900 } }, { items: page, origin: { w: 1440, h: 900 } });
const stylesOf = (result, text) => result.findings.find((finding) => finding.text === text)?.styles;

test('имя семейства: кавычки, запасные шрифты и языковые суффиксы разницей не считаются', () => {
  assert.equal(firstFamily('"Bebas Neue", sans-serif'), 'Bebas Neue');
  assert.equal(familyKey('Bebas Neue Ru'), familyKey('"BebasNeue", Arial'));
  assert.equal(familyKey('Bebas Neue Cyrillic'), familyKey('Bebas Neue'));
  assert.notEqual(familyKey('Manrope'), familyKey('Roboto'));
});

test('регистр сравнивается по виду текста, а не по способу записи', () => {
  assert.equal(renderedText('запись', 'upper'), renderedText('Запись', 'uppercase'));
  assert.equal(renderedText('наши услуги', 'title'), 'Наши Услуги');
  assert.equal(renderedText('Текст', 'small_caps'), null);

  const same = compare([designText('1:1', 'ЗАПИСЬ', 0)], [pageText('запись', 0, { textTransform: 'uppercase' })]);
  assert.equal(same.findings.length, 0, 'прописные набраны в макете и заданы CSS - вид один');

  const lost = compare([designText('1:1', 'вакансии', 0, { textTransform: 'upper' })], [pageText('вакансии', 0)]);
  assert.deepEqual(stylesOf(lost, 'вакансии')['text-case'], { design: 'ВАКАНСИИ', page: 'вакансии' });
});

test('одна подпись чужим шрифтом - находка', () => {
  const result = compare(
    [designText('1:1', 'Заголовок', 0), designText('1:2', 'Подпись', 40)],
    [pageText('Заголовок', 0), pageText('Подпись', 40, { fontFamily: 'Roboto, sans-serif' })],
  );
  assert.equal(result.findings.length, 1);
  assert.deepEqual(stylesOf(result, 'Подпись')['font-family'], { design: 'Manrope', page: 'Roboto' });
});

test('согласованная подмена - одна строка, а выбившийся текст остаётся находкой', () => {
  const texts = ['Один', 'Два', 'Три', 'Четыре', 'Пять'];
  const design = texts.map((text, i) => designText(`1:${i}`, text, i * 40, { family: 'Gilroy' }));
  const page = texts.map((text, i) => pageText(text, i * 40, { fontFamily: i === 4 ? 'Roboto' : 'Manrope' }));
  const result = compare(design, page);
  assert.deepEqual(result.fontSubstitutions, [{ design: 'Gilroy', page: 'Manrope', texts: 4, of: 5 }]);
  assert.equal(result.findings.length, 1);
  assert.equal(stylesOf(result, 'Пять')['font-family'].page, 'Roboto');
});

test('два текста подменой не считаются: для вывода мало данных', () => {
  const pairs = ['а', 'б'].map((text, i) => ({
    design: designText(`1:${i}`, text, i * 40, { family: 'Gilroy' }),
    page: pageText(text, i * 40),
  }));
  assert.equal(fontSubstitutions(pairs).list.length, 0);
});

test('компактный ответ сверки: расхождения и счётчики без ссылок на картинки', () => {
  const ref = { path: '/x.png', uri: 'lt://artifacts/x.png', url: 'http://x/x.png', internalUrl: 'http://y/x.png' };
  const compact = compactCompare(
    {
      runId: 'r1',
      ref: 'KEY:1:1',
      frame: { w: 1440, h: 900 },
      semantic: {
        matched: 3,
        found: 1,
        findings: [{ text: 'а', node: '1:2', hint: 'длинная подсказка', lines: { design: 1, page: 2, note: 'пояснение' } }],
        onlyDesign: [],
        onlyPage: [],
      },
      paint: { matched: 1, found: 0, findings: [], unmatched: { shifted: { count: 2, items: [{}] }, notFound: { count: 1, items: [{}] } } },
      pixel: { match: false, diffPercentage: 3.2, design: ref, page: ref, diff: ref },
      heightNote: 'разница высот',
      coverage: { semantic: 'now', pixel: 'never', sections: 'never', note: 'длинно', notCompared: [{}, {}], notComparedNote: 'длинно' },
    },
    { worst: [{ node: '1:5', name: 'hero', diffPercentage: 1, match: false }] },
  );
  const text = JSON.stringify(compact);
  assert.ok(!text.includes('lt://') && !text.includes('http'), 'ссылок на артефакты нет');
  assert.ok(!text.includes('длинн'), 'пояснения убраны');
  assert.deepEqual(compact.semantic.findings[0].lines, { design: 1, page: 2 });
  assert.deepEqual(compact.paint.unmatched, { shifted: 2, notFound: 1 });
  assert.equal(compact.coverage.notCompared, 2);
  assert.equal(compact.notes.heightNote, 'разница высот');
  assert.equal(compact.sections[0].node, '1:5');
});

test('структура холста не падает на наложении: у CANVAS нет своей рамки', () => {
  const nodes = {
    '0:1': { id: '0:1', type: 'CANVAS', name: 'Страница', children: ['1:1', '1:2'] },
    '1:1': { id: '1:1', type: 'FRAME', name: 'Экран', parent: '0:1', box: box(0, 0, 1440, 900), children: [] },
    '1:2': { id: '1:2', type: 'FRAME', name: 'Поверх', parent: '0:1', box: box(100, 100, 400, 300), children: [] },
  };
  const result = inferStructure({ fileKey: 'KEY', root: '0:1', version: '1', nodes }, '0:1', { depth: 1 });
  assert.ok(result.lines.length > 0);
});

test('пачки рендера: по числу узлов и по площади, крупный узел отдельно', () => {
  const item = (id, w, h, scale = 1) => ({ id, scale, node: { box: { w, h } } });
  const small = Array.from({ length: 12 }, (_, i) => item(`s${i}`, 100, 100));
  assert.deepEqual(renderBatches(small).map((batch) => batch.length), [5, 5, 2]);

  const mixed = [item('a', 1440, 900), item('huge', 1440, 12000), item('b', 1440, 900)];
  assert.deepEqual(renderBatches(mixed).map((batch) => batch.map((entry) => entry.id)), [['a'], ['huge'], ['b']]);

  const scaled = [item('a', 1440, 3000, 2), item('b', 1440, 3000, 2)];
  assert.equal(renderBatches(scaled).length, 2, 'масштаб учитывается в площади');
  assert.deepEqual(renderBatches([]), []);
});

/* Покадровая анимация: числа без браузера. */
const motionSnapshot = () => {
  const node = (id, name, parent, at, extra = {}) => ({ id, name, parent, type: 'FRAME', box: { x: at[0], y: at[1], w: 100, h: 20 }, children: [], ...extra });
  const nodes = {
    A: node('A', 'Состояние', null, [1000, 500], { children: ['A1', 'A2', 'A3'] }),
    A1: node('A1', 'Текст', 'A', [1000, 560], { type: 'TEXT', opacity: 0, text: { chars: 'Первый абзац' } }),
    A2: node('A2', 'Уходит', 'A', [1000, 600]),
    A3: node('A3', 'Покой', 'A', [1000, 640], { fills: [{ kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }] }),
    B: node('B', 'Состояние', null, [3000, 500], { children: ['B1', 'B3', 'B4'] }),
    B1: node('B1', 'Текст', 'B', [3000, 500], { type: 'TEXT', text: { chars: 'Первый абзац' } }),
    B3: node('B3', 'Покой', 'B', [3000, 640], { fills: [{ kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } }] }),
    B4: node('B4', 'Приходит', 'B', [3000, 700]),
  };
  return { root: 'A', nodes };
};

test('кривые перехода: концы точные, ease-out обгоняет линейную, пружина приходит к 1', () => {
  const easeOut = cubicBezier(0, 0, 0.58, 1);
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  assert.ok(easeOut(0.5) > 0.6);
  assert.ok(Math.abs(cubicBezier(0, 0, 1, 1)(0.3) - 0.3) < 0.001);
  assert.ok(Math.abs(springAt({ mass: 1, stiffness: 100, damping: 15 }, 3) - 1) < 0.01);
  assert.ok(Math.abs(springAt({ mass: 1, stiffness: 100, damping: 40 }, 6) - 1) < 0.01, 'передемпфированная');
  assert.equal(easingFn({ type: 'EASE_OUT' }).approximate, false);
  assert.equal(easingFn({ type: 'GENTLE' }, 800).approximate, true);
  assert.equal(easingFn({ type: 'GENTLE' }, 800).fn(1), 1);
});

test('моменты кадров: шаг по fps, последний ровно в конце', () => {
  assert.deepEqual(frameTimes(500, 10), [0, 100, 200, 300, 400, 500]);
  const times = frameTimes(700, 12);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 700);
  assert.equal(new Set(times).size, times.length);
  assert.deepEqual(shootTimes([0, 100], 10), [0, 100, 200]);
});

test('слои сопоставляются по имени и месту, одноимённые соседи не путаются', () => {
  const snapshot = {
    nodes: {
      R: { id: 'R', name: 'r', box: { x: 10, y: 10, w: 100, h: 100 }, children: ['X', 'Y', 'H'] },
      X: { id: 'X', name: 'item', box: { x: 10, y: 20, w: 10, h: 10 } },
      Y: { id: 'Y', name: 'item', box: { x: 10, y: 40, w: 10, h: 10 } },
      H: { id: 'H', name: 'hidden', visible: false, box: { x: 0, y: 0, w: 1, h: 1 } },
    },
  };
  const map = layerMap(snapshot, 'R');
  assert.deepEqual([...map.keys()], ['/item#0', '/item#1']);
  assert.equal(map.get('/item#1').props.y, 30);
});

test('треки перехода: движение, цвет, появление и уход слоя', () => {
  const snapshot = motionSnapshot();
  const result = motionTracks({ snapshot, rootId: 'A' }, { snapshot, rootId: 'B' }, { type: 'SMART_ANIMATE', duration: 0.5, easing: { type: 'LINEAR' } }, { fps: 10 });
  assert.equal(result.durationMs, 500);
  assert.equal(result.easing, 'linear');
  const find = (layer, property) => result.tracks.find((track) => track.layer === layer && track.property === property);
  assert.deepEqual(find('Текст', 'y').values, [60, 48, 36, 24, 12, 0]);
  assert.deepEqual(find('Текст', 'opacity').values, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.equal(find('Уходит', 'opacity').disappears, true);
  assert.equal(find('Приходит', 'opacity').appears, true);
  assert.equal(find('Покой', 'color').values.length, 6);
  assert.equal(find('Покой', 'y'), undefined, 'неподвижное свойство трека не даёт');
});

test('сверка движения: отклонение считается от конца, сдвиг всего блока ошибкой не считается', () => {
  const snapshot = motionSnapshot();
  const design = motionTracks({ snapshot, rootId: 'A' }, { snapshot, rootId: 'B' }, { duration: 0.5, easing: { type: 'LINEAR' } }, { fps: 10 });
  const element = (y, opacity) => ({ text: 'Первый абзац', selector: 'p.a', x: [0, 0, 0, 0, 0, 0], y, opacity });
  const same = compareMotion(design, { elements: [element([160, 148, 136, 124, 112, 100], [0, 0.2, 0.4, 0.6, 0.8, 1])] });
  assert.equal(same.match, true, JSON.stringify(same.diffs));

  const wrong = compareMotion(design, { elements: [element([100, 100, 100, 100, 100, 100], [1, 1, 1, 1, 1, 1])] });
  assert.equal(wrong.match, false);
  assert.deepEqual(wrong.diffs.map((diff) => diff.property).sort(), ['opacity', 'y']);
  assert.equal(wrong.diffs.find((diff) => diff.property === 'y').atMs, 0);

  const none = compareMotion(design, { elements: [] });
  assert.equal(none.match, false, 'нечего сверять - это не совпадение');
  assert.ok(none.note);
});

test('плеер: адрес, прокрутка к узлу и клик в его центр', () => {
  assert.match(protoUrl('KEY', '280:6725'), /proto\/KEY\/\?node-id=280-6725&starting-point-node-id=280-6725/);
  const layout = playerLayout({ x: 15666, y: 1238, w: 1440, h: 5618 }, { x: 15666, y: 2098, w: 1440, h: 737 });
  assert.equal(layout.viewport, '1440x777');
  assert.equal(layout.scroll, 840);
  assert.deepEqual(layout.clip, { x: 0, y: 20, width: 1440, height: 737 });
  assert.deepEqual(layout.point, { x: 720, y: 388.5 });
  const top = playerLayout({ x: 0, y: 0, w: 1440, h: 900 }, { x: 0, y: 0, w: 400, h: 200 });
  assert.equal(top.scroll, 0);
});

test('пауза часов: занятая страница ушла вперёд - запас растёт, чужая ошибка не глотается', async () => {
  const asked = [];
  const page = {
    evaluate: async (fn, margin) => margin,
    clock: {
      pauseAt: async (time) => {
        asked.push(time);
        if (asked.length < 3) throw new Error('Cannot fast-forward to the past');
      },
    },
  };
  await pauseClock(page);
  assert.deepEqual(asked, [400, 1500, 5000]);

  const broken = { evaluate: async () => 1, clock: { pauseAt: async () => { throw new Error('page closed'); } } };
  await assert.rejects(pauseClock(broken), /page closed/);
});

test('замер плеера: когда кадр действительно менялся', () => {
  assert.deepEqual(measuredChange([0, 100, 200, 300], [0, 0.04, 0]), { moved: true, firstChangeMs: 100, lastChangeMs: 200 });
  assert.deepEqual(measuredChange([0, 100], [0]), { moved: false });
});

test('переход узла и кадр для плеера находятся по снимку', () => {
  const node = {
    id: '1:2',
    type: 'INSTANCE',
    box: {},
    interactions: [
      { trigger: { type: 'ON_CLICK' }, actions: [] },
      { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: '9:1' }] },
      { trigger: { type: 'ON_CLICK' }, actions: [null, { type: 'NODE', destinationId: '9:2', transition: { type: 'SMART_ANIMATE', duration: 0.7 } }] },
      { trigger: { type: 'ON_PRESS' }, actions: [{ type: 'NODE', destinationId: '9:3', transition: { duration: 0.2 } }] },
    ],
  };
  assert.equal(animatedInteraction(node).to, '9:2', 'переход без длительности пропускается');
  assert.equal(animatedInteraction(node, '9:3').trigger, 'ON_PRESS');
  assert.equal(animatedInteraction(node, '7:7'), null);
  const frame = playerFrame({ ancestors: [{ id: '0:1', type: 'PAGE' }, { id: '1:1', type: 'FRAME', box: { x: 0, y: 0, w: 10, h: 10 } }], nodes: {} }, node);
  assert.equal(frame.id, '1:1');

  /* Снимок целой страницы: экран находится по родителям внутри снимка. */
  const page = {
    ancestors: [{ id: '0:1', type: 'PAGE' }],
    nodes: {
      P: { id: 'P', type: 'CANVAS' },
      S: { id: 'S', type: 'FRAME', parent: 'P', box: { x: 0, y: 0, w: 1440, h: 900 } },
      I: { id: 'I', type: 'INSTANCE', parent: 'S', box: { x: 0, y: 100, w: 100, h: 100 } },
      V: { id: 'V', type: 'COMPONENT', parent: 'K', box: { x: 0, y: 0, w: 10, h: 10 } },
      K: { id: 'K', type: 'COMPONENT_SET', parent: 'P', box: { x: 0, y: 0, w: 10, h: 10 } },
    },
  };
  assert.equal(playerFrame(page, page.nodes.I).id, 'S');
  assert.equal(playerFrame(page, page.nodes.V), null, 'вариант из набора плеер не откроет');
  assert.deepEqual(playerFrame({ ancestors: [{ id: '0:1', type: 'CANVAS' }, { id: '5:5', type: 'FRAME' }], nodes: {} }, node), { id: '5:5', box: null });
});

test('экран для плеера: снимок через REST родителей не знает, их знает снимок страницы', async () => {
  const lone = { root: 'I', nodes: { I: { id: 'I', type: 'INSTANCE', box: { x: 0, y: 100, w: 100, h: 100 } } } };
  const whole = {
    root: 'P',
    nodes: {
      P: { id: 'P', type: 'CANVAS' },
      S: { id: 'S', type: 'FRAME', parent: 'P', box: { x: 0, y: 0, w: 1440, h: 900 } },
      I: { id: 'I', type: 'INSTANCE', parent: 'S', box: { x: 0, y: 100, w: 100, h: 100 } },
    },
  };
  const cached = (...list) => async function* known() {
    yield* list;
  };
  assert.equal((await screenOf(lone, lone.nodes.I, 'KEY', {}, cached(lone, whole))).id, 'S');
  assert.equal(await screenOf(lone, lone.nodes.I, 'KEY', {}, cached(lone)), null);
});

test('длинный текст слоя: в ответе обрезан, со страницей сверяется по полному', () => {
  const long = 'Одинаковое начало абзаца, которое длиннее сорока знаков. Конец';
  const snapshot = {
    nodes: {
      A: { id: 'A', name: 'a', box: { x: 0, y: 0, w: 10, h: 10 }, children: ['T'] },
      T: { id: 'T', name: long, type: 'TEXT', opacity: 0, box: { x: 0, y: 0, w: 10, h: 10 }, text: { chars: long } },
      B: { id: 'B', name: 'b', box: { x: 0, y: 0, w: 10, h: 10 }, children: ['U'] },
      U: { id: 'U', name: long, type: 'TEXT', box: { x: 0, y: 0, w: 10, h: 10 }, text: { chars: long } },
    },
  };
  const design = motionTracks({ snapshot, rootId: 'A' }, { snapshot, rootId: 'B' }, { duration: 0.2, easing: { type: 'LINEAR' } }, { fps: 10 });
  assert.ok(design.tracks[0].text.length <= 40);
  assert.ok(design.tracks[0].layer.length <= 40);
  const opacity = design.tracks[0].values;
  const result = compareMotion(design, { elements: [{ text: long.toLowerCase(), selector: 'p', x: opacity.map(() => 0), y: opacity.map(() => 0), opacity }] });
  assert.equal(result.match, true);
  assert.equal(result.compared, 1);
});

/* Списания и микро-ТЗ. */
test('списание только поштучно: категорию целиком не закрыть, лишнее видно', () => {
  const report = {
    counts: { controlOverlaps: 2 },
    issues: { controlOverlaps: [{ a: { selector: '.one' }, b: { selector: '.ring' } }, { a: { selector: '.two' }, b: { selector: '.ring2' } }] },
  };
  const partial = waiverBook([{ check: 'controlOverlaps', selector: '.one', reason: 'кольцо задумано' }]);
  const left = layoutBlockers(report, partial);
  assert.equal(left.length, 1);
  assert.equal(left[0].what, 'controlOverlaps: 1');

  const whole = waiverBook([{ check: 'controlOverlaps', selector: '*', reason: 'это всё reveal' }]);
  assert.equal(layoutBlockers(report, whole)[0].what, 'controlOverlaps: 2', 'звёздочка ничего не списывает');
  assert.deepEqual(whole.unused(), [{ check: 'controlOverlaps', selector: '*' }]);
});

test('предупреждения библиотек: по одному на вид, со счётчиком и поштучным списанием', () => {
  const entries = [
    { text: 'Swiper Loop Warning: slides' },
    { text: 'Swiper Loop Warning: slides' },
    { text: '[Vue warn]: Missing required prop' },
    { text: 'обычный лог' },
  ];
  const found = likelyDefects(entries);
  assert.deepEqual(found.map((item) => [item.kind, item.count]), [['swiper-loop', 2], ['vue-warn', 1]]);
  const book = waiverBook([{ check: 'page_logs', selector: 'vue-warn', reason: 'предупреждение стороннего виджета' }]);
  assert.deepEqual(consoleBlockers(entries, book).map((item) => item.selector), ['swiper-loop']);
});

test('пункты микро-ТЗ: открытые, закрытые, обычный список не считается', () => {
  const parsed = checklistItems('## Шапка\n- [x] логотип\n- [ ] подсказка один раз\n  * [X] вложенный\n- обычный пункт\n+ [ ] ещё\n');
  assert.deepEqual(parsed, { open: ['подсказка один раз', 'ещё'], done: 2, total: 4 });
});

test('начальное состояние: что было только при загрузке и только после возврата', () => {
  const at = { classes: ['is-solid', 'site'], styles: { color: 'a', opacity: '1' } };
  const back = { classes: ['site', 'is-top'], styles: { color: 'b', opacity: '1' } };
  assert.deepEqual(diffKeyState({ header: at }, { header: back }), [
    { selector: 'header', onlyAtLoad: ['is-solid'], onlyAfterReturn: ['is-top'], styles: { color: { atLoad: 'a', afterReturn: 'b' } } },
  ]);
  assert.deepEqual(diffKeyState({ header: at }, { header: at }), []);
});
