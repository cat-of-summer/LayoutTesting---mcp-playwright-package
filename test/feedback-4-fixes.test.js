/**
 * Правки по четвёртому отзыву — вёрстка по Figma, заход 3: ошибки, дошедшие до дизайнера, и то,
 * как стенд мог поймать их сам. Почти все — про состояния (hover, выбранное, раскрытое) и цвет,
 * а сверка была статической. Здесь всё, что считается без браузера; действия на странице — в
 * feedback-4-e2e.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { perform } from '../src/browser/act.js';
import { expandStates, STEP_TIMEOUT_MS } from '../src/checks/states.js';
import { topIssues } from '../src/checks/layout.js';
import { fresh, frameRuns, pageKey, pageRuns, recordFrame, recordPage, resetRuns } from '../src/runs.js';
import {
  formBlockers,
  frameBlockers,
  interactionBlockers,
  interactionScope,
  layoutBlockers,
  readyWidths,
} from '../src/checks/ready.js';
import { noteCoverage, sectionDigest } from '../src/tools/figma.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectTokens, statePalette } from '../src/figma/analyze/tokens.js';
import { colorWordHint } from '../src/figma/analyze/comments.js';
import { analyzeSheets, cssFindings } from '../src/checks/css-live.js';
import { dropBackgroundRect, tracedReason } from '../src/figma/export.js';
import { alignHints } from '../src/figma/spacing.js';
import { searchRestDocument } from '../src/figma/snapshot.js';
import { inkOffsets } from '../src/figma/compare.js';
import { blockingOf, describeBehavior } from '../src/figma/analyze/behavior.js';
import { compareHover, diffVariants, isStateVariant, pickPair, variantProps } from '../src/figma/variants.js';
import { blockPrint, sameBlocks } from '../src/figma/analyze/components.js';
import { assetInventory } from '../src/figma/assets.js';
import { paintNotes } from '../src/figma/css.js';
import { summarize } from '../src/audit.js';

/* Страница-заглушка: только то, что трогают проверяемые функции. */
function fakePage(groups = {}) {
  const waits = [];
  return {
    waits,
    waitForTimeout: async (ms) => waits.push(ms),
    locator: (selector) => {
      const items = groups[selector] || [];
      return {
        count: async () => items.length,
        nth: (i) => ({ evaluate: async (fn) => fn(items[i]) }),
      };
    },
  };
}

test('wait: пауза числом мс в value — без селектора и без duration', async () => {
  const page = fakePage();
  const done = await perform({ page }, { action: 'wait', value: '400' });
  assert.deepEqual(done, { action: 'wait', ms: 400 });
  assert.deepEqual(page.waits, [400]);
  await assert.rejects(perform({ page }, { action: 'wait' }), /пауза в мс/);
});

test('states: each раскрывается в состояние на каждый элемент группы, с подписью элемента', async () => {
  const pin = (label) => ({ innerText: '', getAttribute: (name) => (name === 'aria-label' ? label : null) });
  const page = fakePage({ '[data-pin]': [pin('Байконур'), pin('Восточный')] });
  const states = await expandStates(page, [
    { name: 'Меню', steps: [{ action: 'click', selector: '.burger' }] },
    { each: '[data-pin]', steps: [{ action: 'wait', value: '300' }] },
    { each: '.nothing' },
  ]);
  assert.deepEqual(states.map((s) => s.name), ['Меню', '[data-pin] [1] Байконур', '[data-pin] [2] Восточный', '.nothing']);
  assert.deepEqual(states[2].steps, [
    { action: 'click', selector: '[data-pin] >> nth=1' },
    { action: 'wait', value: '300' },
  ]);
  assert.match(states[3].missing, /ничего нет/);
  assert.equal(STEP_TIMEOUT_MS, 5000, 'шаг состояния не ждёт полминуты');
});

test('states: each упирается в max и говорит, сколько осталось', async () => {
  const item = { innerText: 'Таб', getAttribute: () => null };
  const page = fakePage({ '.tab': Array(20).fill(item) });
  const states = await expandStates(page, [{ each: '.tab', max: 3 }]);
  assert.equal(states.length, 3);
  assert.match(states[0].note, /первые 3 из 20/);
});

