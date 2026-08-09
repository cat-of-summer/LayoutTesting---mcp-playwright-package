import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSpecificity, normalizePseudo, resolveWinners, specificityLabel, splitDeclarations } from '../src/checks/cssom.js';

const spec = (selector) => specificityLabel(computeSpecificity(selector));

test('специфичность селекторов считается по классам, id и тегам', () => {
  assert.equal(spec('#main'), '1,0,0');
  assert.equal(spec('.intro'), '0,1,0');
  assert.equal(spec('.intro > .info'), '0,2,0');
  assert.equal(spec('.sec_b2b .intro .info'), '0,3,0');
  assert.equal(spec('.projects-page__intro.intro .info'), '0,3,0');
  assert.equal(spec('div.card > p'), '0,1,2');
  assert.equal(spec('a:hover'), '0,1,1');
  assert.equal(spec('.intro::before'), '0,1,1');
  assert.equal(spec('input[type="text"]'), '0,1,1');
});

test('более специфичный селектор перебивает менее специфичный при сравнении вручную', () => {
  const a = computeSpecificity('.intro > .info');
  const b = computeSpecificity('.sec_b2b .intro .info');
  assert.ok(b.b > a.b, 'три класса весомее двух');
});

test('псевдоэлементы нормализуются к виду протокола', () => {
  assert.equal(normalizePseudo('::before'), 'before');
  assert.equal(normalizePseudo(':after'), 'after');
  assert.equal(normalizePseudo('marker'), 'marker');
  assert.equal(normalizePseudo(null), null);
  assert.throws(() => normalizePseudo('::нет-такого'), /Неизвестный псевдоэлемент/);
});

test('побеждает объявленное позже', () => {
  const winners = resolveWinners([
    { name: 'z-index', value: '3', important: false, from: '.a' },
    { name: 'z-index', value: '5', important: false, from: '.b' },
  ]);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].value, '5');
  assert.equal(winners[0].from, '.b');
  assert.deepEqual(winners[0].overridden.map((o) => o.value), ['3']);
});

test('important бьёт объявленное позже', () => {
  const winners = resolveWinners([
    { name: 'color', value: 'red', important: true, from: '.a' },
    { name: 'color', value: 'blue', important: false, from: '.b' },
  ]);
  assert.equal(winners[0].value, 'red');
  assert.equal(winners[0].important, true);
  assert.equal(winners[0].overridden[0].value, 'blue');
});

test('среди нескольких important выигрывает последний', () => {
  const winners = resolveWinners([
    { name: 'color', value: 'red', important: true, from: '.a' },
    { name: 'color', value: 'green', important: true, from: '.b' },
  ]);
  assert.equal(winners[0].value, 'green');
});

test('свойство без конфликта возвращается без перебитых', () => {
  const winners = resolveWinners([{ name: 'position', value: 'relative', important: false, from: '.a' }]);
  assert.deepEqual(winners[0].overridden, []);
});

/**
 * Слепки сняты с CSS.getMatchedStylesForNode на chromium: протокол склеивает авторские
 * объявления (у них есть range) с раскрытым набором лонгхендов (range нет).
 */
const range = { startLine: 1, startColumn: 5, endLine: 1, endColumn: 20 };

test('повтор авторского объявления в раскрытом наборе не превращается в конфликт с самим собой', () => {
  const { declarations, expanded } = splitDeclarations({
    cssProperties: [
      { name: 'color', value: 'rgb(200,30,30)', implicit: false, disabled: false, range },
      { name: 'z-index', value: '5', implicit: false, disabled: false, range },
      { name: 'color', value: 'rgb(200, 30, 30)' },
      { name: 'z-index', value: '5' },
    ],
  });

  assert.deepEqual(declarations.map((d) => d.name), ['color', 'z-index']);
  assert.deepEqual(expanded, []);

  const winners = resolveWinners([...declarations, ...expanded].map((d) => ({ ...d, from: '.a' })));
  assert.deepEqual(winners.map((w) => w.overridden.length), [0, 0]);
});

test('лонгхенды шортката остаются для разбора, но в правило не попадают', () => {
  const { declarations, expanded } = splitDeclarations({
    cssProperties: [
      { name: 'margin', value: '0 auto !important', important: true, implicit: false, disabled: false, range },
      { name: 'margin-top', value: '0px !important', important: true },
      { name: 'margin-left', value: 'auto !important', important: true },
    ],
  });

  assert.deepEqual(declarations.map((d) => d.name), ['margin']);
  assert.deepEqual(expanded.map((d) => d.name), ['margin-top', 'margin-left']);
  assert.ok(expanded.every((d) => d.important), 'важность лонгхендов протокол проставляет сам');
});

test('шорткат перебивает лонгхенд из другого правила', () => {
  const shorthand = splitDeclarations({
    cssProperties: [
      { name: 'margin', value: '0 auto !important', important: true, implicit: false, disabled: false, range },
      { name: 'margin-top', value: '0px !important', important: true },
    ],
  });
  const longhand = splitDeclarations({
    cssProperties: [
      { name: 'margin-top', value: '5px', implicit: false, disabled: false, range },
      { name: 'margin-top', value: '5px' },
    ],
  });

  const winners = resolveWinners([
    ...[...shorthand.declarations, ...shorthand.expanded].map((d) => ({ ...d, from: '.a' })),
    ...[...longhand.declarations, ...longhand.expanded].map((d) => ({ ...d, from: '.b' })),
  ]);

  const marginTop = winners.find((w) => w.property === 'margin-top');
  assert.equal(marginTop.from, '.a', 'important из шортката сильнее позднего лонгхенда');
  assert.deepEqual(marginTop.overridden.map((o) => o.from), ['.b']);
});

test('у правил user-agent авторского набора нет — берётся раскрытый', () => {
  const { declarations, expanded } = splitDeclarations({
    cssProperties: [
      { name: 'display', value: 'block' },
      { name: 'font-weight', value: 'bold' },
    ],
  });

  assert.deepEqual(declarations.map((d) => d.name), ['display', 'font-weight']);
  assert.deepEqual(expanded, []);
});

test('выключенные и пустые объявления отбрасываются', () => {
  const { declarations } = splitDeclarations({
    cssProperties: [
      { name: 'color', value: 'red', disabled: true, range },
      { name: 'border', value: undefined, range },
      { name: 'display', value: 'flex', disabled: false, range },
    ],
  });

  assert.deepEqual(declarations.map((d) => d.name), ['display']);
});
