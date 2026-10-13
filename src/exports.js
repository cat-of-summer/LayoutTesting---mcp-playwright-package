/**
 * Выгрузка артефакта в папку на хосте.
 *
 * Скриншоты живут в томе стенда, и чтобы отдать кадр человеку файлом, агент скачивал его по url
 * отдельной командой — локальный Playwright писал сразу в нужную папку, и это был довод уйти
 * со стенда. Каталог exports/ — bind на папку хоста (EXPORTS_DIR в .env): копия ложится туда и
 * сразу видна снаружи.
 *
 * Путь на хосте берётся из той же EXPORTS_DIR: .env приходит в контейнер через env_file, и
 * второй переменной, которую надо держать равной первой, не нужно. Он нужен для двух вещей —
 * сказать в ответе, где файл лежит снаружи, и принять saveTo абсолютным путём хоста: агент
 * знает папку своего проекта, а не устройство контейнера.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './config.js';
import { resolveInside } from './paths.js';

const hostRoot = () => {
  const raw = String(process.env.EXPORTS_DIR || '').trim();
  return raw ? raw.replace(/\\/g, '/').replace(/\/+$/, '') : null;
};

/** Абсолютный путь хоста: /home/…, O:/…, O:\…, \\server\share. */
const isHostAbsolute = (value) => /^([a-z]:[\\/]|\/|\\\\)/i.test(value);

/**
 * Тот же каталог глазами Windows, если стенд развёрнут в WSL: /mnt/o/Projects — это O:/Projects.
 *
 * Compose в WSL принимает только путь Linux, а агент на Windows знает свои папки как O:/…, и без
 * сопоставления абсолютный saveTo отвергался бы как «вне папки выгрузки», а hostPath называл бы
 * путь, которого в его оболочке нет.
 */
export function windowsForm(root) {
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(root || '');
  return m ? `${m[1].toUpperCase()}:${m[2] || '/'}` : null;
}

/** Путь от корня, если value лежит под ним. Регистр без учёта: диск пишут и O:, и o:. */
function under(value, root) {
  if (!root || !isHostAbsolute(root)) return null;
  const v = value.toLowerCase();
  const r = root.toLowerCase().replace(/\/+$/, '');
  if (v === r || v === `${r}/`) return '';
  return v.startsWith(`${r}/`) ? value.slice(r.length + 1) : null;
}

/** Путь от корня выгрузки: относительный как есть, абсолютный хоста — через EXPORTS_DIR. */
function relativeTarget(saveTo) {
  const value = String(saveTo).trim().replace(/\\/g, '/');
  if (!isHostAbsolute(value)) return value;
  const root = hostRoot();
  const rel = under(value, root) ?? under(value, windowsForm(root));
  if (rel !== null) return rel;
  throw new Error(
    root
      ? `saveTo ${saveTo} вне папки выгрузки ${root}. Укажите путь внутри неё или от её корня.`
      : `saveTo ${saveTo} — абсолютный путь, а EXPORTS_DIR в .env стенда не задан: не с чем сверить. Укажите путь от корня выгрузки.`,
  );
}

function notConfigured(url) {
  return (
    'Выгрузка на хост не настроена: каталог exports не смонтирован. Включить: EXPORTS_DIR=<папка на хосте> ' +
    'в .env стенда и docker compose up -d.' +
    (url ? ` Пока — скачать по url: curl -fsSL -o <путь> ${url}` : '')
  );
}

/**
 * Скопировать готовый файл в папку выгрузки.
 *
 * saveTo с «/» на конце или без расширения у существующего каталога — папка: имя берётся у
 * исходника. Расширение исходника дописывается, если его нет: «shots/puzzle» — это puzzle.png,
 * а не файл без типа, который человек не откроет двойным кликом.
 */
export async function exportFile(source, saveTo, { url = null, dir = DIRS.exports } = {}) {
  const info = await fs.stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(notConfigured(url));

  const rel = relativeTarget(saveTo);
  let target = resolveInside(dir, rel || '.', { what: 'папки выгрузки' });
  const existing = await fs.stat(target).catch(() => null);
  if (!rel || rel.endsWith('/') || existing?.isDirectory()) target = path.join(target, path.basename(source));
  else if (!path.extname(target)) target += path.extname(source);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);

  const inside = path.relative(dir, target).split(path.sep).join('/');
  const root = hostRoot();
  const windows = windowsForm(root);
  return {
    path: inside,
    hostPath: root ? `${root}/${inside}` : null,
    ...(windows ? { windowsPath: `${windows.replace(/\/+$/, '')}/${inside}` } : {}),
    ...(root && !isHostAbsolute(root) ? { note: `${root} — относительно каталога, где развёрнут стенд` } : {}),
  };
}
