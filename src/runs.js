/**
 * Журнал проверок: что по какому кадру и какой странице уже запускали и чем кончилось.
 *
 * Покрытие сверки раньше жило в памяти процесса: перезапуск стенда — и figma_compare снова
 * писал «sections: не запускался», хотя сверка была. А interaction_audit не записывался вовсе,
 * и проверить «перед отчётом прокликана каждая страница» было не по чему. Отсюда читает
 * page_ready: свежие прогоны берёт как есть, недостающие догоняет сам.
 *
 * Файл лежит в state/ — каталог закрыт для read_project_file и наружу не отдаётся. Под
 * node --test журнал только в памяти: прогоны тестов не должны видеть друг друга.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './constants.js';

const FILE = path.join(DIRS.state, 'runs.json');
const PERSIST = !process.env.NODE_TEST_CONTEXT;

/* Потолок записей в каждом разделе: журнал — не архив, нужен свежий хвост. */
const KEEP = 400;

let data = { frames: {}, pages: {}, behavior: {} };
if (PERSIST) {
  try {
    const loaded = JSON.parse(fsSync.readFileSync(FILE, 'utf8'));
    data = { frames: loaded.frames || {}, pages: loaded.pages || {}, behavior: loaded.behavior || {} };
  } catch {
    /* Нет файла — журнал пуст. Это не ошибка. */
  }
}

let pending = null;
function flush() {
  if (!PERSIST || pending) return;
  pending = setTimeout(async () => {
    pending = null;
    try {
      await fs.mkdir(DIRS.state, { recursive: true });
      await fs.writeFile(FILE, JSON.stringify(data), 'utf8');
    } catch {
      /* Диск недоступен — журнал остаётся в памяти, проверка не падает. */
    }
  }, 200);
  pending.unref?.();
}

function trim(section) {
  const keys = Object.keys(section);
  if (keys.length <= KEEP) return;
  keys
    .sort((a, b) => String(section[a].updated || '').localeCompare(String(section[b].updated || '')))
    .slice(0, keys.length - KEEP)
    .forEach((key) => delete section[key]);
}

/** Ключ страницы: адрес без query и якоря — /news?page=2 и /news одна вёрстка. */
export function pageKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || '');
  }
}

export const frameKey = (ref, version) => `${ref}@${version}`;

const now = () => new Date().toISOString();

/** Записать результат проверки страницы: kind — interaction, layout, forms. */
export function recordPage(url, kind, result) {
  if (!url || /^about:/.test(url)) return;
  const key = pageKey(url);
  const entry = (data.pages[key] ||= {});
  entry[kind] = { at: now(), ...result };
  entry.updated = entry[kind].at;
  trim(data.pages);
  flush();
}

/** Записать сверку кадра. Поля сливаются: semantic и sections приходят разными вызовами. */
export function recordFrame(ref, version, patch) {
  const key = frameKey(ref, version);
  const entry = (data.frames[key] ||= { widths: [] });
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'width') {
      if (value && !entry.widths.includes(value)) entry.widths.push(value);
    } else if (value !== undefined) entry[field] = value;
  }
  entry.updated = now();
  trim(data.frames);
  flush();
  return entry;
}

export function recordBehavior(ref, blocking) {
  data.behavior[ref] = { at: now(), blocking: blocking || null, updated: now() };
  trim(data.behavior);
  flush();
}

export const frameRuns = (ref, version) => data.frames[frameKey(ref, version)] || null;
export const pageRuns = (url) => data.pages[pageKey(url)] || null;
export const behaviorRuns = (ref) => data.behavior[ref] || null;

/** Все сверенные кадры, без версии: для списка «снятые, но не сверенные». */
export const comparedFrames = () => new Set(Object.keys(data.frames).map((key) => key.split('@')[0]));

/** Прогон свежий: не старше maxAgeMin минут. */
export function fresh(run, maxAgeMin) {
  if (!run?.at) return false;
  return Date.now() - Date.parse(run.at) <= maxAgeMin * 60_000;
}

/** Для тестов: начать с пустого журнала. */
export function resetRuns() {
  data = { frames: {}, pages: {}, behavior: {} };
}
