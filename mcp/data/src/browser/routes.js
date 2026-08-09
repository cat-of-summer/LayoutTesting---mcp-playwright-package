/**
 * Перехват сетевых запросов страницы.
 *
 * Три задачи, которые иначе не решаются вовсе:
 *   - отрезать аналитику и чаты, из-за которых страница не доходит до load;
 *   - подменить таблицу стилей или скрипт своей сборкой, не трогая чужой сервер;
 *   - подставить заглушки вместо пустого каталога картинок на локальном стенде.
 *
 * page.route переживает навигацию сам, реестр нужен только чтобы показать правила
 * и счётчик попаданий: молчащее правило иначе не отличить от сработавшего.
 */

import { readLocalFile } from '../checks/static.js';

const MIME = {
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
};

const guessType = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

/**
 * Строка вида /…/flags — регулярное выражение, всё остальное — glob, который
 * playwright понимает сам. Экспортируется ради теста: разбор легко сломать.
 */
export function toMatcher(pattern) {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  return m ? new RegExp(m[1], m[2]) : pattern;
}

let counter = 0;

export function listRoutes(session) {
  return (session.routes || []).map(({ id, pattern, handler, hits, target }) => ({
    id,
    pattern,
    handler,
    target,
    hits,
  }));
}

export async function addRoute(session, { pattern, handler = 'block', body, contentType, status = 200, url, file }) {
  if (!pattern) throw new Error('Нужен pattern.');
  if (handler === 'fulfill' && body === undefined) throw new Error('Для fulfill нужен body.');
  if (handler === 'redirect' && !url) throw new Error('Для redirect нужен url.');
  if (handler === 'file' && !file) throw new Error('Для file нужен file — путь относительно рабочего каталога стенда.');

  session.routes = session.routes || [];
  const entry = {
    id: `route-${(counter += 1)}`,
    pattern,
    handler,
    target: url || file || null,
    hits: 0,
  };

  const fn = async (route, request) => {
    entry.hits += 1;
    switch (handler) {
      case 'block':
        return route.abort();
      case 'fulfill':
        return route.fulfill({ status, contentType: contentType || 'text/plain; charset=utf-8', body });
      case 'file':
        return route.fulfill({
          status,
          contentType: contentType || guessType(file),
          body: await readLocalFile(file),
        });
      case 'redirect':
        return route.continue({ url });
      case 'passthrough':
        return route.continue();
      default:
        throw new Error(`Неизвестный обработчик: ${handler}`);
    }
  };

  // Ошибка внутри обработчика вешает запрос навсегда — страховка обязательна.
  entry.fn = async (route, request) => {
    try {
      await fn(route, request);
    } catch (err) {
      entry.lastError = err.message;
      await route.continue().catch(() => {});
    }
  };

  await session.page.route(toMatcher(pattern), entry.fn);
  session.routes.push(entry);
  return listRoutes(session).at(-1);
}

export async function clearRoutes(session) {
  const count = (session.routes || []).length;
  for (const entry of session.routes || []) {
    await session.page.unroute(toMatcher(entry.pattern), entry.fn).catch(() => {});
  }
  session.routes = [];
  return count;
}