test('выжимка ширины: coveredText и textOverImage не отрезаются хвостом списка', () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ selector: `${prefix}${i}` }));
  const top = topIssues({
    issues: {
      boxOverflow: many(5, 'b'),
      tinyTargets: many(5, 't'),
      lowContrast: many(5, 'l'),
      overlaps: many(2, 'o'),
      coveredText: many(1, 'c'),
      textOverImage: many(1, 'i'),
    },
  });
  const categories = top.map((item) => item.category);
  assert.equal(top.length, 8);
  assert.ok(categories.includes('coveredText') && categories.includes('textOverImage'));
  assert.equal(categories[0], 'overlaps', 'серьёзные идут первыми');
});

test('figma_behavior: не снятая цель ховера — блокирующая находка с готовым figma_sync', () => {
  const hover = { trigger: 'ON_HOVER', action: 'NODE:CHANGE_TO', sources: [{ id: '1:2', label: 'Карточка миссии' }] };
  const nav = { trigger: 'ON_CLICK', action: 'NODE:NAVIGATE', sources: [{ id: '1:3', label: 'Ссылка' }] };
  const found = blockingOf([
    { group: nav, ref: 'FILE:9:9' },
    { group: hover, ref: 'FILE:176:6346' },
  ]);
  assert.equal(found.kind, 'notSynced');
  assert.equal(found.targets[0].ref, 'FILE:176:6346', 'состояния элемента — первыми');
  assert.equal(found.targets[0].state, true);
  assert.deepEqual(found.next, { tool: 'figma_sync', args: { figma: ['FILE:176:6346', 'FILE:9:9'] } });
  assert.match(found.what, /состояния элементов/);
  assert.equal(blockingOf([]), null);
});

test('журнал прогонов: сверка кадра сливается по полям, страница — без query', () => {
  resetRuns();
  recordFrame('F:1:1', 'v1', { semantic: '2026-10-18T10:00:00.000Z', width: 1440 });
  recordFrame('F:1:1', 'v1', { sections: { at: '2026-10-18T10:05:00.000Z', worst: [] }, width: 1440 });
  const entry = frameRuns('F:1:1', 'v1');
  assert.equal(entry.semantic, '2026-10-18T10:00:00.000Z');
  assert.ok(entry.sections);
  assert.deepEqual(entry.widths, [1440]);
  assert.equal(frameRuns('F:1:1', 'v2'), null, 'другая версия макета — другая сверка');

  assert.equal(pageKey('http://site.test/news?page=2#top'), 'http://site.test/news');
  recordPage('http://site.test/news?page=2', 'interaction', { silent: [] });
  assert.ok(pageRuns('http://site.test/news').interaction.at);
  recordPage('about:blank', 'interaction', {});
  assert.equal(pageRuns('about:blank'), null);

  assert.ok(fresh({ at: new Date().toISOString() }, 30));
  assert.ok(!fresh({ at: new Date(Date.now() - 31 * 60_000).toISOString() }, 30));
  assert.ok(!fresh(null, 30));
});

test('покрытие: sections пишутся в журнал вместе с худшими секциями', () => {
  resetRuns();
  const result = {
    sections: {
      sections: [
        { node: '1:5', name: 'Процесс подготовки', diffPercentage: 31.2, match: false },
        { node: '1:4', name: 'Герой', diffPercentage: 4.1, match: false },
      ],
    },
  };
  const coverage = noteCoverage('COV4:1:1', 'v1', { mode: 'both', sections: true, width: 1440, frameWidth: 1440, result });
  assert.notEqual(coverage.sections, 'не запускался');
  assert.equal(coverage.note, undefined, 'semantic и sections были — пропусков нет');
  assert.equal(frameRuns('COV4:1:1', 'v1').sections.worst[0].name, 'Процесс подготовки');
  assert.deepEqual(sectionDigest({}), {});

  /* Сверка не в той ширине кадр не покрывает и в журнал как сверка не идёт. */
  const off = noteCoverage('COV4:2:1', 'v1', { mode: 'both', sections: true, width: 1440, frameWidth: 380, result });
  assert.equal(off.sections, 'не запускался');
});

