import { chromium, firefox, webkit } from 'playwright';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { contextOptions, hostResolverRules, normalizeProfile, profileKey } from './profile.js';
import { applyProfileToPage, applyThrottle, stabilize } from './stabilize.js';
import { reapplyInjections } from './inject.js';
import { responseFacts } from './response.js';

const ENGINES = { chromium, firefox, webkit };

/** Запущенные браузеры переиспользуются: старт webkit стоит секунды. */
const browsers = new Map();
/** Живые сессии MCP: контекст + страница + собранные логи. */
const sessions = new Map();

/**
 * Недавно закрытые сессии: id -> почему и что там было.
 *
 * Без этого журнала любое закрытие не по воле агента неотличимо от «такого id и не было»:
 * getSession отвечал «сессия не найдена, откройте новую», агент повторял тот же id и делал
 * вывод, что сломан инструмент. Здесь лежит причина и достаточно данных, чтобы открыть
 * равноценную сессию одним вызовом, а не тремя догадками.
 */
const evicted = new Map();
const EVICTED_KEEP = 50;

const REASONS = {
  idle: 'простой дольше LT_SESSION_IDLE_MS',
  maxAge: 'достигнут предельный возраст LT_SESSION_MAX_AGE_MS',
  lru: 'вытеснена под новую сессию, достигнут потолок LT_MAX_SESSIONS',
  crashed: 'страница упала',
  disconnected: 'браузер отключился',
  closed: 'закрыта через browser_close',
};

/**
 * Ключ кэша браузеров.
 *
 * Подмена разрешения имён задаётся при запуске, а не в контексте, — значит на каждый набор
 * правил нужен свой процесс браузера. Вынесено отдельно, потому что тот же ключ хранит у себя
 * сессия: по нему её находят, когда браузер умирает.
 */
export function browserCacheKey(name = 'chromium', hostMap = null) {
  const resolverRules = hostResolverRules(hostMap);
  return resolverRules ? `${name}|${resolverRules}` : name;
}

export async function getBrowser(name = 'chromium', hostMap = null) {
  const engine = ENGINES[name];
  if (!engine) throw new Error(`Неизвестный браузер: ${name}. Доступны: ${Object.keys(ENGINES).join(', ')}`);

  const resolverRules = hostResolverRules(hostMap);
  if (resolverRules && name !== 'chromium') {
    throw new Error('hostMap работает только в chromium: это аргумент запуска браузера, у firefox и webkit его нет.');
  }

  const key = browserCacheKey(name, hostMap);
  const existing = browsers.get(key);
  if (existing && existing.isConnected()) return existing;

  const args = name === 'chromium'
    ? [
        // Контейнер работает от root, а под root Chromium без этого не стартует.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Сглаживание шрифтов иначе пляшет между прогонами и ломает pixel-diff.
        '--font-render-hinting=none',
        '--disable-lcd-text',
        ...(resolverRules ? [resolverRules] : []),
      ]
    : [];
  const browser = await engine.launch({ args });
  browsers.set(key, browser);
  /*
   * Браузер умирает и сам: падает, попадает под OOM, закрывается снаружи. Кэш это переживал —
   * следующий вызов видел isConnected() === false и поднимал новый процесс. А вот сессии,
   * смотревшие в мёртвый процесс, оставались в карте навсегда и отвечали непрозрачной ошибкой
   * playwright. Убираем их здесь же, с причиной, по которой агенту будет понятно, что случилось.
   */
  browser.on('disconnected', () => {
    if (browsers.get(key) === browser) browsers.delete(key);
    for (const session of [...sessions.values()]) {
      if (session.browserKey === key) forget(session, 'disconnected');
    }
  });
  return browser;
}

async function newContext(browser, profile) {
  const opts = contextOptions(profile);
  try {
    return await browser.newContext(opts);
  } catch (err) {
    // forcedColors поддерживают не все движки — повторяем без него, чтобы прогон матрицы не падал целиком.
    if (opts.forcedColors && opts.forcedColors !== 'none') {
      const { forcedColors, ...rest } = opts;
      const ctx = await browser.newContext(rest);
      ctx.__ltUnsupported = ['forcedColors'];
      return ctx;
    }
    throw err;
  }
}

/**
 * Кольцевой буфер: сессия живёт до закрытия, а болтливая страница пишет в консоль и
 * дёргает сеть непрерывно. Без предела массивы растут всё время жизни сессии, и на
 * долгой отладке это единственное место, которое течёт по-настоящему.
 *
 * Режем старое, а не новое: разбираются обычно с последним, что произошло.
 */
function pushCapped(list, entry) {
  list.push(entry);
  if (list.length > CONFIG.logBufferSize) list.splice(0, list.length - CONFIG.logBufferSize);
}

