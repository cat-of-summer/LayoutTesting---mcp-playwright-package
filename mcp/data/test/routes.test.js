import test from 'node:test';
import assert from 'node:assert/strict';
import { toMatcher } from '../src/browser/routes.js';

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
