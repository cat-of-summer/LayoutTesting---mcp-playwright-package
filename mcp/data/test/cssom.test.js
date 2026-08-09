import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSpecificity, normalizePseudo, resolveWinners, specificityLabel } from '../src/checks/cssom.js';

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
