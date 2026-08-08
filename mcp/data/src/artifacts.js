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

/** Каталог прогона внутри artifacts/, создаётся при первом обращении. */
export async function runDir(runId) {
  const dir = path.join(DIRS.artifacts, runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Абсолютный путь -> ссылка, которую отдаёт nginx. */
export function publicUrl(absPath) {
  const rel = path.relative(DIRS.artifacts, absPath).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  return `${CONFIG.publicBaseUrl}/${rel}`;
}

/** Единый вид ссылки на артефакт в ответах инструментов. */
export function artifactRef(absPath) {
  return { path: absPath, url: publicUrl(absPath) };
}

export async function ensureDirs() {
  await Promise.all(
    [DIRS.artifacts, DIRS.baselines, DIRS.fixtures].map((d) => fs.mkdir(d, { recursive: true })),
  );
}

export async function writeJson(absPath, data) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, JSON.stringify(data, null, 2), 'utf8');
  return absPath;
}

export async function listRuns() {
  await ensureDirs();
  const entries = await fs.readdir(DIRS.artifacts, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** Оставляет keep последних прогонов, остальные удаляет. */
export async function pruneRuns(keep = CONFIG.artifactsKeep) {
  const runs = await listRuns();
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
