/**
 * Секреты Figma: откуда берутся и как не утекают.
 *
 * Агент не должен знать ни токена, ни пароля — и не должен в них нуждаться. Поэтому секреты
 * читаются только здесь, прямо из окружения и из state/figma/, а наружу уходят лишь признаки:
 * задан ли токен, откуда он, когда истекает. Любой текст ошибки перед отдачей проходит через
 * redact: Figma любит повторять в ответе то, что ей прислали.
 *
 * Порядок источников токена: FIGMA_TOKEN из окружения — его задал человек, и он сильнее всего;
 * затем токен, который стенд выпустил сам через настройки аккаунта. Выпуск происходит только
 * тогда, когда запрос к REST действительно нужен (resolveToken с issue: true), а не при проверке
 * «есть ли токен»: иначе стенд выпускал бы токены в чужом аккаунте просто потому, что его спросили.
 *
 * state/ закрыт для read_project_file и browser_route (DENIED_DIRS в paths.js), поэтому
 * выпущенный токен лежит там же, где сохранённые логины сессий.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS, FIGMA } from '../constants.js';
import { TOKEN_SCOPES } from './api.js';

export const FIGMA_STATE = path.join(DIRS.state, 'figma');
export const TOKEN_FILE = path.join(FIGMA_STATE, 'token.json');

/** Перевыпуск заранее: токен, истекающий посреди разбора, хуже токена, перевыпущенного вчера. */
const RENEW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;

/** Последний прочитанный выпущенный токен — чтобы redact знал и его. */
let issuedToken = null;
/** Кто умеет выпустить токен. Регистрирует канал редактора: без входа в аккаунт выпускать нечем. */
let issuer = null;
let lastIssue = null;

export function registerTokenIssuer(fn) {
  issuer = fn;
}

export const lastTokenIssue = () => lastIssue;

export async function readIssuedToken({ file = TOKEN_FILE } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!data?.token) return null;
    issuedToken = data.token;
    return data;
  } catch {
    return null;
  }
}

export async function writeIssuedToken(data, { file = TOKEN_FILE } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  issuedToken = data.token;
}

async function issue(previous, file, now) {
  const stamp = new Date(now).toISOString();
  if (!issuer) {
    lastIssue = { at: stamp, ok: false, error: 'Выпускать токен нечем: канал редактора не подключён.' };
    return null;
  }
  try {
    const fresh = await issuer({ previous });
    if (!fresh?.token) throw new Error('выпуск не вернул токен');
    await writeIssuedToken(fresh, { file });
    lastIssue = {
      at: stamp,
      ok: true,
      expiresAt: fresh.expiresAt,
      ...(fresh.previousRevoked ? { previousRevoked: fresh.previousRevoked } : {}),
    };
    return fresh;
  } catch (err) {
    lastIssue = { at: stamp, ok: false, error: redact(err.message) };
    return null;
  }
}

/**
 * Каких прав не хватает выпущенному токену. Инструменту понадобился новый эндпоинт (история
 * версий — file_versions:read), а токен выпущен раньше: такой перевыпускается при первом же
 * запросе, как и истекающий. Токен без списка прав выпущен не стендом — о нём судить не берёмся.
 */
export function missingScopes(saved, scopes = TOKEN_SCOPES) {
  if (!Array.isArray(saved?.scopes)) return [];
  return scopes.filter((scope) => !saved.scopes.includes(scope));
}

export async function resolveToken({
  issue: allowIssue = false,
  file = TOKEN_FILE,
  now = Date.now(),
  autoIssue = FIGMA.autoIssueToken,
  scopes = TOKEN_SCOPES,
} = {}) {
  const env = process.env.FIGMA_TOKEN?.trim();
  if (env) return { token: env, source: 'env' };

  const saved = await readIssuedToken({ file });
  const left = saved?.expiresAt ? Date.parse(saved.expiresAt) - now : Infinity;
  const valid = Boolean(saved) && left > 0;
  const lacking = valid ? missingScopes(saved, scopes) : [];

  if (allowIssue && autoIssue && (!valid || left < RENEW_BEFORE_MS || lacking.length)) {
    const fresh = await issue(saved, file, now);
    if (fresh) return { token: fresh.token, source: 'issued', expiresAt: fresh.expiresAt, issuedNow: true };
  }
  if (valid) {
    return {
      token: saved.token,
      source: 'issued',
      ...(saved.expiresAt ? { expiresAt: saved.expiresAt } : {}),
      ...(lacking.length ? { missingScopes: lacking } : {}),
    };
  }
  return { token: null, source: null };
}

/** Выпустить токен прямо сейчас — по явной просьбе, а не по нужде запроса. */
export async function issueTokenNow({ file = TOKEN_FILE, now = Date.now() } = {}) {
  if (process.env.FIGMA_TOKEN?.trim()) {
    throw new Error('FIGMA_TOKEN задан в окружении и сильнее выпущенного: выпуск ничего не изменит.');
  }
  const fresh = await issue(await readIssuedToken({ file }), file, now);
  if (!fresh) throw new Error(lastIssue?.error || 'Токен не выпущен.');
  return { source: 'issued', expiresAt: fresh.expiresAt };
}

export function loginConfigured() {
  return Boolean(process.env.FIGMA_EMAIL?.trim() && process.env.FIGMA_PASSWORD);
}

export function redact(value) {
  let out = String(value ?? '');
  const secrets = [
    process.env.FIGMA_TOKEN?.trim(),
    process.env.FIGMA_PASSWORD,
    process.env.FIGMA_EMAIL?.trim(),
    issuedToken,
  ];
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  /* Токен, которого стенд ещё не видел, узнаётся по префиксу. */
  return out.replace(/figd_[A-Za-z0-9_-]{8,}/g, 'figd_***');
}
