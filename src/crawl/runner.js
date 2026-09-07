/**
 * Обход сайта.
 *
 * Гибридный режим: сначала обычный HTTP-запрос — дёшево и показывает ровно то, что видит
 * поисковый робот, не исполняющий скрипты. Если ответ выглядит пустым, страница переоткрывается
 * в браузере. Обе версии сохраняются, и расхождение между ними само по себе находка: «контент
 * появляется только после JS».
 *
 * Задача живёт в памяти этого процесса, но останов и прогресс — на диске (см. store.js).
 * Причина простая: `lt crawl stop` запускается отдельным процессом, который в эту память не
 * заглянет. Признак в файле работает откуда угодно и переживает перезапуск сервера.
 *
 * Браузер у обхода свой, отдельно от сессий агента, и контекст пересоздаётся каждые
 * CONTEXT_EVERY страниц: на длинном обходе память течёт, и утекает она у того, кто рядом
 * работает руками.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { closeSession, createSession, gotoAndSettle } from '../browser/pool.js';
import { pageDirOf, savePage } from '../mirror/save.js';
import { seoFromHtml, seoFromPage } from '../seo/page.js';
import { crawlDelayMs, isAllowed, parseRobots } from './robots.js';
import { normalizeUrl, pageIdFor, sameHost, sameSite, siteIdFor, tryNormalize } from './url.js';
import {
  createFrontier,
  frontierState,
  readFrontier,
  readIndex,
  readSite,
  writeFrontier,
  writeIndex,
  writeSite,
} from './store.js';

/** Живые задачи процесса. Тот же приём, что у browsers и sessions в browser/pool.js. */
const jobs = new Map();

const CONTEXT_EVERY = 25;
/** Как часто сбрасывать очередь на диск. На каждую страницу — диск становится узким местом. */
const FLUSH_EVERY = 5;

export const DEFAULTS = {
  maxPages: 500,
  maxDepth: 5,
  delayMs: 500,
  concurrency: 3,
  render: 'auto',
  respectRobots: true,
  sameOrigin: true,
  scripts: 'strip',
  assets: true,
  /* Только ASCII. Значение HTTP-заголовка — ByteString: любая кириллица роняет fetch на первом
     же запросе, и падает при этом весь обход, а не одна страница. */
  userAgent: 'LayoutTestingBot/0.3 (+layout-testing-mcp)',
};

/**
 * Признак того, что без скриптов на странице ничего нет.
 *
 * Порог грубый намеренно: точную границу «пустой страницы» провести нельзя, а ошибка в одну
 * сторону стоит одного лишнего запуска браузера, в другую — пустой страницы в архиве.
 */
