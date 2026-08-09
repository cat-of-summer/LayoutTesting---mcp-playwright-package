import test from 'node:test';
import assert from 'node:assert/strict';
import { toMatcher, rewriteUrl } from '../src/browser/routes.js';

test('glob остаётся строкой — его разбирает сам playwright', () => {
  assert.equal(toMatcher('**/analytics/**'), '**/analytics/**');
  assert.equal(toMatcher('https://site/style.css'), 'https://site/style.css');
});

test('строка вида /…/flags превращается в регулярное выражение', () => {
  const re = toMatcher('/loaded\\/.*\\.jpg$/i');
  assert.ok(re instanceof RegExp);
  assert.equal(re.flags, 'i');
  assert.ok(re.test('https://site/loaded/about/PHOTO.JPG'));
  assert.equal(re.test('https://site/loaded/about/photo.png'), false);
});

test('одиночный слэш в середине не делает из glob регулярное выражение', () => {
  assert.equal(typeof toMatcher('/loaded/**'), 'string');
});

test('rewrite меняет хост и сохраняет путь — то, чего не умеет redirect', () => {
  assert.equal(
    rewriteUrl('http://site.ru/storage/112/photo.jpg', '/^https?:\\/\\/site\\.ru/', 'http://nginx_local'),
    'http://nginx_local/storage/112/photo.jpg',
  );
});

test('rewrite подстрокой заменяет все вхождения', () => {
  assert.equal(
    rewriteUrl('http://cdn.site.ru/a/site.ru/b.jpg', 'site.ru', 'local'),
    'http://cdn.local/a/local/b.jpg',
  );
});

test('в замене работают группы регулярного выражения', () => {
  assert.equal(
    rewriteUrl('http://site.ru/img/1.jpg', '/^https?:\\/\\/site\\.ru\\/img\\/(.+)$/', 'http://local/media/$1'),
    'http://local/media/1.jpg',
  );
});

test('несовпавший адрес остаётся прежним', () => {
  assert.equal(rewriteUrl('http://other.ru/x.jpg', 'site.ru', 'local'), 'http://other.ru/x.jpg');
});
