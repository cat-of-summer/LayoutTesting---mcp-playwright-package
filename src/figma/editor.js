/**
 * Канал редактора: Plugin API в браузере стенда.
 *
 * В залогиненной вкладке редактора Figma доступен глобальный window.figma — тот же Plugin API,
 * что у плагинов, и у него нет лимита запросов. Прошлый агент дошёл до него руками: обход
 * CloudFront, вход, сохранение кук, browser_eval. Здесь то же самое делает стенд, а агент не
 * знает ни пароля, ни порядка входа.
 *
 * Что канал даёт сверх REST:
 *   - exportAsync({ format: 'JSON_REST_V1' }) — узел в форме ответа REST, поэтому снимок
 *     нормализуется тем же кодом и модели каналов совпадают;
 *   - значения переменных (Variables REST API есть только на Enterprise);
 *   - getCSSAsync — CSS, который считает сама Figma;
 *   - ключевые кадры анимаций, если у аккаунта включён motion;
 *   - рендеры, SVG и исходники картинок без tier 1.
 *
 * Держится канал на том, что редактор отдаёт window.figma в странице, — это может перестать
 * работать после обновления Figma. Поэтому любой отказ здесь не роняет разбор: снимок в режиме
 * auto уходит в REST, а причина видна в figma_status.
 *
 * Одна вкладка на процесс, операции идут строго по очереди: Plugin API одного редактора не
 * рассчитан на параллельные обходы, а вторая вкладка — это ещё сотни мегабайт.
 */
import fs from 'node:fs/promises';
import { FIGMA } from '../constants.js';
import { closeSession, createSession } from '../browser/pool.js';
import { exportState, statePath } from '../browser/storage.js';
import { TOKEN_SCOPES } from './api.js';
import { loginConfigured, redact, registerTokenIssuer } from './auth.js';

