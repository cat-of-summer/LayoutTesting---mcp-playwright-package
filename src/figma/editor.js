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
 *
 * Состояние два уровня. Общее (status) — вход в аккаунт: ready значит «залогинен», и только.
 * По файлу (files) — открывается ли именно этот файл: файл, открытый аккаунту только на
 * просмотр, редактор показывает без Plugin API, и window.figma в нём не появится никогда.
 * Раньше такой файл минуту ждал window.figma, падал с timeout, а figma_status после login
 * снова показывал ready — агент повторял тот же вызов, не видя причины.
 */
import fs from 'node:fs/promises';
import { FIGMA } from '../constants.js';
import { closeSession, createSession } from '../browser/pool.js';
import { exportState, statePath } from '../browser/storage.js';
import { closeHandoff, handoffOpen, handoffStatus, openHandoff } from '../browser/handoff.js';
import { TOKEN_SCOPES } from './api.js';
import { loginConfigured, redact, registerTokenIssuer } from './auth.js';
import { readCopy, writeCopy } from './copies.js';
import { waitForDownload } from '../browser/downloads.js';
import { PANEL_SNAPSHOT } from './ui.js';

/* Без обычной строки десктопного Chrome CloudFront отвечает headless-браузеру 403 ещё до Figma. */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEADERS = { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' };
const LOGIN_URL = 'https://www.figma.com/login';
const FILES_URL = 'https://www.figma.com/files/recent';
const fileUrl = (fileKey) => `https://www.figma.com/design/${encodeURIComponent(fileKey)}/`;

/** Назначение передачи браузера человеку: одна на канал, вторая проверка заменяет первую. */
const HANDOFF = 'figma-login';

/** Сколько не повторять вход после сбоя: иначе каждый вызов в режиме auto ждал бы минуту таймаута. */
const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Сколько помнить, что файл открыт только на просмотр или не открыт вовсе. Права выдаёт человек,
 * и через полчаса проверить снова дешевле, чем заставлять его звать figma_status с refresh.
 */
const ACCESS_TTL_MS = 30 * 60 * 1000;

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
/** Сколько операций с файлом ждут или идут: по нему отказывают сверх FIGMA.editorQueueMax. */
let pending = 0;
let status = { state: 'idle' };
/** Состояние по файлу: ключ оригинала → { state: ready | view_only | no_access | error, at, reason }. */
const files = new Map();
/**
 * Доступ аккаунта к файлу по REST ({ role: owner | editor | viewer, version }) — дешёвый запрос
 * tier 3, после которого файл на просмотр не открывается минуту впустую. Подключает
 * src/figma/access.js: редактор о REST не знает.
 */
let accessProbe = null;

export function registerAccessProbe(fn) {
  accessProbe = fn;
}

/**
 * Кто выбирает команду для копии, когда файл оказался на просмотр посреди работы: (fileKey,
 * команды) → имя команды или { declined: причина }. Подключает src/figma/access.js — там
 * FIGMA_DUPLICATE_TEAM и вопрос человеку формой клиента.
 */
let copyChooser = null;

export function registerCopyChooser(fn) {
  copyChooser = fn;
}

/** Файлы, от копии которых отказались: второй раз за полдня с тем же вопросом не приходить. */
const declined = new Map();
const DECLINE_TTL_MS = 6 * 60 * 60 * 1000;
const obtaining = new Map();

/**
 * Неявная копия: инструмент наткнулся на файл на просмотр — стенд делает копию в черновики и
 * продолжает вызов, а агенту остаётся одна строка «снято с копии». Отзыв, ради которого это
 * есть: агент на таком файле тратил вызовы на отказы и засорял контекст чужими для задачи
 * подробностями. true — копия есть и годится.
 */
async function obtainCopy(fileKey) {
  if (!copyChooser || FIGMA.editor === 'off') return false;
  if (await readCopy(fileKey)) return true;
  if (fresh(declined.get(fileKey), DECLINE_TTL_MS)) return false;
  if (!obtaining.has(fileKey)) {
    const job = (async () => {
      try {
        const access = accessProbe ? await accessProbe(fileKey).catch(() => null) : null;
        const res = await editorDuplicate(fileKey, { choose: (teams) => copyChooser(fileKey, teams), sourceVersion: access?.version ?? null });
        return res.needed ? Boolean(res.copy) : true;
      } catch (err) {
        declined.set(fileKey, { at: new Date().toISOString(), reason: redact(err.message) });
        return false;
      } finally {
        obtaining.delete(fileKey);
      }
    })();
    obtaining.set(fileKey, job);
  }
  return obtaining.get(fileKey);
}

/** Операция с файлом, которая переживает «только просмотр»: копия — и повтор того же вызова. */
async function withCopy(fileKey, run) {
  try {
    return await run();
  } catch (err) {
    if (err?.state !== 'view_only' || !(await obtainCopy(fileKey))) throw err;
    return run();
  }
}

function setStatus(state, reason = null) {
  status = { state, at: new Date().toISOString(), ...(reason ? { reason: redact(reason) } : {}) };
}

function fail(state, reason) {
  setStatus(state, reason);
  return new EditorUnavailable(reason, state);
}

function setFile(fileKey, state, reason = null) {
  files.set(fileKey, { state, at: new Date().toISOString(), ...(reason ? { reason: redact(reason) } : {}) });
}

/** Отказ по одному файлу: вход в аккаунт исправен, общее состояние не трогается. */
function failFile(fileKey, state, reason) {
  setFile(fileKey, state, reason);
  return new EditorUnavailable(reason, state);
}

/** Что делать с файлом на просмотр — одним текстом для ошибки, figma_status и подсказок. */
export function viewOnlyReason(fileKey, by = 'editor') {
  const how = by === 'rest' ? 'роль viewer по /v1/files/:key/meta' : 'в редакторе вместо инструментов кнопка «Ask to edit»';
  return (
    `Аккаунту стенда файл ${fileKey} открыт только на просмотр (${how}): Plugin API в этом режиме нет, повторы не помогут. ` +
    'Выходы: edit-доступ от владельца файла; копия в черновики — figma_sync с duplicate: "<команда>", команду называет человек ' +
    '(сам стенд копирует, если задан FIGMA_DUPLICATE_TEAM или клиент умеет спрашивать человека формой); иначе — канал ui: ' +
    'figma_inspect и figma_export с channel: "ui" снимают значения с панели свойств и выгружают кнопкой Export.'
  );
}

const fresh = (entry, ms) => entry && Date.now() - Date.parse(entry.at) < ms;

function exclusive(fn) {
  const job = queue.then(fn, fn);
  queue = job.catch(() => {});
  return job;
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  if (!FIGMA.editorIdleMs) return;
  idleTimer = setTimeout(() => {
    /* Пока человек проходит проверку во вкладке, закрыть её значит оборвать его на полуслове. */
    if (handoffOpen(HANDOFF)) return scheduleIdle();
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
  for (const [key, entry] of files) if (entry.state === 'ready') files.delete(key);
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
/**
 * copy: false — только ответить, не делая копию: так спрашивают figma_status и подсказки, им
 * незачем заводить файл в чужом аккаунте ради ответа на вопрос.
 */
export async function editorUsable(fileKey = null, { copy = true } = {}) {
  if (FIGMA.editor === 'off') return false;
  if (status.state === 'needs_human' || status.state === 'needs_login') return false;
  if ((status.state === 'error' || status.state === 'blocked') && fresh(status, COOLDOWN_MS)) {
    return false;
  }
  if (!(loginConfigured() || (await stateExists()))) return false;
  return fileKey ? fileUsable(fileKey, { copy }) : true;
}

/**
 * Годится ли канал для этого файла. Есть копия в черновиках — годится: открывается она. Нет —
 * сначала роль по REST, если есть токен: viewer значит, что Plugin API не будет, и тогда, если
 * можно, делается копия.
 */
async function fileUsable(fileKey, { copy: mayCopy = true } = {}) {
  const copy = await readCopy(fileKey);
  if (copy) {
    const entry = files.get(fileKey);
    return !(entry?.state === 'error' && fresh(entry, COOLDOWN_MS));
  }
  if (accessProbe) {
    const role = (await accessProbe(fileKey).catch(() => null))?.role;
    if (role === 'viewer') setFile(fileKey, 'view_only', viewOnlyReason(fileKey, 'rest'));
    else if (role && ['view_only', 'no_access'].includes(files.get(fileKey)?.state)) files.delete(fileKey);
  }
  const entry = files.get(fileKey);
  if (!entry) return true;
  if (entry.state === 'view_only' && fresh(entry, ACCESS_TTL_MS)) return mayCopy ? obtainCopy(fileKey) : false;
  if (entry.state === 'view_only' || entry.state === 'no_access') return !fresh(entry, ACCESS_TTL_MS);
  if (entry.state === 'error') return !fresh(entry, COOLDOWN_MS);
  return true;
}

/** Почему канал не годится для файла: причина по файлу, иначе общая. null — годится. */
export async function editorWhy(fileKey = null) {
  if (await editorUsable(fileKey, { copy: false })) return null;
  if (FIGMA.editor === 'off') return 'Канал редактора выключен: FIGMA_EDITOR=off.';
  const entry = fileKey ? files.get(fileKey) : null;
  const refused = fileKey ? declined.get(fileKey) : null;
  /* После отказа от копии варианты из viewOnlyReason уже пройдены: короче и без совета, который
     только что отклонили. */
  if (refused && entry?.state === 'view_only') {
    return `Аккаунту стенда файл ${fileKey} открыт только на просмотр, Plugin API нет; копия в черновики не сделана: ${refused.reason}`;
  }
  if (entry?.reason && entry.state !== 'ready') return entry.reason;
  if (status.reason) return status.reason;
  if (!loginConfigured() && !(await stateExists())) return 'Входа в редактор нет: FIGMA_EMAIL и FIGMA_PASSWORD не заданы, сохранённого входа нет.';
  return `Канал редактора в состоянии ${status.state}: figma_status покажет причину.`;
}

/** Состояние канала по одному файлу — для figma_status с figma и для подсказок. */
export async function editorFileStatus(fileKey) {
  const entry = files.get(fileKey);
  const copy = await readCopy(fileKey);
  return {
    state: entry?.state ?? 'unknown',
    ...(entry?.at ? { at: entry.at } : {}),
    ...(entry?.reason ? { reason: entry.reason } : {}),
    ...(copy ? { copy } : {}),
  };
}

export async function editorStatus() {
  return {
    mode: FIGMA.editor,
    configured: FIGMA.editor !== 'off' && (loginConfigured() || (await stateExists())),
    login: loginConfigured() ? 'env' : (await stateExists()) ? 'saved' : null,
    storageState: editorStateName(),
    /* state — про вход в аккаунт. Открывается ли конкретный файл, видно в files. */
    ...status,
    open: Boolean(current),
    ...(current?.fileKey ? { file: current.fileKey } : {}),
    ...(files.size ? { files: Object.fromEntries(files) } : {}),
    ...(handoffStatus(HANDOFF) ? { handoff: handoffStatus(HANDOFF) } : {}),
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
  closeHandoff(HANDOFF, 'done');
}

/**
 * Проверку, которую Figma устроила при входе, проходит человек — в той же вкладке стенда, через
 * страницу /handoff/<токен>. Стенд следит за вкладкой сам: ушли со страницы входа — вход
 * сохраняется, канал снова ready, и агенту остаётся лишь повторить свой вызов.
 */
function offerHandoff(page, reason) {
  const session = current;
  const handoff = openHandoff({
    page,
    purpose: HANDOFF,
    reason,
    allowHosts: ['figma.com'],
    isDone: async (tab) => {
      const url = new URL(tab.url());
      if (!/(^|\.)figma\.com$/.test(url.hostname) || url.pathname.startsWith('/login')) return false;
      /* Со страницы входа уходят и на подтверждение по почте: готово — когда есть меню аккаунта
         или открыт файл с пользователем. */
      return tab
        .evaluate(
          () =>
            Boolean(document.querySelector('button[aria-label^="Account dropdown"]')) ||
            Boolean(window.figma && window.figma.currentUser),
        )
        .catch(() => false);
    },
    onDone: async () => {
      if (current !== session) return;
      current.awaitingOtp = false;
      await exportState(current.session, editorStateName());
      setStatus('ready');
      scheduleIdle();
    },
  });
  return handoff.url;
}

const HANDOFF_HINT = (url) =>
  `передайте человеку ссылку ${url} (она же в editor.handoff.url): там живой экран браузера стенда, проверку он проходит сам. Стенд заметит успешный вход и сохранит его; после этого повторите вызов.`;

async function submitOtp(page, otp) {
  const field = page.locator(OTP_FIELD).first();
  await field.fill(String(otp));
  await field.press('Enter');
  const outcome = await loginOutcome(page);
  if (outcome !== 'ok') {
    const url = offerHandoff(page, 'Figma не приняла код: введите свежий код на снимке.');
    throw fail(
      'needs_human',
      `Figma не приняла код (${outcome}). Запросите у человека свежий код и повторите figma_status с action: login и otp — либо ${HANDOFF_HINT(url)}`,
    );
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
    /* Тот же ввод кода бывает двух видов: код из приложения 2FA и код из письма на почту аккаунта
       («Check your inbox»). Человеку важно знать, где его искать. */
    const byEmail = await page
      .evaluate(() => /check your (inbox|email)|sent to your email/i.test(document.body?.innerText || ''))
      .catch(() => false);
    const what = byEmail ? 'код из письма, которое Figma отправила на почту аккаунта' : 'код двухфакторной аутентификации';
    const url = offerHandoff(page, `Figma запросила ${what}: введите его в поле на снимке.`);
    throw fail(
      'needs_human',
      `Figma запросила ${what}. Спросите код у человека и вызовите figma_status с action: login и otp — либо ${HANDOFF_HINT(url)}`,
    );
  }
  if (outcome === 'captcha') {
    const url = offerHandoff(page, 'Figma показала капчу при входе: пройдите её на снимке.');
    throw fail('needs_human', `Figma показала капчу при входе. Капчу проходит только человек: ${HANDOFF_HINT(url)}`);
  }
  if (outcome === 'verify') {
    const url = offerHandoff(page, 'Figma просит подтвердить вход по ссылке из письма: вставьте ссылку из письма в поле «Открыть адрес».');
    throw fail('needs_human', `Figma просит подтвердить вход по ссылке из письма. Ссылку нужно открыть в браузере стенда, а не в своём: ${HANDOFF_HINT(url)}`);
  }
  const manual =
    `Войти можно руками через стенд: browser_open на ${LOGIN_URL} с userAgent десктопного Chrome, пройти проверку, ` +
    `затем browser_storage с action: export и именем ${editorStateName()}, после чего figma_status с action: login.`;
  if (outcome === 'invalid') throw fail('needs_login', 'Figma отклонила FIGMA_EMAIL или FIGMA_PASSWORD. Проверьте их в .env стенда.');
  throw fail('error', `Вход в Figma не завершился за 45 с. ${manual}`);
}

/**
 * Что стоит на странице файла: готовый редактор, режим просмотра, анонимный просмотр, страница
 * входа или отказ.
 *
 * Режим просмотра узнаётся по кнопке «Ask to edit» на панели инструментов (проверено на живом
 * файле 2026-10-29): Plugin API в нём нет, и ждать window.figma дальше бессмысленно. Кнопок
 * с этим текстом несколько, видимая одна — поэтому textContent, а не innerText.
 */
export async function fileOutcome(page, timeout = 60_000) {
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
        for (const button of document.querySelectorAll('button')) {
          if (/^(ask to edit|request edit access)$/i.test((button.textContent || '').trim())) return 'view';
        }
        return false;
      },
      null,
      { timeout, polling: 500 },
    )
    .catch(() => null);
  return handle ? handle.jsonValue() : 'timeout';
}

/** Открыть файл в редакторе. Если у файла есть копия в черновиках, открывается она. */
async function openFile(fileKey) {
  await ensureSession();
  const page = current.session.page;
  const copy = await readCopy(fileKey);
  const target = copy?.copyKey ?? fileKey;
  if (current.fileKey === target && (await page.evaluate(() => typeof window.figma !== 'undefined').catch(() => false))) {
    return page;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(fileUrl(target), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const outcome = await fileOutcome(page);
    if (outcome === 'ready') {
      current.fileKey = target;
      setStatus('ready');
      setFile(fileKey, 'ready');
      return page;
    }
    if ((outcome === 'login' || outcome === 'anonymous') && attempt === 0) {
      await login(page);
      continue;
    }
    if (outcome === 'blocked') throw fail('blocked', 'CloudFront отклонил браузер стенда (403) ещё до Figma.');
    if (outcome === 'webgl') throw fail('error', 'Редактор Figma сообщил, что WebGL недоступен: канал работает только в chromium стенда.');
    if (copy && (outcome === 'view' || outcome === 'no-access')) {
      throw failFile(
        fileKey,
        'error',
        `Копия ${copy.copyKey} файла ${fileKey} больше не открывается на редактирование (${outcome}): её удалили или перенесли. figma_sync с duplicate: "<команда>" сделает новую.`,
      );
    }
    if (outcome === 'view') throw failFile(fileKey, 'view_only', viewOnlyReason(fileKey));
    if (outcome === 'no-access') throw failFile(fileKey, 'no_access', `Аккаунту стенда не открыт файл ${fileKey}: доступ выдаёт владелец файла.`);
    throw failFile(fileKey, 'error', `Редактор не отдал window.figma для файла ${target} (${outcome}).`);
  }
  throw fail('needs_login', 'После входа Figma всё равно открыла файл без аккаунта.');
}

/* Функции ниже выполняются внутри страницы редактора: из внешней области они ничего не видят. */

const DUMP = async ({ ids, withCss }) => {
  const out = { nodes: {}, notFound: [], variables: {}, css: {}, motion: {}, motionSupported: true, ancestors: {} };
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

    /* Родители снятого корня: JSON_REST_V1 их не несёт, а «где лежит этот узел» — первый вопрос,
       когда ссылка из задачи ведёт не на кадр. От страницы вниз, сама страница включительно.
       Рамка предка нужна комментариям: Figma привязывает их к кадру верхнего уровня смещением
       от его угла, и без рамки кадра не понять, на какой элемент внутри снятого узла они легли. */
    const chain = [];
    for (let up = node.parent; up && up.type !== 'DOCUMENT'; up = up.parent) {
      const rect = up.absoluteBoundingBox;
      chain.unshift({
        id: up.id,
        name: up.name,
        type: up.type,
        ...(rect ? { box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } } : {}),
      });
    }
    out.ancestors[id] = chain;

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

/**
 * Геометрия заливки узла и его потомков — без обводки.
 *
 * SVG_STRING рисует обводку, и у вектора с обводкой снаружи путь съезжает на её толщину, а файл
 * выходит больше узла. Для clip-path нужен контур заливки ровно по узлу. Узел при этом не
 * клонируется и не меняется: читается только fillGeometry.
 */
const GEOMETRY = async (ids) => {
  const out = {};
  for (const id of ids) {
    try {
      const root = await figma.getNodeByIdAsync(id);
      if (!root || !root.absoluteTransform) {
        out[id] = { error: 'узел не найден' };
        continue;
      }
      const [[, , rx], [, , ry]] = root.absoluteTransform;
      const shapes = [];
      const visit = (node) => {
        if (node.visible === false) return;
        if (Array.isArray(node.fillGeometry) && node.fillGeometry.length) {
          const [[a, c, e], [b, d, f]] = node.absoluteTransform;
          const solid = Array.isArray(node.fills) ? node.fills.find((p) => p.type === 'SOLID' && p.visible !== false) : null;
          shapes.push({
            matrix: [a, b, c, d, e - rx, f - ry],
            paths: node.fillGeometry.map((g) => ({ d: g.data, rule: g.windingRule })),
            color: solid ? { r: solid.color.r, g: solid.color.g, b: solid.color.b, a: solid.opacity ?? 1 } : null,
          });
        }
        if ('children' in node) for (const kid of node.children) visit(kid);
      };
      visit(root);
      out[id] = { w: root.width, h: root.height, shapes };
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

/*
 * Поиск по всему файлу: имя слоя или текст. «В UI-ките есть развёрнутое состояние» галереи —
 * кнопку «Загрузить больше» агент не нашёл: снимок знает только снятые кадры, а кит лежал на
 * другой странице. Здесь обходятся все страницы файла; у найденного внутри варианта компонента —
 * набор и его варианты, чтобы состояние было видно сразу.
 */
const FIND = async ({ query, limit }) => {
  await figma.loadAllPagesAsync();
  const q = String(query).toLowerCase();
  const out = [];
  /* Лимит — на сырые совпадения с запасом: ранжирует и режет до limit уже стенд. Раньше limit
     резал по порядку страниц, и экземпляры на макетах съедали все места раньше UI-кита. */
  const cap = Math.max(limit, 2000);
  const ownerOf = (node) => {
    let instance = null;
    for (let up = node; up && up.type !== 'PAGE'; up = up.parent) {
      if (up.type === 'COMPONENT' && up.parent && up.parent.type === 'COMPONENT_SET') return { variant: up, set: up.parent };
      if (up.type === 'COMPONENT_SET') return { variant: null, set: up };
      if (up.type === 'COMPONENT') return { component: up };
      /* Самый внешний экземпляр: карточка на странице, а не кнопка внутри неё. */
      if (up.type === 'INSTANCE') instance = up;
    }
    return instance ? { instance } : null;
  };
  const frameOf = (node) => {
    let up = node;
    while (up.parent && up.parent.type !== 'PAGE') up = up.parent;
    return up;
  };
  const mains = new Map();
  const mainOf = async (instance) => {
    if (!mains.has(instance.id)) {
      let main = null;
      try {
        main = await instance.getMainComponentAsync();
      } catch {
        main = null;
      }
      const set = main && main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : null;
      mains.set(instance.id, main ? { id: main.id, name: main.name, ...(set ? { set: set.name, setId: set.id } : {}), ...(main.remote ? { remote: true } : {}) } : null);
    }
    return mains.get(instance.id);
  };
  for (const page of figma.root.children) {
    if (out.length >= cap) break;
    const found = page.findAll((n) => {
      const name = String(n.name || '').toLowerCase();
      return name.includes(q) || (n.type === 'TEXT' && String(n.characters || '').toLowerCase().includes(q));
    });
    for (const n of found) {
      if (out.length >= cap) break;
      const frame = frameOf(n);
      const owner = ownerOf(n);
      const main = owner && owner.instance ? await mainOf(owner.instance) : null;
      out.push({
        id: n.id,
        name: n.name,
        type: n.type,
        page: page.name,
        ...(frame !== n ? { frame: { id: frame.id, name: frame.name } } : {}),
        ...(n.type === 'TEXT' ? { text: String(n.characters).slice(0, 80) } : {}),
        ...(owner && owner.set
          ? {
              set: {
                id: owner.set.id,
                name: owner.set.name,
                ...(owner.variant ? { variant: owner.variant.name, variantId: owner.variant.id } : {}),
                variants: owner.set.children.map((child) => child.name).slice(0, 12),
              },
            }
          : {}),
        ...(owner && owner.component ? { component: { id: owner.component.id, name: owner.component.name } } : {}),
        ...(owner && owner.instance ? { instance: { id: owner.instance.id, ...(main ? { main } : {}) } } : {}),
      });
    }
  }
  return JSON.stringify(out);
};

/**
 * Обещание с дедлайном: по истечении — ошибка с кодом timeout, само обещание не отменяется.
 * Plugin API оборвать нельзя, поэтому вызывающий сам решает, что делать с зависшей вкладкой.
 */
export function withDeadline(promise, ms) {
  if (!ms) return promise;
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`не уложилось в ${ms} мс`), { code: 'timeout' })), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Очередь к редактору с потолком: запрос сверх max получает отказ сразу, а не висит за
 * чужими до тайм-аута клиента. Статус канала при этом не портится — редактор исправен, он
 * занят. В режиме auto снимок на отказ уходит в REST, как и на любую другую ошибку канала.
 */
export async function admitted(job, { max = FIGMA.editorQueueMax, run = exclusive } = {}) {
  if (max && pending >= max) {
    throw new EditorUnavailable(
      `Канал редактора занят: в очереди ${pending} операций. Повторите позже или вызывайте инструменты Figma по одному, а не пачкой параллельно.`,
      'busy',
    );
  }
  pending += 1;
  try {
    return await run(job);
  } finally {
    pending -= 1;
  }
}

/**
 * Операция с файлом в редакторе.
 *
 * Зависшую операцию Plugin API оборвать нельзя, поэтому по FIGMA.editorJobMs закрывается вся
 * вкладка: следующая операция откроет файл заново, а не встанет за мёртвой.
 */
async function inFile(fileKey, fn, arg) {
  return admitted(async () => {
    const page = await openFile(fileKey);
    scheduleIdle();
    try {
      return JSON.parse(await withDeadline(page.evaluate(fn, arg), FIGMA.editorJobMs));
    } catch (err) {
      if (err instanceof EditorUnavailable) throw err;
      if (err.code === 'timeout') {
        await closeEditor('timeout');
        throw failFile(
          fileKey,
          'error',
          `Plugin API в редакторе не ответил за ${Math.round(FIGMA.editorJobMs / 1000)} с: вкладка закрыта, следующий вызов откроет файл заново.`,
        );
      }
      throw failFile(fileKey, 'error', `Plugin API в редакторе отказал: ${err.message}`);
    }
  });
}

export const editorDump = (fileKey, ids, { css = false } = {}) => withCopy(fileKey, () => inFile(fileKey, DUMP, { ids, withCss: css }));
export const editorRender = (fileKey, items) => withCopy(fileKey, () => inFile(fileKey, RENDER, items));
export const editorGeometry = (fileKey, ids) => withCopy(fileKey, () => inFile(fileKey, GEOMETRY, ids));
export const editorImages = (fileKey, refs) => withCopy(fileKey, () => inFile(fileKey, IMAGES, refs));
export const editorPages = (fileKey) => withCopy(fileKey, () => inFile(fileKey, PAGES, null));
export const editorFind = (fileKey, { query, limit = 30 }) => withCopy(fileKey, () => inFile(fileKey, FIND, { query, limit }));

/*
 * Канал ui: значения с панели свойств, когда Plugin API нет (файл на просмотр, копии нет).
 *
 * Узел выбирается адресом с node-id, дети — клавишей Enter (Figma выделяет детей выбранного) и
 * чтением выделенных строк Layers: дерево там — ARIA treegrid, id узла стоит в data-testid строки,
 * aria-expanded говорит, есть ли у узла дети. Следующий узел выбирается кликом по его строке:
 * перезагрузка файла стоит 10–20 с, клик — доли секунды.
 */

/** Ждать, пока панель покажет выбранный узел — а не страницу, не мультивыбор и не пустоту. */
async function waitPanel(page, name = null, timeout = 45_000) {
  await page.waitForFunction(
    (wanted) => {
      const panel = document.querySelector('[data-testid=properties-panel]');
      if (!panel) return false;
      const lines = panel.innerText.split('\n').map((line) => line.trim()).filter(Boolean);
      const zoom = lines.findIndex((line) => /^\d+%$/.test(line));
      const head = zoom < 0 ? [] : lines.slice(zoom + 1, zoom + 3);
      if (!head.length || head[0] === 'Page' || /^\d+ Selected$/.test(head[0])) return false;
      return wanted ? head.includes(wanted) : true;
    },
    name,
    { timeout, polling: 250 },
  );
}

/** Выделенные строки Layers: { id, name, parent } — после Enter это дети выбранного узла. */
const SELECTED_ROWS = () =>
  [...document.querySelectorAll('[role=row][aria-selected=true]')]
    .map((row) => {
      const cell = row.querySelector('[data-testid$="-layers-panel-row"]');
      if (!cell) return null;
      return {
        id: cell.getAttribute('data-testid').replace(/-layers-panel-row$/, ''),
        name: cell.innerText.replace(/\n/g, ' ').trim(),
        parent: row.hasAttribute('aria-expanded'),
      };
    })
    .filter(Boolean);

async function openUi(page, fileKey, nodeId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(`${fileUrl(fileKey)}?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const outcome = await fileOutcome(page);
    if ((outcome === 'login' || outcome === 'anonymous') && attempt === 0) {
      await login(page);
      continue;
    }
    if (outcome === 'ready') {
      throw new EditorUnavailable(`Файл ${fileKey} открыт аккаунту на редактирование: канал ui не нужен — channel: "auto" снимет узел через Plugin API.`, 'ready');
    }
    if (outcome !== 'view') throw new EditorUnavailable(`Файл ${fileKey} не открылся в интерфейсе Figma (${outcome}).`);
    break;
  }
  try {
    await waitPanel(page);
  } catch {
    throw new EditorUnavailable(`Панель свойств Figma не показала узел ${nodeId}: id неверный, узел скрыт или интерфейс Figma изменился.`);
  }
}

/** Выбрать узел кликом по строке Layers; строки нет в списке — открыть файл на узле заново. */
async function selectUi(page, fileKey, item) {
  const row = page.locator(`[data-testid="${item.id}-layers-panel-row"]`).first();
  if (await row.count()) {
    await row.click({ timeout: 5000 }).catch(() => {});
    try {
      await page.waitForFunction(
        (id) => {
          const selected = [...document.querySelectorAll('[role=row][aria-selected=true] [data-testid$="-layers-panel-row"]')];
          return selected.length === 1 && selected[0].getAttribute('data-testid') === `${id}-layers-panel-row`;
        },
        item.id,
        { timeout: 5000, polling: 100 },
      );
      await waitPanel(page, item.name, 10_000);
      return;
    } catch {
      /* Клик не выбрал строку — ниже открываем по адресу. */
    }
  }
  await openUi(page, fileKey, item.id);
}

/**
 * Узел и, с depth, его потомки с панели свойств: [{ id, depth, parent, snapshot }]. Сырые
 * снимки разбирает src/figma/ui.js — здесь только браузер.
 */
export function editorUiInspect(fileKey, nodeId, { depth = 0, maxNodes = 25 } = {}) {
  return admitted(async () => {
    if (FIGMA.editor === 'off') throw new EditorUnavailable('Канал редактора выключен: FIGMA_EDITOR=off.', 'off');
    await ensureSession();
    const page = current.session.page;
    current.fileKey = null;
    scheduleIdle();
    await openUi(page, fileKey, nodeId);

    const out = [{ id: nodeId, depth: 0, parent: null, snapshot: await page.evaluate(PANEL_SNAPSHOT) }];
    const queue = [{ id: nodeId, name: null, depth: 0 }];
    let truncated = false;
    while (queue.length && depth > 0) {
      const item = queue.shift();
      if (item.depth >= depth) continue;
      if (item.name) await selectUi(page, fileKey, item);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const kids = (await page.evaluate(SELECTED_ROWS)).filter((kid) => kid.id !== item.id);
      if (!kids.length) continue;
      for (const kid of kids) {
        if (out.length >= maxNodes) {
          truncated = true;
          break;
        }
        await selectUi(page, fileKey, kid);
        out.push({ id: kid.id, name: kid.name, depth: item.depth + 1, parent: item.id, snapshot: await page.evaluate(PANEL_SNAPSHOT) });
        if (kid.parent) queue.push({ ...kid, depth: item.depth + 1 });
      }
      if (truncated) break;
    }
    scheduleIdle();
    return { nodes: out, truncated };
  });
}

/**
 * Выгрузка узла кнопкой Export панели в режиме просмотра. Figma рисует файл несколько секунд и
 * отдаёт его ссылкой на blob — его ловит перехват скачиваний сессии (browser/downloads.js).
 */
export function editorUiExport(fileKey, nodeId, { scale = 1, format = 'PNG' } = {}) {
  return admitted(async () => {
    if (FIGMA.editor === 'off') throw new EditorUnavailable('Канал редактора выключен: FIGMA_EDITOR=off.', 'off');
    await ensureSession();
    const page = current.session.page;
    current.fileKey = null;
    await openUi(page, fileKey, nodeId);
    const panel = page.locator('[data-testid=properties-panel]');
    const add = panel.locator('[aria-label="Add export settings"]');
    if (!(await panel.getByRole('button', { name: /^Export\s+\S/ }).count()) && (await add.count())) await add.first().click({ timeout: 5000 });

    const scaleInput = panel.locator('input[aria-label^="Export constraints"]').first();
    await scaleInput.waitFor({ timeout: 10_000 });
    await scaleInput.fill(`${scale}x`);
    await scaleInput.press('Enter');
    const type = panel.locator('[role=combobox][data-tooltip="Export file type"]').first();
    if ((await type.count()) && (await type.innerText()).trim().toUpperCase() !== format) {
      await type.click({ timeout: 5000 });
      await page.locator(`[role=option][data-fpl-select-value="${format}"]`).first().click({ timeout: 5000 });
    }

    const button = panel.getByRole('button', { name: /^Export\s+\S/ }).first();
    if (!(await button.count())) throw new EditorUnavailable('В панели нет кнопки Export: владелец запретил экспорт зрителям или интерфейс Figma изменился.');
    await button.click({ timeout: 10_000 });
    const file = await waitForDownload(current.session, 120_000).catch((err) => {
      throw new EditorUnavailable(`Figma не отдала файл экспорта: ${err.message}`);
    });
    scheduleIdle();
    return file;
  });
}

/*
 * Копия файла в черновики аккаунта стенда.
 *
 * Путь проверен на живом интерфейсе 2026-10-29: кнопка меню рядом с именем файла (aria-label
 * «Edit file menu») → пункт «Duplicate to your drafts» → диалог «Where do you want your
 * duplicate?» со списком команд аккаунта. Новая вкладка с копией стенду не видна, зато ключ
 * копии приходит в ответе POST /api/multiplayer/<ключ>/copy (meta.key). id узлов в копии те же,
 * что в оригинале: ссылки и снимки остаются под ключом оригинала.
 *
 * Команду выбирает человек: копия появляется в черновиках этой команды и видна её участникам.
 * Без team вызов отказывает со списком команд, а не берёт первую попавшуюся.
 */
const COPY_DIALOG = /where do you want your duplicate/i;

export function editorDuplicate(fileKey, { team = null, sourceVersion = null, choose = null } = {}) {
  return admitted(async () => {
    if (FIGMA.editor === 'off') throw new EditorUnavailable('Канал редактора выключен: FIGMA_EDITOR=off.', 'off');
    await ensureSession();
    const page = current.session.page;
    current.fileKey = null;

    let outcome = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.goto(fileUrl(fileKey), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      outcome = await fileOutcome(page);
      if ((outcome === 'login' || outcome === 'anonymous') && attempt === 0) {
        await login(page);
        continue;
      }
      break;
    }
    if (outcome === 'ready') {
      current.fileKey = fileKey;
      setFile(fileKey, 'ready');
      return { needed: false, note: `Файл ${fileKey} и так открыт аккаунту стенда на редактирование: копия не нужна.` };
    }
    if (outcome === 'no-access') throw failFile(fileKey, 'no_access', `Аккаунту стенда не открыт файл ${fileKey}: копию сделать не из чего.`);
    if (outcome !== 'view') throw new EditorUnavailable(`Файл ${fileKey} не открылся в редакторе (${outcome}): копию сделать не из чего.`);

    await page.locator('button[aria-label="Edit file menu"]').filter({ visible: true }).first().click({ timeout: 15_000 });
    /* Подстрокой, а не /^…$/: hasText сверяется с textContent, а в нём у пункта меню есть и
       невидимый текст — точная регулярка не находила пункт, который на экране есть. */
    const menu = page.locator('[role="menuitem"]');
    const opened = await menu.first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!opened) throw new EditorUnavailable(`Меню файла ${fileKey} в редакторе не открылось: интерфейс Figma изменился.`);
    const item = menu.filter({ hasText: 'Duplicate to your drafts' }).first();
    const present = (await item.count()) > 0;
    if (!present || (await item.getAttribute('aria-disabled')) === 'true') {
      await page.keyboard.press('Escape').catch(() => {});
      throw new EditorUnavailable(
        `Владелец файла ${fileKey} запретил копирование: пункта «Duplicate to your drafts» нет или он неактивен. Остаётся edit-доступ от владельца или канал ui: figma_inspect и figma_export с channel: "ui".`,
        'copy_forbidden',
      );
    }

    const copied = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes(`/api/multiplayer/${fileKey}/copy`),
      { timeout: 90_000 },
    );
    copied.catch(() => {});
    await item.click();

    const dialog = page.locator('[role="dialog"]', { hasText: COPY_DIALOG }).last();
    if (await dialog.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
      /* Имя команды бывает и «1»: подстрочный поиск по тексту кнопки попал бы не туда, поэтому
         кнопка берётся по номеру среди всех кнопок диалога. */
      const rows = (await dialog.locator('button').allInnerTexts()).map((text, at) => ({ name: text.trim(), at }));
      const named = rows.filter((row) => row.name && !/^cancel$/i.test(row.name));
      const teams = named.map((row) => row.name);
      /* Неявная копия: команду называет FIGMA_DUPLICATE_TEAM или человек в форме, пока диалог
         Figma открыт. Отказ человека — не ошибка интерфейса, а решение: так и говорится. */
      let refusal = null;
      if (!team && choose) {
        const picked = await choose(teams);
        if (typeof picked === 'string') team = picked;
        else refusal = picked?.declined ?? null;
      }
      const wanted = String(team || '').trim().toLowerCase();
      const chosen = wanted ? named.find((row) => row.name.toLowerCase() === wanted) : null;
      if (!chosen) {
        await page.keyboard.press('Escape').catch(() => {});
        throw Object.assign(
          new EditorUnavailable(
            refusal
              ? refusal
              : `${team ? `Команды «${team}» у аккаунта стенда нет.` : 'Нужна команда: копия появится в её черновиках, и это решает человек.'} ` +
                  `Команды аккаунта: ${teams.join(', ')}. Повторите figma_sync с duplicate: "<имя команды>".`,
            'needs_team',
          ),
          { teams },
        );
      }
      await dialog.locator('button').nth(chosen.at).click({ timeout: 5000 });
    }

    let meta;
    try {
      meta = (await (await copied).json())?.meta;
    } catch (err) {
      throw new EditorUnavailable(`Figma не подтвердила копию файла ${fileKey}: ${err.message}`);
    }
    if (!meta?.key) throw new EditorUnavailable(`Figma не вернула ключ копии файла ${fileKey}: интерфейс копирования изменился.`);

    const copy = {
      copyKey: meta.key,
      name: meta.name ?? null,
      ...(team ? { team } : {}),
      at: new Date().toISOString(),
      ...(sourceVersion ? { sourceVersion: String(sourceVersion) } : {}),
    };
    await writeCopy(fileKey, copy);
    files.delete(fileKey);
    scheduleIdle();
    return { needed: true, copy };
  });
}

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
    closeHandoff(HANDOFF, 'closed');
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
  why: editorWhy,
  fileStatus: editorFileStatus,
  duplicate: editorDuplicate,
  uiInspect: editorUiInspect,
  uiExport: editorUiExport,
  dump: editorDump,
  render: editorRender,
  geometry: editorGeometry,
  images: editorImages,
  pages: editorPages,
  find: editorFind,
};