export function looksEmpty(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 200) return true;
  if (!/<h1[\s>]/i.test(html) && text.length < 600) return true;
  // Каркас SPA: пустой корневой контейнер и всё остальное дорисовывается скриптом.
  return /<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRobots(origin, userAgent) {
  try {
    const res = await fetch(new URL('/robots.txt', origin).href, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { parsed: parseRobots(''), status: res.status };
    return { parsed: parseRobots(await res.text()), status: res.status };
  } catch (err) {
    // Нет robots.txt — значит не запрещено ничего. Это не ошибка обхода.
    return { parsed: parseRobots(''), status: null, error: err.message };
  }
}

/** Ссылки со страницы: те же правила, по которым потом считается граф. */
function linksFrom(seo, base, config) {
  const out = [];
  for (const href of seo.internalLinks || []) {
    const abs = tryNormalize(href, base);
    if (!abs || !/^https?:/i.test(abs)) continue;
    const belongs = config.sameOrigin ? sameHost(abs, config.url) : sameSite(abs, config.url);
    if (!belongs) continue;
    if (config.include && !new RegExp(config.include).test(abs)) continue;
    if (config.exclude && new RegExp(config.exclude).test(abs)) continue;
    out.push(abs);
  }
  return out;
}

async function crawlOne(job, task) {
  const { config } = job;
  const headers = { 'User-Agent': config.userAgent, ...(config.extraHTTPHeaders || {}) };

  let html = null;
  let status = null;
  let responseHeaders = null;
  let rendered = false;
  let finalUrl = task.url;
  let redirected = false;

  if (config.render !== 'always') {
    try {
      const res = await fetch(task.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      status = res.status;
      responseHeaders = Object.fromEntries(res.headers.entries());
      /*
       * Читаем байтами и декодируем сами: windows-1251 на старых сайтах жив, а res.text()
       * молча считает всё utf-8 и отдаёт кракозябры, по которым потом «не находится» ни title,
       * ни h1 — и страница уезжает в браузер как якобы пустая.
       */
      finalUrl = res.url || task.url;
      redirected = res.redirected;
      const buffer = Buffer.from(await res.arrayBuffer());
      html = decodeBody(buffer, responseHeaders['content-type']);
    } catch (err) {
      job.lastError = err.message;
    }
  }

  const needsBrowser =
    config.render === 'always' || (config.render === 'auto' && (html === null || looksEmpty(html)));

  if (!needsBrowser) {
    /* При render: never браузера не будет, и упавший запрос разбирать нечем. Пустой разбор
       записал бы страницу в архив как успешную и без единого поля — молчаливая потеря. */
    if (html === null) throw new Error(job.lastError || 'запрос не удался, а режим запрещает браузер');

    const seo = await seoFromHtml(html, { url: task.url, status, headers: responseHeaders });
    /* Даже без браузера страницу надо положить на диск: иначе дешёвый режим обхода
       наполняет индекс записями, за которыми нет ничего, и работать по архиву нечем. */
    const dir = pageDirOf(job.siteId, pageIdFor(task.url));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'raw.html'), html, 'utf8');
    return { seo, status, rendered: false, saved: { dir, mirrored: false }, html, finalUrl, redirected };
  }

  const session = await job.session();
  const nav = await gotoAndSettle(session, task.url, { waitUntil: 'load', timeout: 30000 });
  const seo = await seoFromPage(session.page, session.lastResponse);
  rendered = true;

  const saved = await savePage(session, {
    siteId: job.siteId,
    assets: config.assets,
    scripts: config.scripts,
    knownPages: job.knownPages,
  });

  const renderedHtml = await session.page.content();
  return {
    seo,
    status: nav.status ?? status,
    rendered,
    saved,
    renderGapFrom: html,
    html: renderedHtml,
    finalUrl: session.page.url(),
    redirected: (session.lastResponse?.redirects || []).length > 0,
  };
}

/** Кодировка: заголовок, потом meta charset из начала тела, потом utf-8. */
export function decodeBody(buffer, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(String(contentType || ''));
  const head = buffer.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  const charset = (fromHeader?.[1] || fromMeta?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    // Неизвестная кодировка — лучше кракозябры, чем упавший обход.
    return buffer.toString('utf8');
  }
}


/**
 * Отпечаток видимого текста.
 *
 * По нему находятся дубли, которые не видны по заголовкам: карточки товара, различающиеся
 * одним артикулом, и страницы фильтров с одинаковым содержимым под разными адресами.
 * Разметка в расчёт не берётся — она отличается почти всегда и утопила бы находку.
 */
export function contentHash(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return text ? createHash('sha1').update(text).digest('hex').slice(0, 16) : null;
}

