import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG, DIRS } from './config.js';

/** Имя прогона: 2026-08-08T10-22-31_a1b2. Сортируется лексикографически по времени. */
export function newRunId(label = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const salt = Math.random().toString(36).slice(2, 6);
  return [stamp, salt, slug(label)].filter(Boolean).join('_');
}

export function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Кто хочет знать, что в каталоге артефактов появилось новое.
 *
 * Нужен ровно одному месту — списку ресурсов MCP, который иначе показывал бы клиенту состояние
 * на момент подключения. Подписка, а не прямой вызов, потому что artifacts.js не должен знать
 * про существование протокольного слоя: он про файлы.
 */
const changeListeners = new Set();

export function onArtifactsChanged(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notifyChanged() {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      /* Слушатель не должен ронять прогон: он всего лишь хотел знать. */
    }
  }
}

/** Каталог прогона внутри artifacts/, создаётся при первом обращении. */
export async function runDir(runId) {
  const dir = path.join(DIRS.artifacts, runId);
  await fs.mkdir(dir, { recursive: true });
  await autoPrune(runId);
  notifyChanged();
  return dir;
}

/*
 * Автоочистка при заведении нового прогона.
 *
 * artifactsKeep задуман как «сколько держать перед автоочисткой», но чистил только
 * ручной вызов artifacts_clean, и каталог рос до тех пор, пока об этом не вспомнят.
 * Чистим не чаще раза на прогон и никогда — тот прогон, который сейчас заводим.
 */
let lastPrunedFor = null;
async function autoPrune(runId) {
  if (!CONFIG.artifactsKeep || lastPrunedFor === runId) return;
  lastPrunedFor = runId;
  try {
    const runs = await listPrunableRuns();
    for (const run of runs.slice(CONFIG.artifactsKeep)) {
      if (run === runId) continue;
      await fs.rm(path.join(DIRS.artifacts, run), { recursive: true, force: true });
    }
  } catch {
    // Уборка не повод ронять прогон: артефакты важнее свободного места.
  }
}

function relToArtifacts(absPath) {
  const rel = path.relative(DIRS.artifacts, absPath).split(path.sep).join('/');
  return rel.startsWith('..') ? null : rel;
}

/** Абсолютный путь -> ссылка, которую отдаёт nginx наружу. */
export function publicUrl(absPath) {
  const rel = relToArtifacts(absPath);
  return rel === null ? null : `${CONFIG.publicBaseUrl}/${rel}`;
}

/** Та же ссылка, но пригодная для навигации из браузера самого стенда. */
export function internalUrl(absPath) {
  const rel = relToArtifacts(absPath);
  return rel === null ? null : `${CONFIG.internalBaseUrl}/${rel}`;
}

/**
 * Единый вид ссылки на артефакт в ответах инструментов.
 *
 * Ссылок две, и это не избыточность: `url` открывается на машине пользователя,
 * `internalUrl` — из browser_goto, потому что внутри контейнера проброшенного порта нет.
 */
export function artifactRef(absPath) {
  const rel = relToArtifacts(absPath);
  return {
    path: absPath,
    /*
     * Адрес ресурса MCP. Не file:// — он выдал бы наружу устройство контейнера и звал бы
     * клиента лезть в чужую файловую систему. И не публичный http — тот зависит от
     * PUBLIC_BASE_URL, то есть один и тот же артефакт получал бы разную личность на разных
     * стендах, а адрес ресурса обязан быть его именем, а не маршрутом до него.
     */
    uri: rel === null ? null : `lt://artifacts/${rel}`,
    url: publicUrl(absPath),
    internalUrl: internalUrl(absPath),
  };
}

/**
 * Ссылка на файл зеркала. Отдельно от artifactRef, потому что корень nginx — каталог артефактов,
 * а sites/ раздаётся по alias: относительный путь считается от другой базы.
 *
 * Пара ссылок здесь по той же причине, что и у артефактов: url открывается на машине
 * пользователя, internalUrl — из browser_goto внутри контейнера, где проброшенного порта нет.
 */
export function siteRef(absPath) {
  const rel = path.relative(DIRS.sites, absPath).split(path.sep).join('/');
  if (rel.startsWith('..')) return { path: absPath, uri: null, url: null, internalUrl: null };
  return {
    path: absPath,
    uri: `lt://sites/${rel}`,
    url: `${CONFIG.publicBaseUrl}/sites/${rel}`,
    internalUrl: `${CONFIG.internalBaseUrl}/sites/${rel}`,
  };
}

export async function ensureDirs() {
  await Promise.all(
    [DIRS.artifacts, DIRS.baselines, DIRS.fixtures, DIRS.sites, DIRS.state].map((d) => fs.mkdir(d, { recursive: true })),
  );
}

export async function writeJson(absPath, data) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, JSON.stringify(data, null, 2), 'utf8');
  return absPath;
}

/**
 * Как выглядит имя каталога прогона: метка времени из newRunId.
 * Ширина полей фиксированная, поэтому лексикографический порядок совпадает с хронологическим.
 */
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(_|$)/;

async function artifactDirs() {
  await ensureDirs();
  const entries = await fs.readdir(DIRS.artifacts, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Прогоны от свежих к старым.
 *
 * Раньше здесь был простой .sort().reverse() по имени каталога. Пока в artifacts/ лежат одни
 * прогоны, это верно — имя начинается с метки времени. Но каталог, чьё имя начинается не с
 * цифры, в такой сортировке оказывался «самым свежим»: он навсегда занимал место в начале
 * списка, сам не удалялся никогда, а настоящие прогоны за ним вычищались раньше срока.
 * Тестовые каталоги вроде test-isolate застревали именно так.
 *
 * Теперь прогоном считается то, что похоже на прогон. Посторонние каталоги уходят в конец —
 * они по-прежнему видны в artifacts_list, но автоочистка их не трогает: положил их туда
 * человек, ему и решать.
 */
export async function listRuns() {
  const names = await artifactDirs();
  const runs = names.filter((n) => RUN_ID.test(n)).sort().reverse();
  const rest = names.filter((n) => !RUN_ID.test(n)).sort();
  return [...runs, ...rest];
}

/** Только настоящие прогоны — то, что имеет право удалять очистка. */
export async function listPrunableRuns() {
  const names = await artifactDirs();
  return names.filter((n) => RUN_ID.test(n)).sort().reverse();
}

/** Оставляет keep последних прогонов, остальные удаляет. Посторонние каталоги не трогает. */
export async function pruneRuns(keep = CONFIG.artifactsKeep) {
  const runs = await listPrunableRuns();
  const doomed = runs.slice(keep);
  for (const run of doomed) {
    await fs.rm(path.join(DIRS.artifacts, run), { recursive: true, force: true });
  }
  return doomed;
}

export function baselinePath(name, profileKey = '') {
  const file = [slug(name), profileKey && slug(profileKey)].filter(Boolean).join('__');
  return path.join(DIRS.baselines, `${file}.png`);
}