test('page_ready: блокеры layout_audit из ответа любой формы', () => {
  const report = (counts, issues = {}) => ({ total: 1, counts, issues });
  /* Одна ширина. */
  assert.equal(layoutBlockers(report({ overlaps: 1, lowContrast: 3 }, { overlaps: [{ selector: '.a' }] })).length, 1);
  /* По ширинам и в состояниях: skipped — не блокер, error — блокер. */
  const across = {
    base: { byWidth: { 375: { counts: { clippedText: 2 }, top: [{ category: 'clippedText', selector: '.t' }] }, 1440: { counts: {} } } },
    states: {
      Фильтры: {
        byWidth: {
          375: { counts: { overlaps: 1 }, top: [{ category: 'overlaps', selector: '.filters__apply' }] },
          1440: { skipped: 'шаг 1: .filters-toggle не виден на 1440px' },
        },
        applicable: [375],
      },
      Сломанное: { byWidth: { 375: { error: 'шаг 2: не найден' } }, applicable: [], error: 'Состояние не создано ни на одной ширине' },
    },
  };
  const blockers = layoutBlockers(across);
  assert.ok(blockers.some((b) => b.where === 'страница, 375px' && /clippedText: 2/.test(b.what)));
  assert.ok(blockers.some((b) => b.where === 'состояние «Фильтры», 375px' && b.example === '.filters__apply'));
  assert.ok(!blockers.some((b) => /1440px/.test(b.where)), 'ширина, где состояние не применимо, не блокирует');
  assert.ok(blockers.some((b) => /Сломанное/.test(b.where)));
  /* textOverImage блокирует только с чернилами. */
  assert.equal(layoutBlockers(report({ textOverImage: 2 }, { textOverImage: [{ ink: 0.01 }, { ink: 0.4, selector: '.cap' }] }))[0].what, 'textOverImage: 1');
  assert.deepEqual(layoutBlockers(report({ textOverImage: 1 }, { textOverImage: [{}] })), []);
});

test('page_ready: мёртвые кнопки, ховер без изменения, формы и кадр без sections', () => {
  const interaction = interactionBlockers({ silent: ['.slider__next (click)'], hoverInvisible: ['.tech (hover)'] });
  assert.equal(interaction.length, 2);
  assert.equal(formBlockers({ forms: [{ selector: 'form №1', issues: [{ kind: 'invalidAccepted', selector: '#email' }] }] })[0].where, '#email');
  assert.deepEqual(formBlockers({ forms: [] }), []);
  const frame = frameBlockers('F:1:1', { semantic: 'x' }, 'http://site.test/');
  assert.match(frame[0].what, /sections/);
  assert.deepEqual(frame[0].next, { tool: 'figma_compare', args: { figma: 'F:1:1', url: 'http://site.test/', sections: true } });
  assert.deepEqual(frameBlockers('F:1:1', { semantic: 'x', sections: { at: 'y' } }), []);
});

test('page_ready: ширины из кадров и полный охват интерактива', () => {
  assert.deepEqual(readyWidths([1440, 380]), [380, 768, 1024, 1280, 1440]);
  assert.deepEqual(readyWidths([]), [375, 768, 1024, 1440]);
  assert.deepEqual(readyWidths([1440]), [375, 1440]);
  assert.equal(interactionScope(null, ['hover', 'click']), 'all:click+hover');
  assert.equal(interactionScope(null), 'all:click', 'только клик — не полный прогон');
  assert.equal(interactionScope(['.a'], ['click', 'hover']), 'selectors');
});

/* --- Волна 2: ховеры и состояния против макета, наложения ------------------------------- */

const box = (x, y, w, h) => ({ x, y, w, h });
const solid = (r, g, b, a = 1) => ({ kind: 'solid', color: { r, g, b, a } });
function snapshotOf(nodes, root) {
  const map = {};
  for (const node of nodes) map[node.id] = node;
  for (const node of nodes) for (const id of node.children || []) if (map[id]) map[id].parent = node.id;
  return { fileKey: 'KEY', root, version: '1', channel: 'rest', nodes: map };
}

/* Карточка миссии: в Hover меняется не только корень, но и кнопка внутри. */
function missionSet() {
  const variant = (id, name, { radius, btnFill, btnStroke, textColor }) => [
    { id, type: 'COMPONENT', name, box: box(0, 0, 300, 200), radius, fills: [solid(20, 20, 30)], children: [`${id}b`] },
    {
      id: `${id}b`,
      type: 'FRAME',
      name: 'Button',
      box: box(16, 150, 140, 36),
      radius: 8,
      fills: btnFill ? [btnFill] : undefined,
      strokes: btnStroke ? [btnStroke] : undefined,
      children: [`${id}t`],
    },
    { id: `${id}t`, type: 'TEXT', name: 'Label', box: box(24, 158, 120, 20), text: { chars: 'Детали миссии', style: { size: 14 } }, fills: [textColor] },
  ];
  return snapshotOf(
    [
      { id: 'set', type: 'COMPONENT_SET', name: 'Mission card', box: box(0, 0, 700, 200), children: ['d', 'h'] },
      ...variant('d', 'State=Default', { radius: 4, textColor: solid(255, 255, 255) }),
      ...variant('h', 'State=Hover', {
        radius: 12,
        btnFill: solid(231, 235, 112, 0.06),
        btnStroke: solid(231, 235, 112, 0.1),
        textColor: solid(248, 251, 140),
      }),
    ],
    'set',
  );
}

