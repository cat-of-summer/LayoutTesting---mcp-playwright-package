import { chromium, firefox, webkit } from 'playwright';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { contextOptions, hostResolverRules, normalizeProfile, profileKey } from './profile.js';
import { applyProfileToPage, applyThrottle, stabilize } from './stabilize.js';
import { reapplyInjections } from './inject.js';
import { blockedHostHint, navigationErrorHint, responseFacts, sameDocument } from './response.js';

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

function attachCollectors(page, session) {
  const store = session.logs;

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

  /*
   * Диалоги. Без обработчика playwright закрывает их сам и молча — библиотека, показывающая
   * ошибку через alert(), выглядит с той стороны как библиотека, которая ничего не сказала.
   * Здесь текст попадает в журнал, а закрывается диалог ровно так же, как и раньше.
   *
   * Политика читается в момент события, а не запоминается при подписке: её меняют посреди
   * сценария, когда выясняется, что confirm пора не отклонять, а принимать.
   */
  page.on('dialog', async (dialog) => {
    const policy = session.dialogPolicy || {};
    const accept = policy.action === 'accept';
    pushCapped(store.dialogs, {
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue() || null,
      action: accept ? 'accept' : 'dismiss',
      at: new Date().toISOString(),
    });
    try {
      if (accept) await dialog.accept(policy.promptText ?? undefined);
      else await dialog.dismiss();
    } catch {
      /* Диалог мог закрыться вместе со страницей — это не повод ронять сессию. */
    }
  });

  /*
   * Счётчик навигаций главного фрейма.
   *
   * Страница перезагружается и без ведома агента: live reload дев-сервера, редирект, meta
   * refresh. Открытая модалка при этом закрывается, и «карточка закрыта» становится
   * неотличимо от «клик не сработал». Считаем переходы, чтобы ответ действия мог сказать,
   * что между вызовами страница сменилась.
   */
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    session.navSeq += 1;
    let url = null;
    try {
      url = sanitizeUrl(frame.url());
    } catch {
      /* Фрейм уже мёртв — счётчик всё равно верен. */
    }
    session.lastNavigation = { url, at: new Date().toISOString() };
  });

  /*
   * Патчи CSS и JS обещают пережить навигацию — см. browser/inject.js. До сих пор они
   * переживали только browser_goto: после самопроизвольной перезагрузки страница оставалась
   * без них, и разбор шёл по неправленому состоянию.
   *
   * Стабилизацию здесь не гоняем: она прокручивает документ целиком и стоит секунды, а
   * срабатывал бы этот обработчик на каждый чих дев-сервера.
   */
  page.on('load', () => {
    /* Свой переход патчи вернёт gotoAndSettle — и вернёт последними, уже после стабилизации.
       Здесь отрабатываются только чужие переходы, иначе JS-патч выполнялся бы дважды. */
    if (session.navByTool) return;
    reapplyInjections(session).catch(() => {});
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
    logs: { console: [], errors: [], network: [], dialogs: [] },
    /** Что делать с alert/confirm/prompt. Меняется через browser_act с action: dialog. */
    dialogPolicy: { action: 'dismiss', promptText: null },
    /** Сколько раз главный фрейм переходил и сколько из них агент уже видел. */
    navSeq: 0,
    navSeen: 0,
    lastNavigation: null,
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
  attachCollectors(page, session);
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

/**
 * Была ли навигация с прошлого обращения — и сразу отметить, что агент об этом узнал.
 *
 * Возвращает null, когда переходов не было: пустое поле в ответе дешевле, чем
 * navigated: false в каждом вызове.
 */
export function takeNavigationSince(session) {
  const count = (session.navSeq || 0) - (session.navSeen || 0);
  session.navSeen = session.navSeq || 0;
  if (count <= 0) return null;
  return { count, ...(session.lastNavigation || {}) };
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
  { waitUntil = 'load', stabilizePage = true, timeout = CONFIG.defaultTimeout, animations = null } = {},
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
    dialogs: session.logs.dialogs.length,
  };

  session.navByTool = true;
  /*
   * Повторный переход на открытый адрес — это «перепроверь после правки». Из HTTP-кэша браузер
   * отдаёт при этом старые стили, computed_styles не находит только что добавленный класс, и
   * ошибку ищут в CSS, где её нет. Поэтому такой переход идёт мимо кэша. Только chromium: у
   * остальных движков выключателя кэша нет, и об этом говорится в ответе.
   */
  const repeat = sameDocument(session.page.url(), url);
  let cdp = null;
  if (repeat && session.profile.browser === 'chromium') {
    try {
      cdp = await session.page.context().newCDPSession(session.page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch {
      cdp = null;
    }
  }
  try {
    response = await session.page.goto(url, { waitUntil, timeout });
  } catch (err) {
    // Боевые сайты сплошь и рядом не доходят до load: висит аналитика, чат,
    // long-poll. Страница при этом отрисована, и проверять её можно и нужно.
    if (!/Timeout .* exceeded/i.test(err.message)) {
      // Иначе признак «идёт свой переход» остался бы поднятым на всю жизнь сессии.
      session.navByTool = false;
      const hint = navigationErrorHint(err.message, url);
      if (hint) throw new Error(`${err.message}\n\n${hint}`);
      throw err;
    }
    timedOut = true;
    await session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  } finally {
    if (cdp) {
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }

  let images = null;
  let stubbed = null;
  /* Разовое значение перебивает условие сессии: иногда живая анимация нужна на одном
     переходе, а переоткрывать сессию ради этого незачем. */
  const killMotion = (animations || session.profile.animations) !== 'allow';
  /* Запоминаем, как открыта текущая страница: layout_audit по этому признаку предупреждает, что
     движение на ней не проверялось. */
  session.motionFrozen = stabilizePage && killMotion;
  if (stabilizePage) {
    ({ images, stubbed } = await stabilize(session.page, { pseudoLoc: session.profile.pseudoLoc, killMotion }));
  }

  // Патчи агента возвращаем последними: они должны перебивать и стили страницы,
  // и служебный CSS стабилизации.
  await reapplyInjections(session);
  session.navByTool = false;

  /* Заголовки и редиректы нужны SEO-проверкам и живут только здесь: дальше Response недоступен. */
  session.lastResponse = await responseFacts(response);

  const status = session.lastResponse.status;
  const result = {
    status,
    url: sanitizeUrl(session.page.url()),
    title: await session.page.title().catch(() => ''),
  };
  if (repeat) {
    if (cdp) result.reloaded = true;
    else result.cacheNote = 'Адрес тот же, что был открыт, а кэш этого движка стенд сбросить не может: стили и скрипты могли прийти старыми. Если ждёте свежую правку — добавьте к адресу ?v=<число>.';
  }
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
  /* Переход, о котором попросили, неожиданностью не является: отметку сдвигаем, иначе
     первое же действие после browser_goto сообщало бы о навигации, и признак обесценился бы. */
  session.navSeen = session.navSeq;

  if (status === 401) {
    result.hint = 'Страница за HTTP-аутентификацией. Передайте auth: "пользователь:пароль" при открытии сессии — в URL логин зашивать не надо.';
  }
  if (status === 403 && response) {
    const body = await response.text().catch(() => '');
    const hint = blockedHostHint(status, body.slice(0, 2000), url);
    if (hint) result.hint = hint;
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
