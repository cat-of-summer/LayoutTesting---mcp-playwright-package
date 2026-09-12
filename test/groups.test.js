/**
 * Разбор выборки групп из адреса подключения.
 *
 * Проверяется то, от чего зависит, какой манифест увидит агент: развернулись ли псевдонимы,
 * добрано ли то, без чего названное не работает, и одинаково ли считаются seo+crawl и crawl+seo.
 * Модуль ничего не тянет за собой, поэтому тест идёт в обычном прогоне, без LT_FULL_TESTS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ALIASES, DEPS, FLOOR, GROUPS, resolveSelection, vocabulary } from '../src/tools/groups.js';

const sorted = (selection) => [...selection.groups].sort();

test('пустой адрес и all дают полный набор', () => {
  for (const spec of ['', '   ', 'all', 'ALL', 'all+figma']) {
    assert.equal(resolveSelection(spec).groups, null, `${spec} должен означать «всё»`);
  }
});

test('названная группа поднимается вместе с полом', () => {
  assert.deepEqual(sorted(resolveSelection('perf')), ['artifacts', 'help', 'perf']);
});

test('зависимости добираются и перечисляются отдельно от названного', () => {
  const sel = resolveSelection('figma');
  assert.deepEqual(sorted(sel), ['artifacts', 'figma', 'help', 'session', 'visual']);
  assert.deepEqual(sel.requested, ['figma'], 'названо было только figma');
  assert.deepEqual(sel.added, ['session', 'visual'], 'добранное должно быть названо явно');
});

test('пол не попадает в added: он есть всегда и объяснения не требует', () => {
  assert.deepEqual(resolveSelection('perf').added, []);
});

test('зависимости транзитивны', () => {
  /* a11y тянет session напрямую; проверяем и цепочку через группу, у которой своя зависимость. */
  assert.ok(resolveSelection('a11y').groups.has('session'));
  assert.ok(resolveSelection('layout').groups.has('session'));
});

test('псевдоним разворачивается в группы, в том числе вложенный', () => {
  const design = resolveSelection('design');
  const sum = resolveSelection('core+figma');
  assert.deepEqual(sorted(design), sorted(sum), 'design — это core плюс figma и ничем больше');
  assert.ok(design.groups.has('figma'));
  assert.ok(design.groups.has('layout'));
  assert.ok(!design.groups.has('crawl'), 'обход сайта в design не входит');
});

test('порядок слагаемых не создаёт разных наборов', () => {
  const a = resolveSelection('seo+crawl');
  const b = resolveSelection('crawl+seo');
  assert.equal(a.key, b.key, 'подпись набора должна быть одинаковой: по ней сверяются сессии');
  assert.deepEqual(sorted(a), sorted(b));
});

test('повтор и пустые слагаемые не ломают разбор', () => {
  assert.equal(resolveSelection('seo++seo+ seo ').key, resolveSelection('seo').key);
});

test('неизвестное имя не проглатывается и не подменяется полным набором', () => {
  const sel = resolveSelection('nosuchgroup');
  assert.deepEqual(sel.unknown, ['nosuchgroup']);
  assert.equal(sel.key, null, 'у нераспознанной выборки подписи нет — подключать нечего');
});

test('неизвестное имя рядом с известным тоже останавливает разбор', () => {
  const sel = resolveSelection('seo+nosuch');
  assert.deepEqual(sel.unknown, ['nosuch']);
});

test('группу можно назвать и по имени из пола', () => {
  /* Бессмысленно, но не ошибка: artifacts и так поднят, и отвечать 400 на это было бы враньём. */
  assert.deepEqual(resolveSelection('help').unknown, []);
});

test('словарь для сообщения об ошибке перечисляет то, что действительно принимается', () => {
  const vocab = vocabulary();
  for (const group of vocab.groups) assert.deepEqual(resolveSelection(group).unknown, []);
  for (const alias of Object.keys(vocab.aliases)) assert.deepEqual(resolveSelection(alias).unknown, []);
  assert.deepEqual(vocab.always, FLOOR);
});

test('псевдонимы и зависимости ссылаются только на существующие группы', () => {
  const known = new Set([...GROUPS, ...FLOOR, ...Object.keys(ALIASES)]);
  for (const [alias, spec] of Object.entries(ALIASES)) {
    for (const part of spec.split('+')) {
      assert.ok(known.has(part), `псевдоним ${alias} ссылается на несуществующее ${part}`);
    }
  }
  for (const [group, deps] of Object.entries(DEPS)) {
    assert.ok(GROUPS.includes(group), `зависимость объявлена у несуществующей группы ${group}`);
    for (const dep of deps) assert.ok(GROUPS.includes(dep), `${group} зависит от несуществующей ${dep}`);
  }
});
