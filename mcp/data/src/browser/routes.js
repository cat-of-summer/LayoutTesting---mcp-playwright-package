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

/**
 * Замена в адресе запроса с сохранением пути.
 *
 * `redirect` уводит все совпадения на один фиксированный адрес, и для самого частого
 * случая — «база отдаёт абсолютные ссылки боевого домена» — он бесполезен: пути у картинок
 * разные, а подменить надо только хост.
 *
 * `from` в виде /…/flags — регулярное выражение (в `to` работают $1, $2), иначе —
 * подстрока, заменяется везде, где встретилась.
 */
export function rewriteUrl(url, from, to) {
  const matcher = toMatcher(from);
  return matcher instanceof RegExp ? url.replace(matcher, to) : url.split(from).join(to);
}

let counter = 0;

export function listRoutes(session) {
  return (session.routes || []).map(
    ({ id, pattern, handler, hits, rewrites, target, lastRewrite, lastError }) => ({
      id,
      pattern,
      handler,
      target,
      hits,
      // У rewrite попадание в pattern ещё ничего не значит: адрес мог не содержать
      // то, что заменяем. Без отдельного счётчика правило с полусотней попаданий
      // и нулём замен выглядит рабочим.
      ...(handler === 'rewrite' ? { rewrites } : {}),
      ...(lastRewrite ? { lastRewrite } : {}),
      ...(lastError ? { lastError } : {}),
    }),
  );
}

export async function addRoute(
  session,
  { pattern, handler = 'block', body, contentType, status = 200, url, file, from, to },
) {
  if (!pattern) throw new Error('Нужен pattern.');
  if (handler === 'fulfill' && body === undefined) throw new Error('Для fulfill нужен body.');
  if (handler === 'redirect' && !url) throw new Error('Для redirect нужен url.');
  if (handler === 'file' && !file) throw new Error('Для file нужен file — путь относительно рабочего каталога стенда.');
  if (handler === 'rewrite' && (!from || to === undefined)) {
    throw new Error('Для rewrite нужны from и to — что заменить в адресе и на что.');
  }

  session.routes = session.routes || [];
  const entry = {
    id: `route-${(counter += 1)}`,
    pattern,
    handler,
    target: url || file || (handler === 'rewrite' ? `${from} → ${to}` : null),
    hits: 0,
    rewrites: 0,
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
      case 'rewrite': {
        const next = rewriteUrl(request.url(), from, to);
        if (next === request.url()) return route.continue();
        // Playwright не даёт сменить протокол на лету: без явной ошибки правило
        // выглядело бы сработавшим, а запрос уходил бы по старому адресу.
        if (new URL(next).protocol !== new URL(request.url()).protocol) {
          throw new Error(`rewrite не может сменить протокол: ${request.url()} → ${next}`);
        }
        entry.rewrites += 1;
        entry.lastRewrite = { from: request.url(), to: next };
        return route.continue({ url: next });
      }
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
