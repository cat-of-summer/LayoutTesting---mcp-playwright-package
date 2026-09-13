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
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { checkForUpdate, compareVersions, currentImageTag, updateNotice, upgradeSteps } from '../src/update.js';

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

/*
 * Тег образа читается из BUNDLE_IMAGE — того самого ref, который правят при обновлении.
 * Отдельной переменной под тег больше нет: две записи одного факта расходились.
 */
test('тег образа берётся из хвоста BUNDLE_IMAGE', () => {
  assert.equal(currentImageTag('ghcr.io/owner/app:0.0.9'), '0.0.9');
  assert.equal(currentImageTag('ghcr.io/owner/app:latest'), 'latest');
  assert.equal(currentImageTag('  ghcr.io/owner/app:1.2.3  '), '1.2.3', 'пробелы из .env не мешают');
});

test('порт реестра не принимается за тег', () => {
  assert.equal(currentImageTag('localhost:5000/app'), null);
  assert.equal(currentImageTag('localhost:5000/app:0.0.9'), '0.0.9');
});

test('дайджест тега не несёт', () => {
  assert.equal(currentImageTag('ghcr.io/owner/app@sha256:abc123'), null);
  assert.equal(currentImageTag('ghcr.io/owner/app:0.0.9@sha256:abc123'), '0.0.9');
});

test('без BUNDLE_IMAGE тега нет', () => {
  assert.equal(currentImageTag(''), null);
  assert.equal(currentImageTag(undefined), null);
  assert.equal(currentImageTag('ghcr.io/owner/app'), null);
});

test('уведомление появляется только при настоящем обновлении', () => {
  const current = { imageTag: '0.2.0' };
  assert.equal(updateNotice({ updateAvailable: false, current }), null);
  assert.equal(updateNotice({ updateAvailable: null, current }), null);
  assert.equal(updateNotice(null), null);

  const notice = updateNotice({ updateAvailable: true, latest: '0.3.0', current });
  assert.match(notice, /0\.2\.0 → 0\.3\.0/);
  /* Обязательная часть: агент не должен решить, что стенд сломан и работать нельзя. */
  assert.match(notice, /продолжает работать/);
});

/*
 * Инструкция для агента. docker pull и правка одной строки — это не обновление: docker-compose.yml
 * в релизе описывает тома и healthcheck, и новый образ со старым compose поднимается неверно.
 */
test('инструкция по обновлению ведёт к файлам релиза, а не только к образу', () => {
  const steps = upgradeSteps('0.3.0');
  assert.match(steps.image, /ghcr\.io\/.*:0\.3\.0$/);
  assert.match(steps.files['docker-compose.yml'], /\/releases\/download\/v0\.3\.0\/docker-compose\.yml$/);
  /* Имя ассета не совпадает с именем файла: GitHub не принимает имена с точки в начале. */
  assert.match(steps.files['.env.example'], /\/download\/v0\.3\.0\/default\.env\.example$/);
  assert.ok(steps.fromImage.some((s) => s.includes('docker pull')));
  assert.ok(steps.fromImage.some((s) => s.includes('docker-compose.yml')), 'compose из релиза — обязательный шаг');
  assert.ok(steps.fromImage.some((s) => s.includes('.env') && s.includes('не перезаписывать')), 'про .env сказано явно');
  assert.ok(steps.fromImage.some((s) => s.includes('BUNDLE_IMAGE=')));
  assert.ok(steps.fromSource.some((s) => s.includes('dockerbundle')));
  assert.match(steps.note, /том/);
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

/*
 * Плавающий тег и отсутствие тега.
 *
 * Это не экзотика, а конфигурация по умолчанию: docker-bundle.yml собирает образ как :latest, и
 * он же уезжает в .env.example. Пока сравнение шло через строковое «0» < «latest», стенд при
 * любой выпущенной версии уверенно отвечал «обновлений нет». Здесь закреплено, что он отвечает
 * «неизвестно» и говорит, что именно закрепить.
 */
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-check-'));
let seq = 0;
const cacheFile = () => path.join(tmp, `check-${(seq += 1)}.json`);

const registry = (tag) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ tag_name: `v${tag}`, published_at: '2026-09-12T10:14:33Z' }), { status: 200 });
  };
  return { impl, calls };
};

async function check(image, options = {}) {
  const before = process.env.BUNDLE_IMAGE;
  if (image === null) delete process.env.BUNDLE_IMAGE;
  else process.env.BUNDLE_IMAGE = image;
  try {
    return await checkForUpdate({
      force: true,
      enabled: true,
      fetchImpl: registry('0.0.8').impl,
      cacheFile: cacheFile(),
      ...options,
    });
  } finally {
    if (before === undefined) delete process.env.BUNDLE_IMAGE;
    else process.env.BUNDLE_IMAGE = before;
  }
}

test('закреплённый тег сравнивается с релизом', async () => {
  assert.equal((await check('ghcr.io/o/a:0.0.7')).updateAvailable, true);
  assert.equal((await check('ghcr.io/o/a:0.0.8')).updateAvailable, false);
  assert.equal((await check('ghcr.io/o/a:v0.0.7')).updateAvailable, true, 'префикс v не должен ломать сравнение');
});

test('плавающий тег даёт «неизвестно», а не «обновлений нет»', async () => {
  for (const tag of ['latest', 'stable', 'main']) {
    const result = await check(`ghcr.io/o/a:${tag}`);
    assert.equal(result.updateAvailable, null, `${tag}: сравнивать не с чем, значит неизвестно`);
    assert.match(result.undetermined, new RegExp(tag), 'в объяснении должно быть видно, что именно мешает');
    assert.match(result.hint, /BUNDLE_IMAGE=.*:0\.0\.8/, 'подсказка обязана называть, что закрепить');
  }
});

test('без BUNDLE_IMAGE стенд не выдумывает версию', async () => {
  const result = await check(null);
  assert.equal(result.updateAvailable, null);
  assert.equal(result.current.imageTag, null);
  assert.match(result.undetermined, /BUNDLE_IMAGE/);
});

test('порядок обновления отдаётся и когда сравнить не вышло', async () => {
  const result = await check('ghcr.io/o/a:latest');
  assert.ok(result.upgrade, 'без инструкции подсказка «закрепите тег» повисает в воздухе');
  assert.ok(result.upgrade.image.endsWith(':0.0.8'));
});

test('уведомление в instructions молчит, пока сравнение не состоялось', () => {
  assert.equal(updateNotice({ updateAvailable: null, latest: '0.0.8', current: { imageTag: 'latest' } }), null);
});

/* Требование из шапки модуля: «переспрашивается не чаще раза в шесть часов, в том числе после
   перезапуска». Держится оно на том, что кэш лежит в томе, но проверить здесь можно ровно то,
   от чего зависит поведение: свежий кэш GitHub не дёргает, протухший — дёргает. */
test('свежий кэш не ходит в сеть, протухший ходит', async () => {
  const file = cacheFile();
  const first = registry('0.0.8');
  await checkForUpdate({ force: true, enabled: true, fetchImpl: first.impl, cacheFile: file });
  assert.equal(first.calls.length, 1);

  const second = registry('0.0.8');
  await checkForUpdate({ enabled: true, fetchImpl: second.impl, cacheFile: file });
  assert.equal(second.calls.length, 0, 'кэш моложе шести часов — спрашивать незачем');

  const third = registry('0.0.8');
  const later = Date.now() + 7 * 60 * 60 * 1000;
  await checkForUpdate({ enabled: true, fetchImpl: third.impl, cacheFile: file, now: later });
  assert.equal(third.calls.length, 1, 'через семь часов кэш протух');
});