/* Без обычной строки десктопного Chrome CloudFront отвечает headless-браузеру 403 ещё до Figma. */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEADERS = { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' };
const LOGIN_URL = 'https://www.figma.com/login';
const FILES_URL = 'https://www.figma.com/files/recent';
const fileUrl = (fileKey) => `https://www.figma.com/design/${encodeURIComponent(fileKey)}/`;

/** Сколько не повторять вход после сбоя: иначе каждый вызов в режиме auto ждал бы минуту таймаута. */
const COOLDOWN_MS = 5 * 60 * 1000;

export class EditorUnavailable extends Error {
  constructor(message, state = 'error') {
    super(redact(message));
    this.name = 'EditorUnavailable';
    this.state = state;
  }
}

export const editorStateName = () => FIGMA.storageState || 'figma-editor';

async function stateExists() {
  try {
    await fs.access(statePath(editorStateName()));
    return true;
  } catch {
    return false;
  }
}

let current = null;
let idleTimer = null;
let queue = Promise.resolve();
let status = { state: 'idle' };

function setStatus(state, reason = null) {
  status = { state, at: new Date().toISOString(), ...(reason ? { reason: redact(reason) } : {}) };
}

function fail(state, reason) {
  setStatus(state, reason);
  return new EditorUnavailable(reason, state);
}

function exclusive(fn) {
  const job = queue.then(fn, fn);
  queue = job.catch(() => {});
  return job;
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  if (!FIGMA.editorIdleMs) return;
  idleTimer = setTimeout(() => {
    exclusive(() => closeEditor('idle')).catch(() => {});
  }, FIGMA.editorIdleMs);
  idleTimer.unref?.();
}

async function closeEditor(reason = 'closed') {
  clearTimeout(idleTimer);
  if (!current) return false;
  const { session } = current;
  current = null;
  await closeSession(session.id, reason).catch(() => {});
  if (status.state === 'ready') setStatus('idle');
  return true;
}

async function ensureSession() {
  if (current && !current.session.page.isClosed()) return current;
  const profile = { browser: 'chromium', viewport: '1600x1000', userAgent: DESKTOP_UA, extraHTTPHeaders: HEADERS };
  if (await stateExists()) profile.storageState = editorStateName();
  current = { session: await createSession(profile, { owned: 'internal' }), fileKey: null, awaitingOtp: false };
  return current;
}

/**
 * Годится ли канал прямо сейчас.
 *
 * needs_human не снимается сам: капчу или письмо проходит человек, а повторный вход без него
 * только добавит подозрений у Figma. Ошибки и блокировку CloudFront стоит перепробовать, но не
 * на каждом вызове.
 */
export async function editorUsable() {
  if (FIGMA.editor === 'off') return false;
  if (status.state === 'needs_human' || status.state === 'needs_login') return false;
  if ((status.state === 'error' || status.state === 'blocked') && Date.now() - Date.parse(status.at) < COOLDOWN_MS) {
    return false;
  }
  return loginConfigured() || (await stateExists());
}

export async function editorStatus() {
  return {
    mode: FIGMA.editor,
    configured: FIGMA.editor !== 'off' && (loginConfigured() || (await stateExists())),
    login: loginConfigured() ? 'env' : (await stateExists()) ? 'saved' : null,
    state: editorStateName(),
    ...status,
    open: Boolean(current),
    ...(current?.fileKey ? { file: current.fileKey } : {}),
  };
}

const OTP_FIELD = 'input[autocomplete="one-time-code"], input[name="totp"], input[inputmode="numeric"]';

/** Чем кончилась попытка входа: ушли со страницы логина, или Figma чего-то хочет от человека. */
async function loginOutcome(page, timeout = 45_000) {
  const handle = await page
    .waitForFunction(
      (otpSelector) => {
        if (!location.pathname.startsWith('/login')) return 'ok';
        const text = document.body?.innerText || '';
        if (document.querySelector(otpSelector)) return 'otp';
        if (document.querySelector('iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[src*="arkoselabs"]')) {
          return 'captcha';
        }
        if (/check your (email|inbox)|verify (it'?s you|your (email|login|device))/i.test(text)) return 'verify';
        if (/(incorrect|invalid|wrong)[^.]{0,40}(password|email)|(password|email)[^.]{0,40}(incorrect|invalid|wrong)/i.test(text)) {
          return 'invalid';
        }
        return false;
      },
      OTP_FIELD,
      { timeout, polling: 500 },
    )
    .catch(() => null);
  return handle ? handle.jsonValue() : 'timeout';
}

async function finishLogin() {
  current.awaitingOtp = false;
  await exportState(current.session, editorStateName());
  setStatus('ready');
}

async function submitOtp(page, otp) {
  const field = page.locator(OTP_FIELD).first();
  await field.fill(String(otp));
  await field.press('Enter');
  const outcome = await loginOutcome(page);
  if (outcome !== 'ok') {
    throw fail('needs_human', `Figma не приняла код (${outcome}). Запросите у человека свежий код и повторите figma_status с action: login и otp.`);
  }
  await finishLogin();
}

async function login(page, { otp } = {}) {
  if (current.awaitingOtp && otp) return submitOtp(page, otp);

  const email = process.env.FIGMA_EMAIL?.trim();
  const password = process.env.FIGMA_PASSWORD;
  if (!email || !password) {
    throw fail(
      'needs_login',
      `Входа в редактор нет: сохранённое состояние ${editorStateName()} отсутствует или истекло, а FIGMA_EMAIL и FIGMA_PASSWORD не заданы в .env стенда.`,
    );
  }

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('#email').waitFor({ timeout: 30_000 });
  await page
    .locator('button', { hasText: /do not allow cookies/i })
    .first()
    .click({ timeout: 2000 })
    .catch(() => {});
  await page.fill('#email', email);
  await page.fill('#current-password', password);
  await page.locator('#auth-view-page button', { hasText: /^log in$/i }).first().click();

  const outcome = await loginOutcome(page);
  if (outcome === 'ok') return finishLogin();
  if (outcome === 'otp') {
    current.awaitingOtp = true;
    if (otp) return submitOtp(page, otp);
    throw fail('needs_human', 'Figma запросила код двухфакторной аутентификации. Спросите код у человека и вызовите figma_status с action: login и otp.');
  }
  const manual =
    `Войти можно руками через стенд: browser_open на ${LOGIN_URL} с userAgent десктопного Chrome, пройти проверку, ` +
    `затем browser_storage с action: export и именем ${editorStateName()}, после чего figma_status с action: login.`;
  if (outcome === 'captcha') throw fail('needs_human', `Figma показала капчу при входе. ${manual}`);
  if (outcome === 'verify') throw fail('needs_human', `Figma просит подтвердить вход по ссылке из письма. Человеку нужно открыть письмо, после этого — figma_status с action: login.`);
  if (outcome === 'invalid') throw fail('needs_login', 'Figma отклонила FIGMA_EMAIL или FIGMA_PASSWORD. Проверьте их в .env стенда.');
  throw fail('error', `Вход в Figma не завершился за 45 с. ${manual}`);
}

/** Что стоит на странице файла: готовый редактор, анонимный просмотр, страница входа или отказ. */
async function fileOutcome(page, timeout = 60_000) {
  const handle = await page
    .waitForFunction(
      () => {
        if (typeof window.figma !== 'undefined') return window.figma.currentUser ? 'ready' : 'anonymous';
        if (location.pathname.startsWith('/login')) return 'login';
        const text = document.body?.innerText || '';
        if (/WebGL/i.test(text) && /(support|enable)/i.test(text)) return 'webgl';
        if (/could not be satisfied/i.test(document.title)) return 'blocked';
        if (/sign up to (comment|edit)|log in to (view|edit|comment)/i.test(text)) return 'anonymous';
        if (/(don'?t|do not) have (access|permission)|request access/i.test(text)) return 'no-access';
        return false;
      },
      null,
      { timeout, polling: 500 },
    )
    .catch(() => null);
  return handle ? handle.jsonValue() : 'timeout';
}

async function openFile(fileKey) {
  await ensureSession();
  const page = current.session.page;
  if (current.fileKey === fileKey && (await page.evaluate(() => typeof window.figma !== 'undefined').catch(() => false))) {
    return page;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(fileUrl(fileKey), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const outcome = await fileOutcome(page);
    if (outcome === 'ready') {
      current.fileKey = fileKey;
      setStatus('ready');
      return page;
    }
    if ((outcome === 'login' || outcome === 'anonymous') && attempt === 0) {
      await login(page);
      continue;
    }
    if (outcome === 'blocked') throw fail('blocked', 'CloudFront отклонил браузер стенда (403) ещё до Figma.');
    if (outcome === 'webgl') throw fail('error', 'Редактор Figma сообщил, что WebGL недоступен: канал работает только в chromium стенда.');
    if (outcome === 'no-access') throw fail('error', `Аккаунту в редакторе не открыт файл ${fileKey}.`);
    throw fail('error', `Редактор не отдал window.figma для файла ${fileKey} (${outcome}).`);
  }
  throw fail('needs_login', 'После входа Figma всё равно открыла файл без аккаунта.');
}

/* Функции ниже выполняются внутри страницы редактора: из внешней области они ничего не видят. */

const DUMP = async ({ ids, withCss }) => {
  const out = { nodes: {}, notFound: [], variables: {}, css: {}, motion: {}, motionSupported: true };
  const texts = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || typeof node.exportAsync !== 'function') {
      out.notFound.push(id);
      continue;
    }
    const rest = await node.exportAsync({ format: 'JSON_REST_V1' });
    out.nodes[id] = rest;
    texts.push(JSON.stringify(rest));

    const all = [];
    (function walk(n) {
      all.push(n.id);
      for (const child of n.children || []) walk(child);
    })(rest.document);
    for (const nid of all) {
      const live = await figma.getNodeByIdAsync(nid);
      if (!live) continue;
      if (out.motionSupported === true && 'animations' in live) {
        try {
          const animations = live.animations;
          if (animations && animations.length) out.motion[nid] = JSON.parse(JSON.stringify(animations));
        } catch (err) {
          out.motionSupported = String((err && err.message) || err);
        }
      }
      if (withCss && Object.keys(out.css).length < 400) {
        try {
          out.css[nid] = await live.getCSSAsync();
        } catch {
          /* У части узлов CSS нет вовсе — это не ошибка снимка. */
        }
      }
    }
  }

  const collections = {};
  const pending = [...new Set(texts.join('').match(/VariableID:[^"\\]+/g) || [])];
  while (pending.length) {
    const id = pending.shift();
    if (out.variables[id]) continue;
    let variable = null;
    try {
      variable = await figma.variables.getVariableByIdAsync(id);
    } catch {
      variable = null;
    }
    if (!variable) {
      out.variables[id] = { missing: true };
      continue;
    }
    if (!(variable.variableCollectionId in collections)) {
      collections[variable.variableCollectionId] = await figma.variables
        .getVariableCollectionByIdAsync(variable.variableCollectionId)
        .catch(() => null);
    }
    const collection = collections[variable.variableCollectionId];
    const modes = {};
    for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
      const mode = collection && collection.modes.find((m) => m.modeId === modeId);
      modes[mode ? mode.name : modeId] = value;
      if (value && value.type === 'VARIABLE_ALIAS' && !out.variables[value.id]) pending.push(value.id);
    }
    const defaultMode = collection && collection.modes.find((m) => m.modeId === collection.defaultModeId);
    out.variables[id] = {
      name: variable.name,
      type: variable.resolvedType,
      collection: collection ? collection.name : null,
      defaultMode: defaultMode ? defaultMode.name : null,
      remote: variable.remote,
      modes,
      ...(variable.description ? { description: variable.description } : {}),
    };
  }
  return JSON.stringify(out);
};

const RENDER = async (items) => {
  const toBase64 = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const out = {};
  for (const { id, scale, format } of items) {
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (!node || typeof node.exportAsync !== 'function') {
        out[id] = { error: 'узел не найден' };
      } else if (format === 'svg') {
        out[id] = { svg: await node.exportAsync({ format: 'SVG_STRING' }) };
      } else {
        out[id] = { base64: toBase64(await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } })) };
      }
    } catch (err) {
      out[id] = { error: String((err && err.message) || err) };
    }
  }
  return JSON.stringify(out);
};

const IMAGES = async (refs) => {
  const toBase64 = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const out = {};
  for (const ref of refs) {
    try {
      const image = figma.getImageByHash(ref);
      out[ref] = image ? { base64: toBase64(await image.getBytesAsync()) } : { error: 'картинки с таким хэшем нет' };
    } catch (err) {
      out[ref] = { error: String((err && err.message) || err) };
    }
  }
  return JSON.stringify(out);
};

const PAGES = async () => {
  await figma.loadAllPagesAsync();
  return JSON.stringify(
    figma.root.children.map((page) => ({
      id: page.id,
      name: page.name,
      frames: page.children
        .filter((child) => child.visible !== false)
        .map((child) => ({ id: child.id, name: child.name, type: child.type, w: Math.round(child.width), h: Math.round(child.height) })),
    })),
  );
};

async function inFile(fileKey, fn, arg) {
  return exclusive(async () => {
    const page = await openFile(fileKey);
    scheduleIdle();
    try {
      return JSON.parse(await page.evaluate(fn, arg));
    } catch (err) {
      if (err instanceof EditorUnavailable) throw err;
      throw fail('error', `Plugin API в редакторе отказал: ${err.message}`);
    }
  });
}

export const editorDump = (fileKey, ids, { css = false } = {}) => inFile(fileKey, DUMP, { ids, withCss: css });
export const editorRender = (fileKey, items) => inFile(fileKey, RENDER, items);
export const editorImages = (fileKey, refs) => inFile(fileKey, IMAGES, refs);
export const editorPages = (fileKey) => inFile(fileKey, PAGES, null);

/**
 * Войти заново или дозавершить вход кодом.
 *
 * Без файла: проверяется страница со списком файлов — она требует аккаунта и не грузит редактор.
 */
export function editorLogin({ otp } = {}) {
  return exclusive(async () => {
    if (FIGMA.editor === 'off') throw new EditorUnavailable('Канал редактора выключен: FIGMA_EDITOR=off.', 'off');
    await ensureSession();
    const page = current.session.page;
    if (current.awaitingOtp && otp) {
      await submitOtp(page, otp);
    } else {
      setStatus('idle');
      await page.goto(FILES_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
      if (page.url().includes('/login')) await login(page, { otp });
      else await finishLogin();
    }
    current.fileKey = null;
    scheduleIdle();
    return editorStatus();
  });
}

/** Забыть вход. Состояние, которое человек указал сам через FIGMA_STORAGE_STATE, не трогаем. */
export function editorLogout() {
  return exclusive(async () => {
    await closeEditor('closed');
    if (!FIGMA.storageState) await fs.rm(statePath(editorStateName()), { force: true });
    setStatus('idle');
    return editorStatus();
  });
}

/*
 * Выпуск личного токена REST через настройки аккаунта.
 *
 * Путь проверен на живом интерфейсе 2026-09-11: меню аккаунта → Settings → вкладка Security →
 * Personal access tokens → Generate new token. В форме поле #name, срок (1, 7, 30 или 90 дней —
 * больше не бывает) и чекбоксы scope без подписей: какой чекбокс к какому scope, видно только по
 * тексту строки. Токен показывается один раз, сразу после выпуска.
 *
 * Права — только чтение, ровно те, что нужны инструментам (TOKEN_SCOPES). Срок — максимальный:
 * каждый выпуск — это запись в чужом аккаунте, и делать её реже лучше, чем чаще.
 */

const TOKEN_DAYS = 90;
const TOKEN_PREFIX = 'layout-stand';

/** Выполняется в форме выпуска: отмечает нужные scope и возвращает те, которых не нашлось. */
const CHECK_SCOPES = (root, scopes) => {
  const byScope = new Map();
  for (const box of root.querySelectorAll('input[type="checkbox"]')) {
    let el = box.parentElement;
    for (let depth = 0; el && depth < 6; depth += 1, el = el.parentElement) {
      if (el.querySelectorAll('input[type="checkbox"]').length > 1) break;
      const scope = (el.innerText || '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^[a-z_]+:(read|write)$/.test(line));
      if (scope) {
        byScope.set(scope, box);
        break;
      }
    }
  }
  const missing = [];
  for (const scope of scopes) {
    const box = byScope.get(scope);
    if (!box) missing.push(scope);
    else if (!box.checked) box.click();
  }
  return missing;
};

async function openSecurity(page) {
  await page.goto(FILES_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const account = page.locator('button[aria-label^="Account dropdown"]').first();
  try {
    await account.waitFor({ timeout: 30_000 });
  } catch {
    if (!page.url().includes('/login')) {
      throw new EditorUnavailable('На странице файлов Figma не найдено меню аккаунта: интерфейс изменился.');
    }
    await login(page);
    await page.goto(FILES_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await account.waitFor({ timeout: 30_000 });
  }
  await account.click();
  await page.locator('[role="menuitem"]', { hasText: /^Settings$/ }).first().click({ timeout: 10_000 });
  const settings = page.locator('[role="dialog"]').last();
  await settings.getByText('Security', { exact: true }).first().click({ timeout: 10_000 });
  await settings.getByText('Personal access tokens', { exact: true }).first().waitFor({ timeout: 10_000 });
  return settings;
}

/**
 * Отозвать прежний токен стенда, чтобы они не копились в аккаунте.
 *
 * Список выпущенных токенов вживую не видели — в аккаунте их не было, — поэтому здесь поиск строки
 * по имени и кнопки Revoke рядом. Не нашлось — выпуск не срывается, а в ответе сказано, что
 * прежний токен остался и его стоит отозвать руками.
 */
async function revokeToken(page, settings, name) {
  const row = settings
    .locator('div', { hasText: name })
    .filter({ has: page.getByRole('button', { name: /revoke/i }) })
    .last();
  if (!(await row.count())) return `прежний токен «${name}» в списке не найден — если он есть, его стоит отозвать руками`;
  await row.getByRole('button', { name: /revoke/i }).first().click({ timeout: 5000 });
  const confirm = page.locator('[role="dialog"]').last().getByRole('button', { name: /^revoke/i });
  if (await confirm.count()) await confirm.last().click({ timeout: 5000 }).catch(() => {});
  return `прежний токен «${name}» отозван`;
}

export function editorIssueToken({ previous = null, scopes = TOKEN_SCOPES, days = TOKEN_DAYS } = {}) {
  return exclusive(async () => {
    if (FIGMA.editor === 'off') throw new EditorUnavailable('Канал редактора выключен: FIGMA_EDITOR=off.', 'off');
    await ensureSession();
    const page = current.session.page;
    current.fileKey = null;
    try {
      const settings = await openSecurity(page);
      const revoked = previous?.name ? await revokeToken(page, settings, previous.name) : null;

      await settings.getByRole('button', { name: 'Generate new token' }).click({ timeout: 10_000 });
      const form = page.locator('[role="dialog"]').last();
      const name = `${TOKEN_PREFIX} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      await form.locator('#name').fill(name, { timeout: 10_000 });
      await form.locator('button[role="combobox"]').first().click();
      await page.locator('[role="option"]', { hasText: new RegExp(`^${days} days$`) }).first().click({ timeout: 5000 });
      const missing = await form.evaluate(CHECK_SCOPES, scopes);
      if (missing.length) {
        throw new EditorUnavailable(`В форме выпуска токена нет scope ${missing.join(', ')}: интерфейс Figma изменился.`);
      }
      await form.getByRole('button', { name: 'Generate token' }).click({ timeout: 10_000 });

      const handle = await page.waitForFunction(
        () => {
          const texts = [...document.querySelectorAll('input, textarea')].map((el) => el.value);
          texts.push(document.body.innerText);
          for (const text of texts) {
            const match = /figd_[A-Za-z0-9_-]{20,}/.exec(text || '');
            if (match) return match[0];
          }
          return false;
        },
        null,
        { timeout: 30_000, polling: 500 },
      );
      const token = await handle.jsonValue();
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      scheduleIdle();

      const issuedAt = new Date();
      return {
        token,
        name,
        scopes,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
        ...(revoked ? { previousRevoked: revoked } : {}),
      };
    } catch (err) {
      /* Сбой выпуска не выключает канал: снимки через редактор от него не зависят. */
      if (err instanceof EditorUnavailable) throw err;
      throw new EditorUnavailable(`Выпуск токена через настройки Figma не удался: ${err.message}`);
    }
  });
}

registerTokenIssuer(async ({ previous }) => {
  if (!(await editorUsable())) throw new Error('Канал редактора недоступен — выпускать токен нечем.');
  return editorIssueToken({ previous });
});

/** То, что нужно снимку и выгрузке, одним объектом: там канал подменяется в тестах. */
export const editorChannel = {
  usable: editorUsable,
  dump: editorDump,
  render: editorRender,
  images: editorImages,
  pages: editorPages,
};