async function runJob(job) {
  const { config } = job;
  const frontier = job.frontier;
  const state = frontierState(frontier);
  const index = job.index;

  let processed = 0;

  while (state.size() && job.stats.saved < config.maxPages) {
    const fresh = await readSite(job.siteId);
    if (fresh?.status === 'stopping') {
      job.status = 'paused';
      break;
    }

    const task = state.take();
    if (!task) break;

    try {
      const result = await crawlOne(job, task);
      const pageId = pageIdFor(task.url);

      index.pages[normalizeUrl(task.url)] = {
        pageId,
        depth: task.depth,
        status: result.status,
        title: result.seo.title.text,
        description: result.seo.description.text,
        h1: result.seo.content.firstH1,
        words: result.seo.content.words,
        indexable: result.seo.indexable,
        reasons: result.seo.reasons,
        canonical: result.seo.canonical.href,
        rendered: result.rendered,
        renderGap: result.rendered && result.renderGapFrom ? looksEmpty(result.renderGapFrom) : false,
        savedAt: new Date().toISOString(),
        from: task.from,
        finalUrl: result.finalUrl ?? task.url,
        redirected: Boolean(result.redirected),
        contentHash: contentHash(result.html),
        /* Исходящие внутренние ссылки — то, из чего потом строится граф: входящие связи,
           страницы-сироты и битые ссылки с указанием, откуда на них ведут. */
        links: linksFrom(result.seo, task.url, config),
        alternates: result.seo.alternates,
        canonicalSelf: result.seo.canonical.self,
        images: { total: result.seo.images.total, noAlt: result.seo.images.noAlt },
      };
      job.knownPages.set(normalizeUrl(task.url), pageId);
      frontier.done.push(task.url);
      job.stats.saved += 1;

      if (task.depth < config.maxDepth) {
        for (const href of linksFrom(result.seo, task.url, config)) {
          const next = { url: href, depth: task.depth + 1, from: task.url };
          if (config.respectRobots && !isAllowed(job.robots, config.userAgent, href)) {
            state.skip(next, 'запрещено в robots.txt');
            continue;
          }
          state.add(next);
        }
      }
    } catch (err) {
      frontier.failed.push({ url: task.url, error: err.message });
      job.stats.failed += 1;
    }

    processed += 1;
    if (processed % CONTEXT_EVERY === 0) await job.recycle();
    if (processed % FLUSH_EVERY === 0) await job.flush();
    if (config.delayMs) await sleep(config.delayMs);
  }

  /* Что осталось в очереди — не «битое» и не «в порядке»: до него просто не дошли. Отчёт обязан
     различать это, иначе непроверенные адреса приедут либо ложными 404, либо ложным «всё чисто». */
  job.stats.notChecked = state.size();
  if (job.status !== 'paused') job.status = 'done';
  await job.finish();
}

export async function startCrawl(input = {}) {
  const url = normalizeUrl(input.url);
  const siteId = input.siteId || siteIdFor(url);
  if (jobs.has(siteId)) throw new Error(`Обход ${siteId} уже идёт. Смотрите crawl status или остановите его.`);

  const config = { ...DEFAULTS, ...input, url, siteId };
  const robots = config.respectRobots ? (await fetchRobots(url, config.userAgent)).parsed : parseRobots('');
  config.delayMs = config.respectRobots ? crawlDelayMs(robots, config.userAgent, config.delayMs) : config.delayMs;

  /* При возобновлении очередь берётся с диска целиком, вместе с seen: иначе обход пойдёт
     по второму кругу за уже скачанными страницами и упрётся в maxPages на дублях. */
  const frontier = input.resumeFrontier ? createFrontier(input.resumeFrontier) : createFrontier();
  if (!input.resumeFrontier) frontierState(frontier).add({ url, depth: 0, from: null });
  const index = await readIndex(siteId);

  let session = null;
  let used = 0;

  const job = {
    siteId,
    config,
    robots,
    frontier,
    index,
    knownPages: new Map(Object.entries(index.pages).map(([u, p]) => [u, p.pageId])),
    status: 'running',
    stats: { saved: frontier.done.length, failed: frontier.failed.length, notChecked: 0 },
    startedAt: new Date().toISOString(),
    lastError: null,

    async session() {
      if (!session) {
        session = await createSession({
          browser: 'chromium',
          userAgent: config.userAgent,
          serviceWorkers: 'block',
          storageState: config.storageState,
          extraHTTPHeaders: config.extraHTTPHeaders,
          auth: config.auth,
        });
        used = 0;
      }
      used += 1;
      return session;
    },
    async recycle() {
      if (!session || used < CONTEXT_EVERY) return;
      await closeSession(session.id).catch(() => {});
      session = null;
    },
    async flush() {
      await writeFrontier(siteId, frontier);
      await writeIndex(siteId, index);
      await writeSite(siteId, snapshot(job));
    },
    async finish() {
      if (session) await closeSession(session.id).catch(() => {});
      session = null;
      await job.flush();
      jobs.delete(siteId);
    },
  };

  jobs.set(siteId, job);
  await job.flush();

  // Задача уходит в фон: обход идёт минутами, а инструмент обязан ответить сразу.
  job.promise = runJob(job).catch(async (err) => {
    job.status = 'failed';
    job.lastError = err.message;
    await job.finish().catch(() => {});
  });

  return snapshot(job);
}