test('figma_variants: Default → Hover по всем потомкам — радиус корня, фон и обводка кнопки, цвет текста', () => {
  const snapshot = missionSet();
  const variants = ['d', 'h'].map((id) => snapshot.nodes[id]);
  const pair = pickPair(variants, {});
  assert.deepEqual([pair.from.id, pair.to.id], ['d', 'h']);
  assert.equal(pickPair(variants, { to: 'Pressed' }).error, 'Вариант «Pressed» не найден');
  assert.ok(isStateVariant('State=Hover') && !isStateVariant('State=Default') && !isStateVariant('Size=L'));
  assert.deepEqual(variantProps('State=Hover, Size=L'), { State: 'Hover', Size: 'L' });

  const diff = diffVariants(snapshot, 'd', snapshot, 'h');
  const has = (prop, node) => diff.changes.find((c) => c.prop === prop && node.test(c.node));
  assert.equal(has('radius', /корень/).to, '12');
  assert.match(has('fills', /Button/).to, /rgba\(231, 235, 112, 0\.06\)/);
  assert.match(has('strokes', /Button/).to, /rgba\(231, 235, 112, 0\.1\)/);
  assert.equal(has('fills', /Label/).to, '#f8fb8c');
  assert.equal(has('fills', /Label/).category, 'textColor');
});

test('figma_variants: ховер страницы, перенесённый только по корню, — кнопка в missingOnPage', () => {
  const snapshot = missionSet();
  const diff = diffVariants(snapshot, 'd', snapshot, 'h');
  const onlyRoot = [{ node: 'article.mission «Детали миссии»', prop: 'border-top-left-radius', from: '4px', to: '12px' }];
  const partial = compareHover(diff, onlyRoot);
  assert.ok(partial.matched.some((m) => /radius/.test(m.design)));
  assert.ok(partial.missingOnPage.some((m) => /Button/.test(m.node) && m.prop === 'fills'));
  assert.ok(partial.missingOnPage.some((m) => /Label/.test(m.node)));

  const btn = 'a.mission__btn «Детали миссии»';
  const full = compareHover(diff, [
    ...onlyRoot,
    { node: btn, prop: 'background-color', from: 'rgba(0, 0, 0, 0)', to: 'rgba(231, 235, 112, 0.06)' },
    { node: btn, prop: 'border-top-color', from: 'rgba(0, 0, 0, 0)', to: 'rgba(231, 235, 112, 0.1)' },
    { node: btn, prop: 'color', from: 'rgb(255, 255, 255)', to: 'rgb(248, 251, 140)' },
    { node: 'span.arrow', prop: 'transform', from: 'none', to: 'matrix(1, 0, 0, 1, 4, 0)' },
  ]);
  assert.deepEqual(full.missingOnPage, []);
  assert.ok(full.extraOnPage.some((p) => p.prop === 'transform'), 'то, чего в варианте нет, — отдельно');
});

