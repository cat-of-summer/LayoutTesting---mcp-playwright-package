import { chromium, firefox, webkit } from 'playwright';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { contextOptions, hostResolverRules, normalizeProfile, profileKey } from './profile.js';
import { applyProfileToPage, applyThrottle, stabilize } from './stabilize.js';
import { reapplyInjections } from './inject.js';

const ENGINES = { chromium, firefox, webkit };

/** Запущенные браузеры переиспользуются: старт webkit стоит секунды. */
const browsers = new Map();
/** Живые сессии MCP: контекст + страница + собранные логи. */
const sessions = new Map();

export async function getBrowser(name = 'chromium', hostMap = null) {
  const engine = ENGINES[name];
  if (!engine) throw new Error(`Неизвестный браузер: ${name}. Доступны: ${Object.keys(ENGINES).join(', ')}`);

  const resolverRules = hostResolverRules(hostMap);
  if (resolverRules && name !== 'chromium') {
    throw new Error('hostMap работает только в chromium: это аргумент запуска браузера, у firefox и webkit его нет.');
  }

  // Подмена разрешения имён задаётся при запуске, а не в контексте, — значит на каждый
  // набор правил нужен свой процесс браузера. Ключ кэша это учитывает.
  const key = resolverRules ? `${name}|${resolverRules}` : name;
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

export async function createSession(profileInput = {}) {
  const profile = normalizeProfile(profileInput);
  const browser = await getBrowser(profile.browser, profile.hostMap);
  const context = await newContext(browser, profile);
  context.setDefaultTimeout(CONFIG.defaultTimeout);
  const page = await context.newPage();
  await applyProfileToPage(page, profile);
  await applyThrottle(page, profile).catch(() => {});

  const id = randomUUID().slice(0, 8);
  const session = {
    id,
    profile,
    key: profileKey(profile),
    context,
    page,
    logs: { console: [], errors: [], network: [] },
    /** Патчи CSS/JS, переживающие навигацию, — см. browser/inject.js. */
    injections: [],
    /** Правила перехвата запросов — см. browser/routes.js. */
    routes: [],
    unsupported: context.__ltUnsupported || [],
    createdAt: new Date().toISOString(),
  };
  attachCollectors(page, session.logs);
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Сессия ${id} не найдена. Откройте новую через browser_open.`);
  }
  return session;
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    key: s.key,
    url: s.page.url(),
    createdAt: s.createdAt,
    unsupported: s.unsupported,
    injections: (s.injections || []).length,
    routes: (s.routes || []).length,
  }));
}

export async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
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

  const status = response?.status() ?? null;
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
  const session = await createSession(profileInput);
  try {
    return await fn(session);
  } finally {
    await closeSession(session.id);
  }
}

export async function closeAll() {
  for (const id of [...sessions.keys()]) await closeSession(id);
  for (const [name, browser] of browsers) {
    await browser.close().catch(() => {});
    browsers.delete(name);
  }
}
