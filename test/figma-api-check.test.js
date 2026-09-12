/**
 * Проверка версии Figma API.
 *
 * Как и у проверки обновлений стенда, главное свойство — не мешать: недоступный реестр npm
 * означает «неизвестно», а не ошибку сборки. Реестр подменён, сеть не трогается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PINNED, SPEC_PACKAGES } from '../src/figma/api.js';
import { checkFigmaApi, figmaApiNotice, githubAnnotation } from '../src/figma/api-check.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-api-'));
let cacheNo = 0;
const cacheFile = () => path.join(tmp, `check-${(cacheNo += 1)}.json`);

const bump = (version) => {
  const [major, minor] = version.split('.').map(Number);
  return `${major}.${minor + 1}.0`;
};

function registry(versions) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const name = Object.values(SPEC_PACKAGES).find((pkg) => String(url).includes(pkg));
    return new Response(JSON.stringify({ version: versions[name] }), { status: 200 });
  };
  return { impl, calls };
}

test('закреплённые версии объявлены точно, без диапазонов', () => {
  assert.match(PINNED.rest, /^\d+\.\d+\.\d+$/);
  assert.match(PINNED.plugin, /^\d+\.\d+\.\d+$/);
});

test('отставание называет пакет, обе версии и порядок действий', async () => {
  const npm = registry({ [SPEC_PACKAGES.rest]: bump(PINNED.rest), [SPEC_PACKAGES.plugin]: PINNED.plugin });
  const result = await checkFigmaApi({ fetchImpl: npm.impl, cacheFile: cacheFile(), enabled: true });
  assert.equal(result.outdated, true);
  assert.deepEqual(result.behind, [{ package: SPEC_PACKAGES.rest, pinned: PINNED.rest, latest: bump(PINNED.rest) }]);

  const notice = figmaApiNotice(result);
  assert.ok(notice.includes(`${PINNED.rest} → ${bump(PINNED.rest)}`));
  assert.match(notice, /changelog/);

  const annotation = githubAnnotation(result);
  assert.match(annotation, /^::warning title=Figma API::/);
  assert.ok(!annotation.includes('\n'), 'аннотация GitHub обязана быть однострочной');
});

test('актуальная версия — без предупреждения', async () => {
  const npm = registry({ [SPEC_PACKAGES.rest]: PINNED.rest, [SPEC_PACKAGES.plugin]: PINNED.plugin });
  const result = await checkFigmaApi({ fetchImpl: npm.impl, cacheFile: cacheFile(), enabled: true });
  assert.equal(result.outdated, false);
  assert.equal(figmaApiNotice(result), null);
  assert.equal(githubAnnotation(result), null);
});

test('недоступный реестр — «неизвестно», а не ошибка', async () => {
  const result = await checkFigmaApi({
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    },
    cacheFile: cacheFile(),
    enabled: true,
  });
  assert.equal(result.outdated, null);
  assert.match(result.unavailable, /ENOTFOUND/);
  assert.equal(figmaApiNotice(result), null);
});

test('результат кэшируется, force спрашивает заново', async () => {
  const file = cacheFile();
  const npm = registry({ [SPEC_PACKAGES.rest]: PINNED.rest, [SPEC_PACKAGES.plugin]: PINNED.plugin });
  await checkFigmaApi({ fetchImpl: npm.impl, cacheFile: file, enabled: true });
  const cached = await checkFigmaApi({ fetchImpl: npm.impl, cacheFile: file, enabled: true });
  assert.equal(cached.fromCache, true);
  assert.equal(npm.calls.length, 2);
  await checkFigmaApi({ fetchImpl: npm.impl, cacheFile: file, enabled: true, force: true });
  assert.equal(npm.calls.length, 4);
});

test('выключатель LT_UPDATE_CHECK выключает и эту проверку', async () => {
  const result = await checkFigmaApi({ enabled: false, cacheFile: cacheFile() });
  assert.equal(result.disabled, true);
});
