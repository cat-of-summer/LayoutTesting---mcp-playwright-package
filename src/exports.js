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
 *
 * Относительный EXPORTS_DIR (./exports — так по умолчанию) отвечал только "относительно каталога,
 * где развёрнут стенд", а этот каталог агенту неизвестен: кадр лежал на диске, а найти его было
 * нечем. Тогда путь берётся у ядра — из источника bind-монтирования в /proc/self/mountinfo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './config.js';
import { resolveInside } from './paths.js';

const configuredRoot = () => {
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

/**
 * Строка mountinfo для точки монтирования: корень внутри исходной файловой системы, её тип и
 * источник. Пробелы и обратные слэши в полях экранированы восьмеричными кодами (\040, \134).
 */
export function parseMountinfo(text, mountPoint) {
  const unescape = (value) => value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
  for (const line of String(text || '').split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left.split(' ');
    if (unescape(fields[4] || '') !== mountPoint) continue;
    const [fstype, source] = right.split(' ');
    return { root: unescape(fields[3] || ''), fstype, source: unescape(source || '') };
  }
  return null;
}

/**
 * Путь хоста по источнику монтирования.
 *
 * Стенд в WSL: корень монтирования — путь внутри дистрибутива (/root/Containers/…/exports); из
 * Windows он виден как \\wsl.localhost\<дистрибутив>\…, если имя дистрибутива известно. Docker
 * Desktop: файловая система 9p с источником вида O:\ — корень и есть путь на этом диске.
 */
export function hostFromMount(mount, distro = null) {
  if (!mount?.root?.startsWith('/')) return null;
  const drive = /^([a-z]):\\?$/i.exec(mount.source || '');
  if (mount.fstype === '9p' && drive) {
    const windows = `${drive[1].toUpperCase()}:${mount.root}`;
    return { root: windows, windows };
  }
  /* Том Docker, а не папка хоста: снаружи такой путь ничего не даёт. */
  if (/\/docker\/volumes\//.test(mount.root)) return null;
  return { root: mount.root, windows: windowsForm(mount.root) || (distro ? `//wsl.localhost/${distro}${mount.root}` : null) };
}

const mounts = new Map();
let mountOverride;

async function mountedRoot(dir) {
  if (mountOverride !== undefined) return mountOverride;
  if (!mounts.has(dir)) {
    const text = await fs.readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
    const distro = String(process.env.WSL_DISTRO_NAME || process.env.LT_WSL_DISTRO || '').trim() || null;
    mounts.set(dir, hostFromMount(parseMountinfo(text, dir), distro));
  }
  return mounts.get(dir);
}

/** Для тестов: подставить источник монтирования (null — не найден); undefined — читать из ядра. */
export function setMountedRoot(value) {
  mountOverride = value;
}

/**
 * Корень выгрузки на хосте и его вид из Windows. Абсолютный EXPORTS_DIR — как задан; относительный
 * или пустой — по источнику монтирования, а если и его нет — как задан, с оговоркой в ответе.
 */
async function hostRoots(dir) {
  const configured = configuredRoot();
  const mounted = await mountedRoot(dir);
  if (configured && isHostAbsolute(configured)) {
    return { root: configured, windows: windowsForm(configured) || (mounted?.root === configured ? mounted.windows : null) };
  }
  return mounted || { root: configured, windows: null };
}

/** Путь от корня, если value лежит под ним. Регистр без учёта: диск пишут и O:, и o:. */
function under(value, root) {
  if (!root || !isHostAbsolute(root)) return null;
  const v = value.toLowerCase();
  const r = root.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (v === r || v === `${r}/`) return '';
  return v.startsWith(`${r}/`) ? value.slice(r.length + 1) : null;
}

/** Путь от корня выгрузки: относительный как есть, абсолютный хоста — через корень выгрузки. */
function relativeTarget(saveTo, { root, windows }) {
  const value = String(saveTo).trim().replace(/\\/g, '/');
  if (!isHostAbsolute(value)) return value;
  const rel = under(value, root) ?? under(value, windows);
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
    (url ? ` Пока — скачать по url: ${downloadCommand(url)}` : '')
  );
}

/** Готовая команда скачивания артефакта по url: путь в контейнере с хоста не открывается. */
export function downloadCommand(url, file = null) {
  return `curl -fsSL -o ${file || path.posix.basename(new URL(url).pathname)} ${url}`;
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

  const roots = await hostRoots(dir);
  const rel = relativeTarget(saveTo, roots);
  let target = resolveInside(dir, rel || '.', { what: 'папки выгрузки' });
  const existing = await fs.stat(target).catch(() => null);
  if (!rel || rel.endsWith('/') || existing?.isDirectory()) target = path.join(target, path.basename(source));
  else if (!path.extname(target)) target += path.extname(source);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);

  const inside = path.relative(dir, target).split(path.sep).join('/');
  const { root, windows } = roots;
  return {
    path: inside,
    hostPath: root ? `${root}/${inside}` : null,
    ...(windows ? { windowsPath: `${windows.replace(/\/+$/, '')}/${inside}` } : {}),
    ...(root && !isHostAbsolute(root)
      ? {
          note:
            `${root} — относительно каталога, где развёрнут стенд: источник монтирования не определился.` +
            (url ? ` Скачать: ${downloadCommand(url, path.basename(target))}` : ''),
        }
      : {}),
  };
}
