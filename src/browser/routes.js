/**
 * Перехват сетевых запросов страницы.
 *
 * Три задачи, которые иначе не решаются вовсе:
 *   - отрезать аналитику и чаты, из-за которых страница не доходит до load;
 *   - подменить таблицу стилей или скрипт своей сборкой, не трогая чужой сервер;
 *   - подставить заглушки вместо пустого каталога картинок на локальном стенде.
 *
 * page.route переживает навигацию сам, реестр нужен только чтобы показать правила,
 * счётчик попаданий и, если попросили, сами запросы: молчащее правило иначе не отличить
 * от сработавшего, а счётчик не отвечает на вопрос, что именно ушло на сервер.
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
 * Сколько записей держать на правило.
 *
 * Журнал нужен, чтобы посмотреть, что именно ушло на сервер, а не чтобы хранить трафик:
 * long-poll или опрос статуса иначе забьют память за минуту. Режем старое — разбираются
 * с последней отправкой формы, а не с первой.
 */
const RECORD_KEEP = 50;

/**
 * Заголовки, которые в журнал не попадают.
 *
 * Записи уезжают в переписку с агентом, а cookie сессии и Authorization — это ровно тот
 * доступ, ради которого стенд отдельно прячет пароли из условий просмотра.
 */
const HIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);

const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}…` : value);

/**
 * Разбор multipart вручную.
 *
 * У playwright разбора тела запроса нет, а именно multipart и интересен: «ушли ли в форме
 * поля vacancy, name, phone и сами файлы» — вопрос, на который счётчик попаданий не отвечает.
 * Значения текстовых полей обрезаем, содержимое файлов не читаем вовсе: файл описывается
 * именем, типом и размером, и этого хватает, чтобы понять, что он в запросе есть.
 */
export function parseMultipart(buf, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  let start = buf.indexOf(sep);
  if (start < 0) return null;
  start += sep.length;

  const fields = [];
  while (start < buf.length) {
    // Закрывающая граница помечена двумя дефисами сразу после неё.
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;

    const next = buf.indexOf(sep, start);
    if (next < 0) break;
    // Перед границей стоит CRLF, принадлежащий разделителю, а не значению поля.
    const end = next >= start + 2 ? next - 2 : next;
    fields.push(describePart(buf.subarray(start, end)));
    start = next + sep.length;
  }
  return fields;
}

function describePart(chunk) {
  const split = chunk.indexOf('\r\n\r\n');
  const head = (split < 0 ? chunk : chunk.subarray(0, split)).toString('utf8');
  const body = split < 0 ? Buffer.alloc(0) : chunk.subarray(split + 4);

  const disposition = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] || '';
  const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? null;
  const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
  const contentType = /content-type:\s*([^\r\n]*)/i.exec(head)?.[1]?.trim() || null;

  // Файл от текстового поля отличает наличие filename, а не непустое содержимое: пустой
  // input[type=file] тоже присылает свою часть, и показать её надо именно как файл.
  if (filename !== null) return { name, filename, contentType, bytes: body.length };

  return { name, value: clip(body.toString('utf8'), 200), bytes: body.length };
}

/** Тело запроса в читаемом виде: поля формы, текст или хотя бы размер. */
export function describeRequestBody(request) {
  const buf = request.postDataBuffer();
  if (!buf || !buf.length) return null;

  /* Сравниваем по нижнему регистру, а boundary берём из исходной строки: он
     регистрозависим, и приведённый к нижнему регистру в теле уже не находится. */
  const contentType = String(request.headers()['content-type'] || '');
  const kind = contentType.toLowerCase();
  const bytes = buf.length;

  if (kind.startsWith('multipart/form-data')) {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
    const fields = boundary ? parseMultipart(buf, boundary) : null;
    if (!fields) return { kind: 'multipart', contentType, bytes, note: 'boundary не разобран — поля не показать.' };

    /*
     * Содержимое файлов в тело запроса не попадает: браузер отдаёт оболочку multipart, а сами
     * файлы шлёт отдельным потоком. Видно, что файл прикреплён и как он называется, — и это
     * ровно то, что проверяют. Молчаливый bytes: 0 читался бы как «ушёл пустой файл».
     */
    const emptyFiles = fields.some((f) => f.filename !== undefined && !f.bytes);
    return {
      kind: 'multipart',
      contentType,
      bytes,
      fields,
      ...(emptyFiles
        ? { note: 'Содержимое файлов браузер в тело запроса не отдаёт — видно имя и тип, но не размер.' }
        : {}),
    };
  }

  if (kind.startsWith('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(buf.toString('utf8'));
    return {
      kind: 'form',
      contentType,
      bytes,
      fields: [...params].map(([name, value]) => ({ name, value: clip(value, 200) })),
    };
  }

  if (!kind || /json|text|xml|javascript/.test(kind)) {
    return { kind: 'text', contentType: contentType || null, bytes, text: clip(buf.toString('utf8'), 2000) };
  }

  return { kind: 'binary', contentType, bytes };
}

function capture(entry, request) {
  const headers = {};
  for (const [key, value] of Object.entries(request.headers())) {
    if (HIDDEN_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = clip(String(value), 200);
  }
  entry.recorded.push({
    at: new Date().toISOString(),
    method: request.method(),
    url: clip(request.url(), 500),
    resourceType: request.resourceType(),
    headers,
    body: describeRequestBody(request),
  });
  if (entry.recorded.length > RECORD_KEEP) {
    entry.recorded.splice(0, entry.recorded.length - RECORD_KEEP);
  }
}

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
    ({ id, pattern, handler, hits, rewrites, target, lastRewrite, lastError, record, recorded }) => ({
      id,
      pattern,
      handler,
      target,
      hits,
      // Сколько запросов записано — чтобы не ходить за журналом наугад.
      ...(record ? { recorded: recorded.length } : {}),
      // У rewrite попадание в pattern ещё ничего не значит: адрес мог не содержать
      // то, что заменяем. Без отдельного счётчика правило с полусотней попаданий
      // и нулём замен выглядит рабочим.
      ...(handler === 'rewrite' ? { rewrites } : {}),
      ...(lastRewrite ? { lastRewrite } : {}),
      ...(lastError ? { lastError } : {}),
    }),
  );
}

/**
 * Записанные запросы: что именно ушло на сервер, а не только сколько раз.
 *
 * Хвост, а не начало: разбираются с последней отправкой формы. id сужает до одного правила —
 * иначе заглушка на картинки перебивает своим потоком то единственное, ради чего запись и
 * включали.
 */
export function listRecorded(session, { id = null, limit = 20 } = {}) {
  const routes = (session.routes || []).filter((r) => r.record && (!id || r.id === id));
  if (id && !routes.length) throw new Error(`Правила ${id} с записью нет. Список правил — action: list.`);
  return routes.map((route) => ({
    id: route.id,
    pattern: route.pattern,
    handler: route.handler,
    hits: route.hits,
    total: route.recorded.length,
    requests: route.recorded.slice(-limit),
  }));
}

export async function addRoute(
  session,
  { pattern, handler = 'block', body, contentType, status = 200, url, file, from, to, record = false },
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
    record,
    recorded: [],
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
    /* Запись идёт до обработчика и в своём try: сломанный разбор тела не должен отменять
       подмену, ради которой правило и заводили. */
    if (record) {
      try {
        capture(entry, request);
      } catch (err) {
        entry.lastError = `запись запроса: ${err.message}`;
      }
    }
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