function attachCollectors(page, store) {
  page.on('console', (msg) => {
    pushCapped(store.console, {
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      at: new Date().toISOString(),
    });
  });
  page.on('pageerror', (err) => {
    pushCapped(store.errors, { message: err.message, stack: err.stack, at: new Date().toISOString() });
  });
  page.on('requestfailed', (req) => {
    pushCapped(store.network, {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText || 'failed',
      status: null,
    });
  });
  page.on('response', (res) => {
    pushCapped(store.network, {
      url: res.url(),
      method: res.request().method(),
      resourceType: res.request().resourceType(),
      status: res.status(),
      failure: null,
    });
  });
}

/**
 * Аргументы, которыми открывают равноценную сессию взамен закрытой.
 *
 * Считаются из того, что агент передал в browser_open, а не из нормализованного профиля:
 * так они точны без обратных пересчётов. Zoom, например, уже сжал viewport, и восстановить
 * исходный размер из результата можно лишь приблизительно.
 *
 * Доступ сюда не попадает. Сообщение о закрытой сессии уходит в переписку с агентом, а пароль
 * в переписке — это пароль в логах; вместо значения ставится признак, что его надо передать
 * заново.
 */
const SECRET_FIELDS = new Set(['auth', 'httpCredentials', 'extraHTTPHeaders']);

function reopenArgs(input = {}) {
  const args = {};
  let needsAuth = false;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (SECRET_FIELDS.has(key)) {
      needsAuth = true;
      continue;
    }
    args[key] = value;
  }
  return { args, needsAuth };
}

function safeUrl(session) {
  try {
    return sanitizeUrl(session.page.url());
  } catch {
    return null;
  }
}

/** Убрать сессию из живых и записать в журнал, почему. Контекст не закрывает. */
function forget(session, reason) {
  if (!sessions.has(session.id)) return;
  sessions.delete(session.id);
  evicted.set(session.id, {
    reason,
    at: new Date().toISOString(),
    url: safeUrl(session),
    key: session.key,
    reopen: session.reopen,
    needsAuth: session.needsAuth,
  });
  while (evicted.size > EVICTED_KEEP) evicted.delete(evicted.keys().next().value);
}

function sessionGone(id) {
  const past = evicted.get(id);
  if (!past) {
    return new Error(`Сессия ${id} не найдена — такой и не было. Откройте новую через browser_open.`);
  }
  const parts = [
    `Сессия ${id} закрыта: ${REASONS[past.reason] || past.reason} (${past.at}).`,
    past.url ? `Была на ${past.url}, профиль ${past.key}.` : `Профиль ${past.key}.`,
    `Откройте новую через browser_open с теми же условиями: ${JSON.stringify(past.reopen || {})}`,
  ];
  if (past.needsAuth) {
    parts.push('Доступ (auth и заголовки) передайте заново — в журнале он не хранится.');
  }
  return new Error(parts.join(' '));
}

/**
 * Освободить место под новую сессию.
 *
 * Вытесняется та, к которой дольше всех не обращались. Сессии внутренних прогонов — обход,
 * матрица — не трогаем: убить браузер идущего обхода ради разовой проверки заведомо хуже,
 * чем честно сказать, что стенд занят.
 */
async function makeRoom() {
  if (!CONFIG.maxSessions || sessions.size < CONFIG.maxSessions) return;
  const candidates = [...sessions.values()].filter((s) => !s.owned);
  if (!candidates.length) {
    throw new Error(
      `Стенд занят: ${sessions.size} сессий, и все заняты внутренними прогонами. ` +
        'Дождитесь их окончания или поднимите LT_MAX_SESSIONS.',
    );
  }
  candidates.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
  await closeSession(candidates[0].id, 'lru');
}

/**
 * Браузер, на который не смотрит ни одна сессия.
 *
 * Закрываем только заведённые под hostMap: на каждый набор правил разрешения имён нужен свой
 * процесс, и такие копятся по одному на стенд за vhost. Базовые движки оставляем жить — их
 * почти наверняка попросят снова, а старт webkit стоит секунд.
 */
async function reapBrowsers() {
  const inUse = new Set([...sessions.values()].map((s) => s.browserKey));
  for (const [key, browser] of [...browsers]) {
    if (inUse.has(key) || !key.includes('|')) continue;
    browsers.delete(key);
    await browser.close().catch(() => {});
  }
}

async function sweep() {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (session.owned) continue;
    if (CONFIG.sessionIdleMs && now - session.lastUsedMs >= CONFIG.sessionIdleMs) {
      await closeSession(session.id, 'idle');
      continue;
    }
    if (CONFIG.sessionMaxAgeMs && now - session.createdMs >= CONFIG.sessionMaxAgeMs) {
      await closeSession(session.id, 'maxAge');
    }
  }
  await reapBrowsers();
}

