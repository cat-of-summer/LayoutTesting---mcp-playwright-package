/**
 * Единственная проверка границы пути на весь стенд.
 *
 * Раньше их было три независимых: resolveInsideRoot в checks/static.js, своя в read_project_file
 * и своя по каталогу артефактов в read_artifact. Три копии одного правила разъезжаются молча —
 * и разъехались бы на первом же новом каталоге.
 *
 * Все три сравнивали через abs.startsWith(base), а это не граница каталога: путь
 * /var/www/html-evil начинается с /var/www/html и проверку проходил. Считаем через
 * path.relative — тем же способом, каким уже устроен relToArtifacts в artifacts.js.
 */
import path from 'node:path';
import { DIRS } from './config.js';

/**
 * Каталоги под корнем стенда, которые не отдаются наружу ни одним инструментом.
 *
 * state/ хранит storageState — куки живых сессий, включая боевые логины. Он лежит под корнем,
 * потому что это точка монтирования тома, а не потому, что его можно читать: nginx его не
 * раздаёт, и read_project_file с browser_route(file) не должны тоже.
 */
export const DENIED_DIRS = ['state'];

function insideOf(base, abs) {
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Абсолютный путь внутри base — или внятная ошибка вместо утечки. */
export function resolveInside(base, target, { what = 'рабочего каталога' } = {}) {
  const abs = path.resolve(base, String(target ?? ''));
  if (!insideOf(base, abs)) {
    throw new Error(`Путь ${target} выходит за пределы ${what}.`);
  }
  const [head] = path.relative(DIRS.root, abs).split(path.sep);
  if (DENIED_DIRS.includes(head)) {
    throw new Error(`Каталог ${head}/ закрыт: там лежат сохранённые сессии и куки.`);
  }
  return abs;
}

export const resolveInRoot = (target) => resolveInside(DIRS.root, target, { what: 'рабочего каталога стенда' });
export const resolveInArtifacts = (target) => resolveInside(DIRS.artifacts, target, { what: 'каталога артефактов' });