function snapshot(job) {
  return {
    siteId: job.siteId,
    url: job.config.url,
    status: job.status,
    startedAt: job.startedAt,
    stats: { ...job.stats, pending: job.frontier.pending.length, skipped: Object.keys(job.frontier.skipped).length },
    config: {
      maxPages: job.config.maxPages,
      maxDepth: job.config.maxDepth,
      delayMs: job.config.delayMs,
      render: job.config.render,
      sameOrigin: job.config.sameOrigin,
      respectRobots: job.config.respectRobots,
      userAgent: job.config.userAgent,
    },
    /* Отключённый robots фиксируется в манифесте намеренно: по отчёту должно быть видно,
       что обход был невежливым, даже если смотрят его через полгода. */
    ...(job.config.respectRobots ? {} : { warning: 'robots.txt проигнорирован по явному указанию' }),
    lastError: job.lastError,
  };
}

export async function crawlStatus(siteId) {
  const live = jobs.get(siteId);
  if (live) {
    /*
     * Задача покидает реестр последним действием finish(), уже дописав манифест, очередь и
     * индекс. Пока она здесь, отдавать терминальный статус рано: увидев done, вызывающий
     * тут же идёт удалять каталог и попадает в ENOTEMPTY поверх незаконченной записи.
     */
    const status = live.status === 'running' ? 'running' : 'finishing';
    return { ...snapshot(live), status, live: true };
  }

  const site = await readSite(siteId);
  if (!site) throw new Error(`Обход ${siteId} не найден.`);

  /* В файле осталось running, а в памяти задачи нет — значит процесс перезапустился.
     Показывать это как идущий обход нельзя: прогресса нет и не будет. */
  if (site.status === 'running') {
    const stale = { ...site, status: 'stale', note: 'Процесс перезапущен, обход не идёт. Продолжить: crawl resume.' };
    await writeSite(siteId, stale);
    return { ...stale, live: false };
  }
  return { ...site, live: false };
}

export async function stopCrawl(siteId) {
  const site = await readSite(siteId);
  if (!site) throw new Error(`Обход ${siteId} не найден.`);
  await writeSite(siteId, { ...site, status: 'stopping' });
  return { siteId, status: 'stopping', note: 'Обход остановится после текущей страницы.' };
}

export async function resumeCrawl(siteId) {
  if (jobs.has(siteId)) throw new Error(`Обход ${siteId} уже идёт.`);
  const site = await readSite(siteId);
  const frontier = await readFrontier(siteId);
  if (!site || !frontier) throw new Error(`Обход ${siteId} не найден.`);
  if (!frontier.pending.length) return { siteId, status: 'done', note: 'Очередь пуста, продолжать нечего.' };

  return startCrawl({ ...site.config, url: site.url, siteId, resumeFrontier: frontier });
}

export const liveJobs = () => [...jobs.keys()];