let sweeper = null;
function startSweeper() {
  if (sweeper || !CONFIG.sessionSweepMs) return;
  sweeper = setInterval(() => {
    sweep().catch(() => {});
  }, CONFIG.sessionSweepMs);
  /* Таймер не должен удерживать процесс: в stdio-режиме выход происходит по сигналу, а
     разовый вызов lt обязан завершиться сам. Без unref он не давал бы этого ни тому, ни другому. */
  sweeper.unref?.();
}

export async function createSession(profileInput = {}, { owned = null } = {}) {
  await makeRoom();
  const profile = normalizeProfile(profileInput);
  const browserKey = browserCacheKey(profile.browser, profile.hostMap);
  const browser = await getBrowser(profile.browser, profile.hostMap);
  const context = await newContext(browser, profile);
  context.setDefaultTimeout(CONFIG.defaultTimeout);
  const page = await context.newPage();
  await applyProfileToPage(page, profile);
  await applyThrottle(page, profile).catch(() => {});

  /* Восьми знаков хватает с запасом, но журнал закрытых делает id значимым и после смерти
     сессии: повтор выдал бы чужую подсказку по восстановлению. */
  let id;
  do {
    id = randomUUID().slice(0, 8);
  } while (sessions.has(id) || evicted.has(id));

  const now = Date.now();
  const { args: reopen, needsAuth } = reopenArgs(profileInput);
  const session = {
    id,
    profile,
    key: profileKey(profile),
    context,
    page,
    browserKey,
    /** internal — сессия одноразового прогона: её не вытесняют, у неё свой finally. */
    owned,
    logs: { console: [], errors: [], network: [] },
    /** Патчи CSS/JS, переживающие навигацию, — см. browser/inject.js. */
    injections: [],
    /** Правила перехвата запросов — см. browser/routes.js. */
    routes: [],
    unsupported: context.__ltUnsupported || [],
    createdAt: new Date(now).toISOString(),
    createdMs: now,
    lastUsedMs: now,
    reopen,
    needsAuth,
  };
  /* Страница падает и отдельно от браузера: тогда сессия числится живой, но мертва по сути. */
  page.on('crash', () => forget(session, 'crashed'));
  attachCollectors(page, session.logs);
  sessions.set(id, session);
  startSweeper();
  return session;
}

export function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw sessionGone(id);
  /* Единственное место, где отмечается обращение: через getSession проходят все инструменты,
     берущие sessionId, и рассыпать отметки по ним значило бы рано или поздно забыть про одну. */
  session.lastUsedMs = Date.now();
  return session;
}

/** Последние закрытые сессии: чтобы browser_sessions отвечал на «куда делась моя». */
export function listEvicted(limit = 5) {
  return [...evicted.entries()].slice(-limit).map(([id, e]) => ({
    id,
    reason: e.reason,
    why: REASONS[e.reason] || e.reason,
    at: e.at,
    url: e.url,
    key: e.key,
    reopen: e.reopen,
  }));
}


/**
 * Список живых сессий.
 *
 * Всё, что читается со страницы, — под защитой. У закрытой или упавшей страницы page.url()
 * бросает, а этим списком пользуются browser_sessions и stand_info, то есть ровно те два
 * инструмента, которыми агент выясняет, что со стендом. Одна мёртвая сессия не должна
 * лишать его обоих: она попадает в список с alive: false, а не роняет весь ответ.
 *
 * Адрес — через sanitizeUrl: иначе basic-auth из URL уезжает в вывод stand_info.
 */
export function listSessions() {
  return [...sessions.values()].map((s) => {
    let url = null;
    let alive = false;
    try {
      alive = !s.page.isClosed();
      url = sanitizeUrl(s.page.url());
    } catch {
      /* Страница мертва. Сессию всё равно показываем — по ней видно, что чистить. */
    }
    return {
      id: s.id,
      key: s.key,
      url,
      alive,
      createdAt: s.createdAt,
      /* Сколько сессия простаивает — по этому числу видно, какая закроется следующей. */
      idleMs: Date.now() - s.lastUsedMs,
      owned: s.owned,
      unsupported: s.unsupported,
      injections: (s.injections || []).length,
      routes: (s.routes || []).length,
    };
  });
}

export async function closeSession(id, reason = 'closed') {
  const session = sessions.get(id);
  if (!session) return false;
  forget(session, reason);
  await session.context.close().catch(() => {});
  return true;
}

/** Логин из адреса убираем: иначе он расползается по отчётам и именам артефактов. */
export function sanitizeUrl(value) {
  try {
    const u = new URL(value);
    if (!u.username && !u.password) return value;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return value;
  }
}

