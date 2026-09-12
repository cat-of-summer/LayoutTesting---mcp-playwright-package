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
import { checkForUpdate, compareVersions, currentVersion, updateNotice, upgradeSteps } from '../src/update.js';

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

/*
 * Плавающий тег и отсутствие тега.
 *
 * Это не экзотика, а конфигурация по умолчанию: docker-bundle.yml прописывает
 * LT_IMAGE_TAG=latest, и он же уезжает в .env.example. Пока сравнение шло через строковое
 * «0» < «latest», стенд при любой выпущенной версии уверенно отвечал «обновлений нет».
 * Здесь закреплено, что он отвечает «неизвестно» и говорит, что именно закрепить.
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

async function check(imageTag, options = {}) {
  const before = process.env.LT_IMAGE_TAG;
  if (imageTag === null) delete process.env.LT_IMAGE_TAG;
  else process.env.LT_IMAGE_TAG = imageTag;
  try {
    return await checkForUpdate('0.4.0', {
      force: true,
      enabled: true,
      fetchImpl: registry('0.0.8').impl,
      cacheFile: cacheFile(),
      ...options,
    });
  } finally {
    if (before === undefined) delete process.env.LT_IMAGE_TAG;
    else process.env.LT_IMAGE_TAG = before;
  }
}

test('закреплённый тег сравнивается как раньше', async () => {
  assert.equal((await check('0.0.7')).updateAvailable, true);
  assert.equal((await check('0.0.8')).updateAvailable, false);
  assert.equal((await check('v0.0.7')).updateAvailable, true, 'префикс v не должен ломать сравнение');
});

test('плавающий тег даёт «неизвестно», а не «обновлений нет»', async () => {
  for (const tag of ['latest', 'stable', 'main']) {
    const result = await check(tag);
    assert.equal(result.updateAvailable, null, `${tag}: сравнивать не с чем, значит неизвестно`);
    assert.match(result.undetermined, new RegExp(tag), 'в объяснении должно быть видно, что именно мешает');
    assert.match(result.hint, /LT_IMAGE_TAG=0\.0\.8/, 'подсказка обязана называть, что закрепить');
  }
});

test('без тега версия кода не подставляется вместо него', async () => {
  /* package.json нумеруется отдельно от тегов релизов: 0.4.0 против 0.0.8. Сравнение этих двух
     чисел давало «вы впереди» — то же самое молчаливое «всё хорошо». */
  const result = await check(null);
  assert.equal(result.updateAvailable, null);
  assert.match(result.undetermined, /package\.json/);
});

test('порядок обновления отдаётся и когда сравнить не вышло', async () => {
  const result = await check('latest');
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
  await checkForUpdate('0.4.0', { force: true, enabled: true, fetchImpl: first.impl, cacheFile: file });
  assert.equal(first.calls.length, 1);

  const second = registry('0.0.8');
  await checkForUpdate('0.4.0', { enabled: true, fetchImpl: second.impl, cacheFile: file });
  assert.equal(second.calls.length, 0, 'кэш моложе шести часов — спрашивать незачем');

  const third = registry('0.0.8');
  const later = Date.now() + 7 * 60 * 60 * 1000;
  await checkForUpdate('0.4.0', { enabled: true, fetchImpl: third.impl, cacheFile: file, now: later });
  assert.equal(third.calls.length, 1, 'через семь часов кэш протух');
});
