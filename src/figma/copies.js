/**
 * Копии файлов в черновиках аккаунта стенда.
 *
 * Файл, открытый аккаунту только на просмотр, редактор Figma показывает без Plugin API: канал
 * редактора в нём не работает в принципе, сколько ни жди window.figma. Копия в черновиках
 * принадлежит аккаунту стенда, и в ней канал работает. Здесь хранится связь «ключ оригинала →
 * ключ копии»: снимки, ссылки и кэш остаются под ключом оригинала, редактор открывает копию.
 *
 * Связь лежит рядом с кэшем файла, в figma/<ключ>/copy.json, и переживает перезапуск стенда.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../constants.js';

const copyPath = (fileKey, cacheDir) => path.join(cacheDir, fileKey, 'copy.json');

export async function readCopy(fileKey, { cacheDir = DIRS.figma } = {}) {
  if (!fileKey) return null;
  try {
    const data = JSON.parse(await fs.readFile(copyPath(fileKey, cacheDir), 'utf8'));
    return data?.copyKey ? data : null;
  } catch {
    return null;
  }
}

export async function writeCopy(fileKey, data, { cacheDir = DIRS.figma } = {}) {
  const file = copyPath(fileKey, cacheDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export async function removeCopy(fileKey, { cacheDir = DIRS.figma } = {}) {
  await fs.rm(copyPath(fileKey, cacheDir), { force: true });
}
