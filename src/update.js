/**
 * Проверка обновлений стенда.
 *
 * Три требования, каждое из которых легко нарушить:
 *
 *   1. Не мешать работе. GitHub может не ответить, лежать, ограничить по частоте, а стенд может
 *      стоять вовсе без выхода в сеть. Ни один такой случай не должен ни задержать запуск, ни
 *      уронить его: проверка обёрнута в таймаут и в try/catch, и любой отказ означает «неизвестно»,
 *      а не ошибку.
 *   2. Не долбить чужой сервер. Неавторизованный лимит GitHub — 60 запросов в час на адрес, а
 *      MCP-сервер перезапускается легко. Результат кладётся в кэш и переспрашивается не чаще
 *      раза в шесть часов, в том числе после перезапуска.
 *   3. Сказать не только «есть обновление», но и что с ним делать. Уведомление без инструкции
 *      заставляет агента гадать или лезть в интернет за документацией.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS, UPDATE } from './config.js';
import { t } from './i18n.js';

const CACHE_FILE = path.join(DIRS.root, '.update-check.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

/** Сравнение версий по числам, а не строкой: '0.10.0' строкой меньше '0.9.0'. */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));

  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    /* Смешанные части (0.2.0 против 0.2.0-rc1) сравниваем как строки: точной семантики
       предрелизов тут не нужно, важно лишь не соврать про «новее». */
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

async function readCache() {
  try {
    const cached = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    if (Date.now() - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS) return cached;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(data) {
  // Кэш — удобство, а не состояние: не записался, значит в следующий раз спросим ещё раз.
  await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8').catch(() => {});
}

async function fetchLatest() {
  const res = await fetch(UPDATE.api, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'layout-testing-mcp' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const data = await res.json();
  return { tag: String(data.tag_name || '').replace(/^v/i, ''), publishedAt: data.published_at || null };
}

/**
 * Как обновляться. Текст живёт здесь, а не в README, потому что читать его будет агент:
 * увидев обновление, он должен сразу понимать порядок действий, не уходя за документацией.
 */
export function upgradeSteps(tag) {
  const version = tag || 'НОВАЯ_ВЕРСИЯ';
  return {
    releases: UPDATE.releases,
    image: `${UPDATE.image}:${version}`,
    fromImage: [
      `docker pull ${UPDATE.image}:${version}`,
      'подставить новый тег в BUNDLE_IMAGE в .env стенда',
      'docker compose up -d',
    ],
    fromSource: [
      'git pull и git submodule update --remote',
      'dockerbundle generate — пересобрать dist/ из docker-bundle.yml',
      'docker compose up -d --build',
    ],
    note:
      'Артефакты, эталоны и архивы обходов лежат в томах и обновление переживают. ' +
      'Каталог state/ с сохранёнными логинами — тоже том, но его стоит проверить отдельно.',
  };
}

/**
 * Текущая версия.
 *
 * Их две, и путать их нельзя. version — версия кода из package.json. imageTag — тег образа, и
 * именно он нужен для docker pull. В сборке они не обязаны совпадать, поэтому тег берём из
 * окружения, если сборка его туда положила.
 */
export function currentVersion(pkgVersion) {
  return {
    version: pkgVersion,
    imageTag: process.env.LT_IMAGE_TAG || process.env.BUNDLE_IMAGE_TAG || null,
  };
}

export async function checkForUpdate(pkgVersion, { force = false } = {}) {
  const current = currentVersion(pkgVersion);

  /* Выключатель нужен стендам без выхода наружу и закрытым контурам: там проверка каждый раз
     упирается в таймаут, и четыре секунды на старте платятся впустую. */
  if (!UPDATE.enabled) return { current, updateAvailable: null, disabled: true };

  if (!force) {
    const cached = await readCache();
    if (cached) return { ...cached, current, fromCache: true };
  }

  try {
    const latest = await fetchLatest();
    const base = current.imageTag || current.version;
    const behind = compareVersions(latest.tag, base) > 0;

    const result = {
      checkedAt: new Date().toISOString(),
      latest: latest.tag,
      publishedAt: latest.publishedAt,
      updateAvailable: behind,
      ...(behind ? { upgrade: upgradeSteps(latest.tag) } : {}),
    };
    await writeCache(result);
    return { ...result, current, fromCache: false };
  } catch (err) {
    /* Недоступность GitHub — не повод для тревоги в отчёте: стенды часто стоят без выхода
       наружу. Говорим «неизвестно» и живём дальше. */
    return {
      checkedAt: new Date().toISOString(),
      current,
      updateAvailable: null,
      unavailable: err.message,
      releases: UPDATE.releases,
    };
  }
}

/** Короткая строка для instructions: агент должен увидеть её, не вызывая ничего. */
export function updateNotice(result) {
  if (!result || result.updateAvailable !== true) return null;
  const from = result.current.imageTag || result.current.version;
  return t({
    ru:
      `Доступно обновление стенда: ${from} → ${result.latest}. ` +
      `Образ ${UPDATE.image}:${result.latest}. Порядок обновления — в stand_info, поле update. ` +
      'На работу это не влияет: всё продолжает работать на текущей версии.',
    en:
      `A stand update is available: ${from} → ${result.latest}. ` +
      `Image ${UPDATE.image}:${result.latest}. Upgrade steps are in stand_info, field update. ` +
      'Nothing is blocked: everything keeps working on the current version.',
  });
}
