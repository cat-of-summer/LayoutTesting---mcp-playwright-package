/**
 * Подсказки в точке отказа и честные признаки в ответах.
 *
 * Всё здесь — ответ на один и тот же сценарий: нужное знание у стенда было, но лежало в help,
 * а агент вспоминал о нём через пять неудачных вызовов. Поэтому проверяется не формулировка, а
 * то, что рецепт вообще оказывается в ответе, и что его нет там, где он не к месту.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedHostHint, navigationErrorHint, sameDocument } from '../src/browser/response.js';
import { splitVnuMessages } from '../src/checks/static.js';
import { capped } from '../src/tools/shared.js';
import { hiddenHint } from '../src/figma/export.js';

test('отказ соединения на localhost: рецепт с host.docker.internal и тем же портом', () => {
  const hint = navigationErrorHint('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4321/', 'http://localhost:4321/about');
  assert.match(hint, /http:\/\/host\.docker\.internal:4321\/about/);
  assert.match(hint, /0\.0\.0\.0/);
  assert.match(hint, /allowedHosts/);
  assert.ok(navigationErrorHint('NS_ERROR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/'), 'firefox формулирует иначе');
});

test('отказ на host.docker.internal: сервер слушает только 127.0.0.1', () => {
  assert.match(navigationErrorHint('net::ERR_CONNECTION_REFUSED', 'http://host.docker.internal:4321/'), /0\.0\.0\.0/);
});

test('чужой сайт и другие ошибки подсказку не получают', () => {
  assert.equal(navigationErrorHint('net::ERR_CONNECTION_REFUSED', 'https://example.com/'), null);
  assert.equal(navigationErrorHint('net::ERR_CERT_INVALID', 'http://localhost:4321/'), null);
});

test('403 Vite про имя хоста — подсказка про allowedHosts, обычный 403 — нет', () => {
  const vite = 'Blocked request. This host ("host.docker.internal") is not allowed.';
  assert.match(blockedHostHint(403, vite, 'http://host.docker.internal:4321/'), /allowedHosts: \['host\.docker\.internal'\]/);
  assert.equal(blockedHostHint(403, '<h1>Forbidden</h1>', 'http://site/'), null);
  assert.equal(blockedHostHint(200, vite, 'http://site/'), null);
});

test('тот же адрес без якоря — повторный переход', () => {
  assert.equal(sameDocument('http://a/page?x=1#top', 'http://a/page?x=1'), true);
  assert.equal(sameDocument('http://a/page?x=1', 'http://a/page?x=2'), false);
  assert.equal(sameDocument('about:blank', 'http://a/'), false);
});

test('vnu: сообщения о CSS не смешиваются с ошибками разметки', () => {
  const raw = [
    { type: 'error', message: 'CSS: “container-type”: Property “container-type” doesn\'t exist.', extract: 'x' },
    { type: 'error', message: 'CSS: Unrecognized at-rule “@property”', extract: 'x' },
    { type: 'error', message: 'Element “div” not allowed as child of element “ul” in this context.', extract: 'x' },
    { type: 'info', subType: 'warning', message: 'Consider adding a “lang” attribute.', extract: 'x' },
  ];
  const result = splitVnuMessages(raw);
  assert.equal(result.total, 2);
  assert.deepEqual(result.byType, { error: 1, warning: 1 });
  assert.equal(result.css.count, 2);
  assert.ok(result.messages.every((m) => !m.message.startsWith('CSS:')));
  assert.equal(splitVnuMessages(raw.slice(2)).css, undefined, 'без CSS-сообщений поля нет');
});

test('capped: offset за концом списка не выглядит пустым результатом', () => {
  const page = capped([1, 2, 3], { limit: 10, offset: 5 });
  assert.deepEqual(page.items, []);
  assert.match(page.note, /за концом списка/);
  assert.equal(capped([], { offset: 5 }).note, undefined, 'у пустого списка сказать нечего');
});

test('экспорт: скрытый узел и скрытый предок называются прямо, с размером', () => {
  const snapshot = {
    nodes: {
      '1:1': { id: '1:1', type: 'FRAME', name: 'pager', visible: false, children: ['1:2'] },
      '1:2': { id: '1:2', parent: '1:1', type: 'VECTOR', name: 'chevron', box: { x: 0, y: 0, w: 8, h: 14 } },
      '1:3': { id: '1:3', type: 'FRAME', name: 'icon', box: { x: 0, y: 0, w: 24, h: 24 }, children: ['1:4'] },
      '1:4': { id: '1:4', parent: '1:3', type: 'VECTOR', visible: false, box: { x: 0, y: 0, w: 24, h: 24 } },
      '1:5': { id: '1:5', type: 'VECTOR', box: { x: 0, y: 0, w: 24, h: 24 } },
    },
  };
  assert.match(hiddenHint(snapshot, '1:2'), /Скрыт предок 1:1.*8x14.*hidden: true/);
  assert.match(hiddenHint(snapshot, '1:3'), /Все дети узла скрыты/);
  assert.equal(hiddenHint(snapshot, '1:5'), undefined);
});
