import { chromium, firefox, webkit } from 'playwright';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { contextOptions, normalizeProfile, profileKey } from './profile.js';
import { applyProfileToPage, applyThrottle, stabilize } from './stabilize.js';

const ENGINES = { chromium, firefox, webkit };

/** Запущенные браузеры переиспользуются: старт webkit стоит секунды. */
const browsers = new Map();
/** Живые сессии MCP: контекст + страница + собранные логи. */
const sessions = new Map();

export async function getBrowser(name = 'chromium') {
  const engine = ENGINES[name];
  if (!engine) throw new Error(`Неизвестный браузер: ${name}. Доступны: ${Object.keys(ENGINES).join(', ')}`);
  const existing = browsers.get(name);
  if (existing && existing.isConnected()) return existing;

  const args = name === 'chromium'
    ? [
        // Контейнер работает от root, а под root Chromium без этого не стартует.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Сглаживание шрифтов иначе пляшет между прогонами и ломает pixel-diff.
        '--font-render-hinting=none',
        '--disable-lcd-text',
      ]
    : [];
  const browser = await engine.launch({ args });
  browsers.set(name, browser);
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

function attachCollectors(page, store) {
  page.on('console', (msg) => {
    store.console.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      at: new Date().toISOString(),
    });
  });
  page.on('pageerror', (err) => {
    store.errors.push({ message: err.message, stack: err.stack, at: new Date().toISOString() });
  });
  page.on('requestfailed', (req) => {
    store.network.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText || 'failed',
      status: null,
    });
  });
  page.on('response', (res) => {
    store.network.push({
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
  const browser = await getBrowser(profile.browser);
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
  }));
}

export async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  await session.context.close().catch(() => {});
  return true;
}

export async function gotoAndSettle(session, url, { waitUntil = 'load', stabilizePage = true } = {}) {
  const response = await session.page.goto(url, { waitUntil, timeout: CONFIG.defaultTimeout });
  if (stabilizePage) {
    await stabilize(session.page, { pseudoLoc: session.profile.pseudoLoc });
  }
  return {
    status: response?.status() ?? null,
    url: session.page.url(),
    title: await session.page.title().catch(() => ''),
  };
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