test('figma_components: таймлайн главной и внутренней страницы — один блок разной длины', () => {
  const step = (id, x) => [
    { id: `${id}`, type: 'FRAME', name: 'Step', box: box(x, 0, 100, 80), children: [`${id}d`, `${id}t`, `${id}s`] },
    { id: `${id}d`, type: 'ELLIPSE', name: 'dot', box: box(x, 0, 12, 12) },
    { id: `${id}t`, type: 'TEXT', name: 't', box: box(x, 20, 100, 20), text: { chars: 'Этап', style: { size: 16 } } },
    { id: `${id}s`, type: 'TEXT', name: 's', box: box(x, 44, 100, 20), text: { chars: 'Описание', style: { size: 14 } } },
  ];
  const timeline = (prefix, n, name) => [
    { id: `${prefix}tl`, type: 'GROUP', name, box: box(0, 0, 600, 100), children: Array.from({ length: n }, (_, i) => `${prefix}${i}`) },
    ...Array.from({ length: n }, (_, i) => step(`${prefix}${i}`, i * 120)).flat(),
  ];
  const home = snapshotOf([{ id: 'A', type: 'FRAME', name: 'Главная', box: box(0, 0, 1440, 900), children: ['atl'] }, ...timeline('a', 4, 'Group 5')], 'A');
  const inner = snapshotOf(
    [{ id: 'B', type: 'FRAME', name: 'Запуск', box: box(0, 0, 1440, 900), children: ['btl'] }, ...timeline('b', 5, 'Процесс подготовки запуска')],
    'B',
  );
  const blocks = sameBlocks([
    { snapshot: home, rootId: 'A', ref: 'KEY:A' },
    { snapshot: inner, rootId: 'B', ref: 'KEY:B' },
  ]);
  const tl = blocks.find((block) => block.members.some((m) => m.name === 'Group 5'));
  assert.ok(tl, JSON.stringify(blocks));
  assert.deepEqual(tl.members.map((m) => m.name).sort(), ['Group 5', 'Процесс подготовки запуска']);
  assert.match(blockPrint(home, home.nodes.atl), /\*/, 'повторы свёрнуты');
});

