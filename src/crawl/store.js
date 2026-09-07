/**
 * Состояние обхода на диске.
 *
 * Диск здесь не кэш, а единственный источник правды. Причина в границе процессов: задача живёт
 * в памяти MCP-сервера, а `lt` — это каждый раз новый процесс, который в чужую память не
 * заглянет. Поэтому и прогресс, и признак остановки лежат в файлах: остановить обход можно
 * откуда угодно, и переживёт это даже перезапуск сервера.
 *
 * Три файла на сайт:
 *   site.json     — настройки обхода, статус, счётчики;
 *   frontier.json — очередь: что ждёт, что взято, что готово, что не вышло;
 *   index.json    — карта «адрес → страница» для выборок и для переписывания ссылок.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../config.js';
import { normalizeUrl } from './url.js';

export const siteDir = (siteId) => path.join(DIRS.sites, siteId);
const fileIn = (siteId, name) => path.join(siteDir(siteId), name);

/**
 * Статусы обхода.
 *
 * stale — не поломка, а честность: задача жила в памяти процесса, процесс перезапустился,
 * и running в файле остался от прошлой жизни. Показывать его как идущий обход значит врать
 * о прогрессе, которого нет.
 */
export const STATUSES = ['running', 'paused', 'stopping', 'done', 'failed', 'stale'];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Файл ${path.basename(file)} повреждён: ${err.message}`);
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  /* Пишем через временный файл с переименованием: обход обрывается посреди записи чаще, чем
     хотелось бы, а наполовину записанный frontier.json — это потерянная очередь. */
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export const readSite = (siteId) => readJson(fileIn(siteId, 'site.json'), null);
export const writeSite = (siteId, data) => writeJson(fileIn(siteId, 'site.json'), data);
export const readFrontier = (siteId) => readJson(fileIn(siteId, 'frontier.json'), null);
export const writeFrontier = (siteId, data) => writeJson(fileIn(siteId, 'frontier.json'), data);
export const readIndex = (siteId) => readJson(fileIn(siteId, 'index.json'), { pages: {} });
export const writeIndex = (siteId, data) => writeJson(fileIn(siteId, 'index.json'), data);

export async function listSites() {
  await fs.mkdir(DIRS.sites, { recursive: true });
  const entries = await fs.readdir(DIRS.sites, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const site = await readSite(entry.name);
    out.push({
      siteId: entry.name,
      url: site?.url ?? null,
      status: site?.status ?? 'неизвестен',
      pages: site?.stats?.saved ?? null,
      startedAt: site?.startedAt ?? null,
    });
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function removeSite(siteId) {
  /* maxRetries — не суеверие: обход мог не успеть закрыть последнюю запись, и rm натыкается
     на файл, появившийся между обходом каталога и его удалением. */
  await fs.rm(siteDir(siteId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return siteId;
}

/**
 * Очередь уникальных адресов.
 *
 * Всё, что когда-либо попадало в поле зрения, остаётся в seen — включая то, что мы решили не
 * скачивать. Без этого не ответить на вопрос «закрыто в robots, но залинковано изнутри»:
 * выброшенный из очереди адрес просто исчезает вместе с тем, кто на него ссылался.
 */
export function createFrontier(seed = {}) {
  return {
    pending: seed.pending || [],
    done: seed.done || [],
    failed: seed.failed || [],
    /** адрес → {depth, from, reason} для всего, что решено не брать */
    skipped: seed.skipped || {},
    seen: seed.seen || [],
  };
}

export function frontierState(frontier) {
  const seen = new Set(frontier.seen);
  return {
    has: (url) => seen.has(url),
    add(entry) {
      const url = normalizeUrl(entry.url);
      if (seen.has(url)) return false;
      seen.add(url);
      frontier.seen.push(url);
      frontier.pending.push({ ...entry, url });
      return true;
    },
    skip(entry, reason) {
      const url = normalizeUrl(entry.url);
      if (seen.has(url)) return false;
      seen.add(url);
      frontier.seen.push(url);
      /* Записываем и того, кто сослался: без источника находка «закрыто, но залинковано»
         не показывает, где чинить. */
      frontier.skipped[url] = { depth: entry.depth ?? null, from: entry.from ?? null, reason };
      return true;
    },
    take: () => frontier.pending.shift() || null,
    size: () => frontier.pending.length,
  };
}
