/**
 * Не ушёл ли Figma API вперёд закреплённой версии.
 *
 * Требования те же, что у проверки обновлений стенда (update.js), и по той же причине: проверка
 * не должна ни задерживать сборку и запуск, ни ронять их. Реестр npm может не ответить, стенд
 * может стоять без выхода наружу — это «неизвестно», а не ошибка. Результат кэшируется на шесть
 * часов и сбрасывается, как только в package.json подняли закреплённые версии.
 *
 * Отставание — не поломка: каналы Figma продолжают работать на закреплённой версии. Предупреждение
 * нужно, чтобы обновление было решением, а не находкой после того, как Figma что-то выключит.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS, UPDATE } from '../constants.js';
import { t } from '../i18n.js';
import { compareVersions } from '../update.js';
import { CHANGELOG_URL, PINNED, SPEC_PACKAGES } from './api.js';

const CACHE_FILE = path.join(DIRS.root, '.figma-api-check.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

async function readCache(file, now) {
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    const pinnedSame = JSON.stringify(cached.pinned) === JSON.stringify(PINNED);
    if (pinnedSame && now - Date.parse(cached.checkedAt) < CACHE_TTL_MS) return cached;
  } catch {
    /* Нет кэша — спросим. */
  }
  return null;
}

async function latestVersion(name, fetchImpl) {
  const res = await fetchImpl(`https://registry.npmjs.org/${name}/latest`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`npm ответил ${res.status} на ${name}`);
  const data = await res.json();
  return String(data.version || '');
}

export async function checkFigmaApi({
  force = false,
  fetchImpl = (...args) => globalThis.fetch(...args),
  cacheFile = CACHE_FILE,
  enabled = UPDATE.enabled,
  now = Date.now(),
} = {}) {
  const pinned = { ...PINNED };
  if (!enabled) return { pinned, outdated: null, disabled: true };

  if (!force) {
    const cached = await readCache(cacheFile, now);
    if (cached) return { ...cached, fromCache: true };
  }

  const checkedAt = new Date(now).toISOString();
  try {
    const keys = Object.keys(SPEC_PACKAGES);
    const versions = await Promise.all(keys.map((key) => latestVersion(SPEC_PACKAGES[key], fetchImpl)));
    const latest = Object.fromEntries(keys.map((key, i) => [key, versions[i]]));
    const behind = keys
      .filter((key) => pinned[key] && latest[key] && compareVersions(latest[key], pinned[key]) > 0)
      .map((key) => ({ package: SPEC_PACKAGES[key], pinned: pinned[key], latest: latest[key] }));
    const result = { checkedAt, pinned, latest, behind, outdated: behind.length > 0 };
    await fs.writeFile(cacheFile, JSON.stringify(result, null, 2), 'utf8').catch(() => {});
    return result;
  } catch (err) {
    return { checkedAt, pinned, outdated: null, unavailable: err.message };
  }
}

export function figmaApiNotice(result) {
  if (!result?.outdated) return null;
  const list = result.behind.map((b) => `${b.package} ${b.pinned} → ${b.latest}`).join(', ');
  return t({
    ru:
      `Figma API ушёл вперёд закреплённой версии: ${list}. Инструменты figma_* продолжают работать на ` +
      `закреплённой. Перед обновлением прочитать журнал изменений ${CHANGELOG_URL}, прогнать тесты ` +
      'figma-* и поднять версии в devDependencies package.json.',
    en:
      `The Figma API moved past the pinned version: ${list}. The figma_* tools keep working on the pinned ` +
      `one. Before upgrading, read the changelog ${CHANGELOG_URL}, run the figma-* tests and bump the ` +
      'versions in devDependencies of package.json.',
  });
}

/** Аннотация GitHub Actions: однострочная, иначе сводка прогона обрежет её на первом переводе. */
export function githubAnnotation(result) {
  const notice = figmaApiNotice(result);
  return notice ? `::warning title=Figma API::${notice.replace(/\s*\n\s*/g, ' ')}` : null;
}