test('figma_spec: фон-картинка секции — отдельной строкой; прозрачность слоя с блюром подложки — подсказка', () => {
  const snapshot = snapshotOf(
    [
      { id: 'R', type: 'FRAME', name: 'Главная', box: box(0, 0, 1440, 2000), fills: [solid(10, 11, 16)], children: ['S'] },
      { id: 'S', type: 'FRAME', name: 'Hero', box: box(0, 0, 1440, 900), fills: [{ kind: 'image', ref: 'abc', scaleMode: 'FILL', opacity: 0.4 }], children: ['T'] },
      { id: 'T', type: 'TEXT', name: 'Заголовок', box: box(100, 100, 400, 60), text: { chars: 'Заголовок', style: { size: 48 } } },
    ],
    'R',
  );
  const inventory = assetInventory(snapshot, 'R');
  assert.equal(inventory.backgrounds.length, 1);
  assert.match(inventory.backgrounds[0].line, /op 0\.4 поверх #0a0b10.*на всю высоту/);
  assert.deepEqual(inventory.items.find((item) => item.id === 'S').background, { opacity: 0.4, over: '#0a0b10' });

  const notes = paintNotes({ opacity: 0.4, effects: [{ type: 'backdrop', blur: 6 }] });
  assert.ok(notes.some((note) => /переносите на содержимое/.test(note)));
  assert.equal(paintNotes({ opacity: 0.4, effects: [{ type: 'drop', blur: 6 }] }), undefined);
});

test('audit: сводка называет категории находок, а не только их число', () => {
  const summary = summarize({ layout: { total: 3, counts: { coveredText: 2, overlaps: 1, lowContrast: 0, boxOverflowClipped: 4 } } });
  assert.deepEqual(summary.layoutByCategory, { coveredText: 2, overlaps: 1 });
  assert.match(summary.verdict, /эвристики вёрстки: 3 \(coveredText 2, overlaps 1\)/);
});

/* --- Волна 3: цвет, экспорт, поиск по файлу, подсказки ----------------------------------- */

test('figma_tokens: роль цвета — Dark Yell горит в состояниях кита, green — только тег статуса', () => {
  const yellow = solid(231, 235, 112);
  const green = solid(129, 249, 137);
  const snapshot = snapshotOf(
    [
      { id: 'K', type: 'FRAME', name: 'UI kit', box: box(0, 0, 1000, 600), children: ['set', 'tag'] },
      { id: 'set', type: 'COMPONENT_SET', name: 'Button', box: box(0, 0, 400, 100), children: ['bd', 'bh', 'ba'] },
      { id: 'bd', type: 'COMPONENT', name: 'State=Default', box: box(0, 0, 100, 40), fills: [solid(30, 30, 40)] },
      { id: 'bh', type: 'COMPONENT', name: 'State=Hover', box: box(120, 0, 100, 40), fills: [yellow] },
      { id: 'ba', type: 'COMPONENT', name: 'State=Active', box: box(240, 0, 100, 40), fills: [yellow], strokes: [yellow] },
      { id: 'tag', type: 'FRAME', name: 'Tag / Успешно', box: box(0, 200, 80, 24), fills: [green], children: ['tt'] },
      { id: 'tt', type: 'TEXT', name: 'Успешно', box: box(8, 204, 60, 16), text: { chars: 'Успешно', style: { size: 12 } }, fills: [green] },
    ],
    'K',
  );
  const tokens = collectTokens([{ snapshot, rootId: 'K', ref: 'KEY:K' }], { minUses: 1 });
  const palette = statePalette(tokens.colors);
  assert.equal(palette[0].value, '#e7eb70');
  assert.equal(palette[0].share, 1);
  assert.ok(!palette.some((entry) => entry.value === '#81f989'), 'зелёный в состояниях не стоит');
  assert.match(tokens.roles, /#e7eb70: 100% цветов в состояниях/);
  assert.match(tokens.roles, /#81f989: только теги и статусы/);

  const hint = colorWordHint([{ id: 't1', message: 'Подсвечивается зелёным, как активные элементы в UI-ките' }], palette);
  assert.equal(hint.words[0].word, 'зелёный');
  assert.match(hint.words[0].note, /Ни один цвет состояний макета не зелёный.*#e7eb70/);
  const brand = colorWordHint([{ id: 't2', message: 'цвет фирменный' }], palette);
  assert.equal(brand.words[0].stateColors[0].value, '#e7eb70');
  assert.equal(colorWordHint([{ id: 't3', message: 'поправить отступ' }], palette), null);
});

test('lint_css по странице: угаданная переменная библиотеки, состояние по умолчанию, ховер вне палитры', async () => {
  const html = await fs.readFile(new URL('../fixtures/library-vars.html', import.meta.url), 'utf8');
  const sheets = [...html.matchAll(/<style id="(\w+)">([\s\S]*?)<\/style>/g)].map((m, index) => ({ index, href: null, text: m[2] }));
  const result = cssFindings(analyzeSheets(sheets), { palette: [{ name: '--dark-yell', value: '#e7eb70' }] });
  const unused = result.unusedCustomProperty.find((item) => item.name === '--lib-color-selected');
  assert.ok(unused, JSON.stringify(result));
  assert.equal(unused.didYouMean, '--lib-cell-background-color-selected');
  assert.deepEqual(result.libraryDefault.map((item) => item.name), ['--lib-cell-background-color-in-range']);
  assert.deepEqual(result.stateColorOffPalette.map((item) => item.selector), ['.news__arrow:hover'], 'var(--brand) из :root — в палитре');
  assert.ok(!result.unusedCustomProperty.some((item) => item.name === '--brand'));
});

test('figma_export: Traced Image и белая подложка под вектором — предупреждение, подложка снимается', () => {
  const snapshot = snapshotOf(
    [
      { id: 'L', type: 'FRAME', name: 'Logo', box: box(0, 0, 120, 40), fills: [solid(255, 255, 255)], children: ['v'] },
      { id: 'v', type: 'VECTOR', name: 'Vector', box: box(0, 0, 119, 40) },
      { id: 'T', type: 'FRAME', name: 'Traced Image', box: box(0, 0, 50, 50), children: [] },
      { id: 'I', type: 'FRAME', name: 'Icon', box: box(0, 0, 24, 24), fills: [solid(10, 10, 10)], children: ['iv'] },
      { id: 'iv', type: 'VECTOR', name: 'Vector', box: box(0, 0, 24, 24) },
    ],
    'L',
  );
  assert.match(tracedReason(snapshot, snapshot.nodes.L), /белая подложка/);
  assert.match(tracedReason(snapshot, snapshot.nodes.T), /Traced Image/);
  assert.equal(tracedReason(snapshot, snapshot.nodes.I), null);
  const svg = '<svg viewBox="0 0 120 40"><rect width="120" height="40" fill="white"/><path d="M0 0h10v10z" fill="#1A1A1A"/></svg>';
  const cleaned = dropBackgroundRect(svg);
  assert.ok(cleaned.dropped);
  assert.ok(!cleaned.svg.includes('<rect'));
  assert.equal(dropBackgroundRect('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="white"/></svg>').dropped, false, 'мелкий прямоугольник — не подложка');
});

test('figma_spacing: кнопки «Подробнее» соседних карточек на 642 и 645 — вероятно, одна линия', () => {
  const card = (id, x, y, buttonY) => [
    { id, type: 'FRAME', name: 'Card', box: box(x, y, 300, 450), children: [`${id}b`] },
    { id: `${id}b`, type: 'FRAME', name: 'Подробнее', box: box(x + 20, buttonY, 120, 40) },
  ];
  const snapshot = snapshotOf(
    [{ id: 'R', type: 'FRAME', name: 'Row', box: box(0, 0, 1000, 800), children: ['a', 'b'] }, ...card('a', 0, 240, 642), ...card('b', 320, 245, 645)],
    'R',
  );
  const hints = alignHints(snapshot, 'R');
  assert.ok(hints.some((hint) => /Подробнее/.test(hint.what) && hint.values.join() === '642,645'), JSON.stringify(hints));
  assert.ok(hints.some((hint) => hint.what === 'Card' && hint.values.join() === '240,245'));
});

test('figma_find: поиск по документу REST находит кнопку и набор вариантов вокруг неё', () => {
  const document = {
    id: '0:0',
    type: 'DOCUMENT',
    children: [
      {
        id: '0:1',
        type: 'CANVAS',
        name: 'UI kit',
        children: [
          {
            id: '9:1',
            type: 'COMPONENT_SET',
            name: 'Gallery',
            children: [
              { id: '9:2', type: 'COMPONENT', name: 'State=Collapsed', children: [{ id: '9:3', type: 'TEXT', name: 'btn', characters: 'Загрузить больше материалов' }] },
              { id: '9:4', type: 'COMPONENT', name: 'State=Expanded', children: [] },
            ],
          },
        ],
      },
    ],
  };
  const [hit] = searchRestDocument(document, 'загрузить больше');
  assert.equal(hit.id, '9:3');
  assert.equal(hit.page, 'UI kit');
  assert.equal(hit.set.name, 'Gallery');
  assert.equal(hit.set.variant, 'State=Collapsed');
  assert.deepEqual(hit.set.variants, ['State=Collapsed', 'State=Expanded']);
});

test('figma_compare: посадка капса в плашке — по чернилам, а не по текстовому боксу', async () => {
  const sharp = (await import('sharp')).default;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ink-'));
  /* Плашка 60×16 на тёмном фоне, «текст» — полоса 6px: в макете по центру, на странице на 2px выше. */
  const pill = async (file, inkTop) => {
    const w = 60;
    const h = 16;
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const ink = y >= inkTop && y < inkTop + 6 && x >= 10 && x < 50;
        data[i] = ink ? 255 : 30;
        data[i + 1] = ink ? 255 : 30;
        data[i + 2] = ink ? 255 : 30;
        data[i + 3] = 255;
      }
    }
    await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
  };
  const design = path.join(dir, 'design.png');
  const page = path.join(dir, 'page.png');
  await pill(design, 5);
  await pill(page, 3);
  const pair = {
    design: { text: 'ЗАПУСК', box: box(10, 3, 40, 10), frame: { name: 'Tag', box: box(0, 0, 60, 16) } },
    page: { text: 'ЗАПУСК', selector: '.tag', box: box(10, 3, 40, 10) },
  };
  const found = await inkOffsets({
    pairs: [pair],
    image: design,
    imageMeta: { width: 60, height: 16 },
    pageFile: page,
    pageMeta: { width: 60, height: 16 },
    pageOrigin: { x: 0, y: 0 },
    lift: 0,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].shift, -2);
  assert.match(found[0].why, /выше на 2px/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('одинаковые демо-данные: переключаемые элементы с одним текстом — эффект не будет виден', () => {
  const item = (id, y) => ({
    id,
    type: 'FRAME',
    name: 'News item',
    box: box(0, y, 300, 40),
    children: [`${id}t`],
    interactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', navigation: 'CHANGE_TO', destinationId: 'N2' }] }],
  });
  const text = (id, y) => ({ id, type: 'TEXT', name: 'title', box: box(0, y, 300, 20), text: { chars: 'Запуск спутника', style: { size: 16 } } });
  const snapshot = snapshotOf(
    [{ id: 'N', type: 'FRAME', name: 'Новости', box: box(0, 0, 400, 300), children: ['n1', 'n2'] }, item('n1', 0), text('n1t', 0), item('n2', 60), text('n2t', 60)],
    'N',
  );
  const behavior = describeBehavior([{ snapshot, rootId: 'N', ref: 'KEY:N' }]);
  assert.match(behavior.grouped[0].sameContent, /эффект переключения не будет виден/);
});
