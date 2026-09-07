/**
 * Проверка обновлений.
 *
 * Главное свойство здесь — не «находит новую версию», а «не мешает». Стенд часто стоит без
 * выхода наружу, GitHub ограничивает частоту, сеть отваливается. Любой такой случай обязан
 * означать «неизвестно», а не ошибку и не задержку запуска.
 *
 * Сеть в тестах не трогаем: проверяется сравнение версий и форма ответа при отказе.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, currentVersion, updateNotice, upgradeSteps } from '../src/update.js';

test('версии сравниваются по числам, а не по строке', () => {
  /* Ровно та ошибка, ради которой функция и написана: строкой '0.10.0' меньше '0.9.0',
     и стенд рапортовал бы об откате как об обновлении. */
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('префикс v не мешает сравнению', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('v1.2.4', '1.2.3'), 1);
});

test('недостающие части считаются нулями', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.1', '1.2'), 1);
});

test('предрелиз не считается новее релиза по ошибке', () => {
  assert.notEqual(compareVersions('1.0.0-rc1', '1.0.0'), 0);
});

test('уведомление появляется только при настоящем обновлении', () => {
  const current = { version: '0.2.0', imageTag: null };
  assert.equal(updateNotice({ updateAvailable: false, current }), null);
  assert.equal(updateNotice({ updateAvailable: null, current }), null);
  assert.equal(updateNotice(null), null);

  const notice = updateNotice({ updateAvailable: true, latest: '0.3.0', current });
  assert.match(notice, /0\.2\.0 → 0\.3\.0/);
  /* Обязательная часть: агент не должен решить, что стенд сломан и работать нельзя. */
  assert.match(notice, /продолжает работать/);
});

test('уведомление опирается на тег образа, если он известен', () => {
  const notice = updateNotice({
    updateAvailable: true,
    latest: '0.0.6',
    current: { version: '0.2.0', imageTag: '0.0.5' },
  });
  /* Для docker pull важен тег образа, а не версия кода: они не обязаны совпадать. */
  assert.match(notice, /0\.0\.5 → 0\.0\.6/);
});

test('инструкция по обновлению даёт оба пути и не молчит про данные', () => {
  const steps = upgradeSteps('0.3.0');
  assert.match(steps.image, /ghcr\.io\/.*:0\.3\.0$/);
  assert.ok(steps.fromImage.some((s) => s.includes('docker pull')));
  assert.ok(steps.fromSource.some((s) => s.includes('dockerbundle')));
  assert.match(steps.note, /том/);
});

test('версия кода и тег образа различаются как отдельные поля', () => {
  const before = process.env.LT_IMAGE_TAG;
  process.env.LT_IMAGE_TAG = '0.0.5';
  const cur = currentVersion('0.2.0');
  assert.equal(cur.version, '0.2.0');
  assert.equal(cur.imageTag, '0.0.5');
  if (before === undefined) delete process.env.LT_IMAGE_TAG;
  else process.env.LT_IMAGE_TAG = before;
});

/* Источник обновлений вынесен в конфигурацию: у форка репозиторий и реестр свои, и менять их
   правкой исходника значит расходиться с апстримом в файле, который потом придётся мерджить. */
test('источник обновлений берётся из конфигурации', async () => {
  const { UPDATE } = await import('../src/config.js');
  assert.match(UPDATE.api, /^https:\/\/api\.github\.com\/repos\/.+\/releases\/latest$/);
  assert.match(UPDATE.releases, /^https:\/\/github\.com\/.+\/releases$/);
  assert.ok(UPDATE.api.includes(UPDATE.repo), 'адрес API обязан строиться из repo');
  assert.equal(typeof UPDATE.enabled, 'boolean');

  assert.ok(upgradeSteps('1.2.3').image.startsWith(UPDATE.image + ':'));
});
