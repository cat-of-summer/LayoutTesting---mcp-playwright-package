/**
 * Разбор адресов и сводка неудачных запросов. Браузер здесь не нужен.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { sanitizeUrl, summarizeFailures } from '../src/browser/pool.js';
import { artifactRef, publicUrl, internalUrl } from '../src/artifacts.js';
import { DIRS, CONFIG } from '../src/config.js';

test('логин и пароль вычищаются из адреса', () => {
  assert.equal(sanitizeUrl('http://user:pass@example.com/photo'), 'http://example.com/photo');
  assert.equal(sanitizeUrl('http://example.com/photo'), 'http://example.com/photo');
});

test('нераспознанный адрес возвращается как есть, а не роняет вызов', () => {
  assert.equal(sanitizeUrl('не адрес вовсе'), 'не адрес вовсе');
});

test('без неудачных запросов сводки нет', () => {
  const entries = [{ url: 'http://a/1', status: 200, failure: null }];
  assert.equal(summarizeFailures(entries), null);
});

test('сводка считает и отказы сети, и ответы 4xx/5xx', () => {
  const entries = [
    { url: 'http://a/ok', status: 200, failure: null, resourceType: 'document' },
    { url: 'http://a/1.jpg', status: null, failure: 'net::ERR_NAME_NOT_RESOLVED', resourceType: 'image' },
    { url: 'http://a/2.jpg', status: 404, failure: null, resourceType: 'image' },
    { url: 'http://a/x.js', status: 500, failure: null, resourceType: 'script' },
  ];
  const summary = summarizeFailures(entries);
  assert.equal(summary.failedRequests, 3);
  assert.deepEqual(summary.byResourceType, { image: 2, script: 1 });
});

test('в примерах отказов нет логина из адреса', () => {
  const summary = summarizeFailures([
    { url: 'http://user:pass@a/1.jpg', status: 404, failure: null, resourceType: 'image' },
  ]);
  assert.ok(!summary.firstFailures[0].url.includes('pass'), 'пароль не должен попадать в отчёт');
});

test('примеров отказов ограниченное число — иначе отчёт раздувается', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    url: `http://a/${i}.jpg`,
    status: 404,
    failure: null,
    resourceType: 'image',
  }));
  const summary = summarizeFailures(entries);
  assert.equal(summary.failedRequests, 40);
  assert.equal(summary.firstFailures.length, 5);
});

test('у артефакта две ссылки: наружу и изнутри стенда', () => {
  const file = path.join(DIRS.artifacts, 'run-1', 'shot.png');
  const ref = artifactRef(file);

  assert.equal(ref.url, `${CONFIG.publicBaseUrl}/run-1/shot.png`);
  assert.equal(ref.internalUrl, `${CONFIG.internalBaseUrl}/run-1/shot.png`);
  assert.notEqual(
    ref.url,
    ref.internalUrl,
    'проброшенный порт снаружи и порт внутри контейнера — разные адреса',
  );
});

test('путь вне каталога артефактов ссылки не получает', () => {
  assert.equal(publicUrl('/etc/passwd'), null);
  assert.equal(internalUrl('/etc/passwd'), null);
});