/**
 * Сводка неудачных запросов страницы.
 *
 * Битые картинки не роняют навигацию: страница честно отвечает 200, снимок снимается,
 * и то, что половина медиа не доехала, выясняется в лучшем случае глазами на готовом
 * кадре. Поэтому считаем и кладём прямо в ответ навигации и снимка.
 */
export function summarizeFailures(entries, { limit = 5 } = {}) {
  const failed = entries.filter((n) => n.failure || (n.status && n.status >= 400));
  if (!failed.length) return null;

  const byType = {};
  for (const item of failed) {
    byType[item.resourceType || 'other'] = (byType[item.resourceType || 'other'] || 0) + 1;
  }
  return {
    failedRequests: failed.length,
    byResourceType: byType,
    firstFailures: failed.slice(0, limit).map((n) => ({
      url: sanitizeUrl(n.url).slice(0, 200),
      resourceType: n.resourceType,
      status: n.status,
      failure: n.failure,
    })),
  };
}

export async function gotoAndSettle(
  session,
  url,
  { waitUntil = 'load', stabilizePage = true, timeout = CONFIG.defaultTimeout } = {},
) {
  let response = null;
  let timedOut = false;
  /*
   * Отметка в журнале: всё, что после неё, относится к этому переходу, а не к прошлому.
   * Храним её на сессии, а не только локально: без этого page_logs отдаёт всё подряд с
   * момента открытия сессии, и ошибка с позапрошлой страницы приезжает в разбор текущей.
   */
  const logMark = session.logs.network.length;
  session.logMarks = {
    console: session.logs.console.length,
    errors: session.logs.errors.length,
    network: logMark,
  };

  try {
    response = await session.page.goto(url, { waitUntil, timeout });
  } catch (err) {
    // Боевые сайты сплошь и рядом не доходят до load: висит аналитика, чат,
    // long-poll. Страница при этом отрисована, и проверять её можно и нужно.
    if (!/Timeout .* exceeded/i.test(err.message)) throw err;
    timedOut = true;
    await session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  }

  let images = null;
  let stubbed = null;
  if (stabilizePage) {
    ({ images, stubbed } = await stabilize(session.page, { pseudoLoc: session.profile.pseudoLoc }));
  }

  // Патчи агента возвращаем последними: они должны перебивать и стили страницы,
  // и служебный CSS стабилизации.
  await reapplyInjections(session);

  /* Заголовки и редиректы нужны SEO-проверкам и живут только здесь: дальше Response недоступен. */
  session.lastResponse = await responseFacts(response);

  const status = session.lastResponse.status;
  const result = {
    status,
    url: sanitizeUrl(session.page.url()),
    title: await session.page.title().catch(() => ''),
  };
  if (timedOut) {
    result.navigationTimedOut = true;
    result.note = `Событие "${waitUntil}" не наступило за ${timeout} мс — проверки идут по тому, что отрисовано.`;
  }

  const warnings = summarizeFailures(session.logs.network.slice(logMark));
  const stubCount = (stubbed?.images || 0) + (stubbed?.videos || 0);
  if (warnings || images?.broken || images?.stillPending || stubCount) {
    result.warnings = {
      ...(warnings || {}),
      ...(images?.broken ? { brokenImages: images.broken } : {}),
      ...(images?.stillPending ? { imagesStillLoading: images.stillPending } : {}),
      /*
       * Подмена меняет то, что видно в кадре, поэтому о ней сообщаем всегда. Иначе снимок
       * с аккуратными серыми прямоугольниками не отличить от снимка, где всё загрузилось.
       */
      ...(stubCount ? { placeholders: { ...stubbed, total: stubCount } } : {}),
      note: 'Часть ресурсов страницы не загрузилась — снимок будет неполным. Подробности: page_logs.',
    };
  }
  if (status === 401) {
    result.hint = 'Страница за HTTP-аутентификацией. Передайте auth: "пользователь:пароль" при открытии сессии — в URL логин зашивать не надо.';
  }
  return result;
}

/**
 * Одноразовая сессия для проверок без диалога с агентом.
 * Закрывается всегда, даже если проверка бросила.
 */
export async function withSession(profileInput, fn) {
  /* owned: внутренние прогоны идут долго и между шагами могут не трогать сессию минутами.
     По простою их закрывать нельзя — за ними следит собственный finally, а не сборщик. */
  const session = await createSession(profileInput, { owned: 'internal' });
  try {
    return await fn(session);
  } finally {
    await closeSession(session.id);
  }
}

export async function closeAll() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  for (const id of [...sessions.keys()]) await closeSession(id);
  for (const [name, browser] of browsers) {
    await browser.close().catch(() => {});
    browsers.delete(name);
  }
}
