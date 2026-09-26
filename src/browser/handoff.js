/**
 * Передача браузера стенда человеку: капча, код, подтверждение входа.
 *
 * Браузер стенда живёт в контейнере без экрана, и то, что Figma просит «доказать, что вы человек»,
 * пройти в нём может только человек. Агент тут не помощник и не должен им быть: решать капчу за
 * человека — ровно то, от чего она защищает. Задача стенда — довести проверку до человека без
 * возни с VNC и выгрузкой кук.
 *
 * Поэтому стенд открывает одноразовую страницу /handoff/<токен>: на ней живой снимок вкладки,
 * клики, перетаскивание, прокрутка и ввод с клавиатуры уходят в неё же. Агент получает адрес в
 * ответе инструмента и передаёт его человеку; стенд сам замечает, что проверка пройдена
 * (isDone), доводит дело (onDone) и закрывает страницу.
 *
 * Границы. Страница даёт управление вкладкой, в которой выполнен вход в чужой аккаунт, поэтому:
 * токен в адресе случайный и живёт только пока проверка открыта (и не дольше ttl); после
 * завершения адрес отвечает «готово» и больше ничего не принимает; переход по адресу разрешён
 * только на домены из allowHosts — нужен, чтобы открыть ссылку подтверждения из письма в браузере
 * стенда, а не в своём.
 */
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';

const TTL_MS = 15 * 60 * 1000;
/* Закрытая передача ещё какое-то время отвечает «готово»: человек обновит страницу и увидит итог. */
const KEEP_CLOSED_MS = 10 * 60 * 1000;
const WATCH_MS = 1500;
const MAX_BODY = 8 * 1024;
const KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Space',
]);

/** token -> передача. Одна открытая на purpose: вторая проверка того же входа заменяет первую. */
const handoffs = new Map();

const publicState = (item) => ({
  purpose: item.purpose,
  state: item.state,
  url: `${CONFIG.publicBaseUrl}/handoff/${item.token}`,
  reason: item.reason,
  openedAt: new Date(item.openedAt).toISOString(),
  expiresAt: new Date(item.expiresAt).toISOString(),
  ...(item.closedAt ? { closedAt: new Date(item.closedAt).toISOString() } : {}),
  ...(item.error ? { error: item.error } : {}),
});

function finish(item, state, error = null) {
  if (item.state !== 'open') return;
  item.state = state;
  item.closedAt = Date.now();
  if (error) item.error = String(error).slice(0, 300);
  clearInterval(item.watcher);
  clearTimeout(item.expiry);
  const drop = setTimeout(() => handoffs.delete(item.token), KEEP_CLOSED_MS);
  drop.unref?.();
}

/**
 * Открыть передачу. page — вкладка Playwright; isDone(page) — пройдена ли проверка;
 * onDone(page) — что сделать после (сохранить вход, сменить статус канала).
 */
export function openHandoff({ page, purpose, reason = '', isDone, onDone = async () => {}, allowHosts = [], ttlMs = TTL_MS }) {
  closeHandoff(purpose, 'replaced');
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const item = { token, page, purpose, reason, allowHosts, state: 'open', openedAt: now, expiresAt: now + ttlMs, busy: false };
  item.watcher = setInterval(async () => {
    if (item.state !== 'open' || item.busy) return;
    if (page.isClosed()) return finish(item, 'closed', 'вкладка стенда закрыта');
    item.busy = true;
    try {
      if (await isDone(page)) {
        await onDone(page);
        finish(item, 'done');
      }
    } catch (err) {
      finish(item, 'failed', err.message);
    } finally {
      item.busy = false;
    }
  }, WATCH_MS);
  item.watcher.unref?.();
  item.expiry = setTimeout(() => finish(item, 'expired'), ttlMs);
  item.expiry.unref?.();
  handoffs.set(token, item);
  return publicState(item);
}

export function closeHandoff(purpose, state = 'closed') {
  for (const item of handoffs.values()) if (item.purpose === purpose) finish(item, state);
}

/** Последняя передача по назначению — открытая или только что закрытая. */
export function handoffStatus(purpose) {
  /* Map хранит порядок вставки: последняя найденная — самая свежая, даже открытая в ту же мс. */
  let last = null;
  for (const item of handoffs.values()) if (item.purpose === purpose) last = item;
  return last ? publicState(last) : null;
}

export const handoffOpen = (purpose) => handoffStatus(purpose)?.state === 'open';

/* ── HTTP ─────────────────────────────────────────────────────────────────────────────── */

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...extra });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('слишком большое тело запроса');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const num = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('координата должна быть числом');
  return n;
};

/** Одно действие человека во вкладке стенда. */
export async function applyInput(item, input) {
  const { page } = item;
  switch (input.type) {
    case 'click':
      await page.mouse.click(num(input.x), num(input.y));
      return;
    case 'drag':
      /* Ползунковые капчи: нажать, провести шагами, отпустить — одним рывком их не проходят. */
      await page.mouse.move(num(input.from.x), num(input.from.y));
      await page.mouse.down();
      await page.mouse.move(num(input.to.x), num(input.to.y), { steps: 25 });
      await page.mouse.up();
      return;
    case 'wheel':
      await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, num(input.dy))));
      return;
    case 'type':
      await page.keyboard.type(String(input.text ?? '').slice(0, 500), { delay: 20 });
      return;
    case 'key': {
      const key = input.key === ' ' ? 'Space' : String(input.key);
      if (!KEYS.has(key)) throw new Error(`клавиша ${key} не передаётся`);
      await page.keyboard.press(key);
      return;
    }
    case 'goto': {
      const target = new URL(String(input.url));
      const allowed = item.allowHosts.some((host) => target.hostname === host || target.hostname.endsWith(`.${host}`));
      if (target.protocol !== 'https:' || !allowed) {
        throw new Error(`переход разрешён только на https://${item.allowHosts.join(', ')}`);
      }
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    }
    default:
      throw new Error(`неизвестное действие ${input.type}`);
  }
}

/** /handoff/<токен>[/frame|/state|/input]. Возвращает false, если адрес не про передачу. */
export async function handleHandoffRoute(req, res, url) {
  const match = /^\/handoff\/([A-Za-z0-9_-]{20,})(?:\/(frame|state|input))?\/?$/.exec(url.pathname);
  if (!match) {
    send(res, 404, 'text/plain; charset=utf-8', 'Ссылка на проверку неполная или устарела.\n');
    return;
  }
  const item = handoffs.get(match[1]);
  const part = match[2] || 'page';
  if (!item) {
    send(res, 404, 'text/html; charset=utf-8', page404());
    return;
  }

  if (part === 'page') return send(res, 200, 'text/html; charset=utf-8', pageHtml(item));
  if (part === 'state') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(publicState(item)));

  if (item.state !== 'open') return send(res, 409, 'application/json; charset=utf-8', JSON.stringify(publicState(item)));

  if (part === 'frame') {
    try {
      const shot = await item.page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 });
      const size = item.page.viewportSize() || { width: 0, height: 0 };
      return send(res, 200, 'image/jpeg', shot, { 'X-Viewport': `${size.width}x${size.height}` });
    } catch (err) {
      return send(res, 503, 'text/plain; charset=utf-8', `Снимок вкладки не удался: ${err.message}\n`);
    }
  }

  if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Только POST.\n');
  try {
    await applyInput(item, await readBody(req));
    return send(res, 200, 'application/json; charset=utf-8', '{"ok":true}');
  } catch (err) {
    return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: err.message }));
  }
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function page404() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проверка недоступна</title><body style="font:16px/1.5 system-ui,sans-serif;margin:40px">
<p>Эта ссылка на проверку недействительна: она устарела или проверка уже пройдена. Попросите агента вызвать figma_status заново.</p>`;
}

function pageHtml(item) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Проверка входа</title>
<style>
  :root { --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --line: #d9d9d4; --accent: #0b64d8; --ok: #1a7f37; --bad: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #a0a09a; --line: #34342f; --accent: #5ea2ff; --ok: #4ac26b; --bad: #ff7b72; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  header { padding: 12px 16px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; }
  #status { color: var(--muted); }
  #status.ok { color: var(--ok); font-weight: 600; }
  #status.bad { color: var(--bad); font-weight: 600; }
  main { padding: 12px 16px; }
  .tools { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .tools input { flex: 1 1 220px; min-width: 0; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  button { padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  #screen { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); cursor: crosshair; outline: none; touch-action: none; }
  #screen:focus { border-color: var(--accent); }
  p.hint { color: var(--muted); margin: 0 0 10px; }
</style>
</head>
<body>
<header><h1>Проверка входа в браузере стенда</h1><span id="status">Подключаюсь…</span></header>
<main>
  <p class="hint">${escapeHtml(item.reason)} Кликайте прямо по снимку, для ползунков тяните мышью. Чтобы печатать, щёлкните по снимку и набирайте текст: клавиши уходят во вкладку стенда. Ссылку из письма вставьте в поле «Открыть адрес».</p>
  <div class="tools">
    <input id="text" placeholder="Текст или код — отправить разом" autocomplete="one-time-code">
    <button id="send">Отправить текст</button>
    <button data-key="Enter">Enter</button>
    <button data-key="Backspace">⌫</button>
    <button data-key="Tab">Tab</button>
  </div>
  <div class="tools">
    <input id="goto" placeholder="Открыть адрес во вкладке стенда (ссылка из письма Figma)">
    <button id="go">Открыть</button>
  </div>
  <img id="screen" tabindex="0" alt="Снимок вкладки стенда">
</main>
<script>
  const base = location.pathname.replace(/\\/$/, '');
  const img = document.getElementById('screen');
  const status = document.getElementById('status');
  let viewport = null, alive = true, dragFrom = null;

  const say = (text, cls = '') => { status.textContent = text; status.className = cls; };
  const post = async (body) => {
    const res = await fetch(base + '/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) say(data.error || data.state || 'Действие не прошло', 'bad');
    setTimeout(frame, 250);
  };
  const point = (event) => {
    const rect = img.getBoundingClientRect();
    const [w, h] = viewport || [img.naturalWidth, img.naturalHeight];
    return { x: Math.round((event.clientX - rect.left) * w / rect.width), y: Math.round((event.clientY - rect.top) * h / rect.height) };
  };

  async function frame() {
    if (!alive) return;
    try {
      const res = await fetch(base + '/frame', { cache: 'no-store' });
      if (res.status === 409 || res.status === 404) return state();
      if (!res.ok) return;
      const size = (res.headers.get('X-Viewport') || '').split('x').map(Number);
      if (size[0]) viewport = size;
      const url = URL.createObjectURL(await res.blob());
      img.onload = () => URL.revokeObjectURL(url);
      img.src = url;
    } catch {}
  }
  async function state() {
    try {
      const res = await fetch(base + '/state', { cache: 'no-store' });
      if (res.status === 404) { alive = false; return say('Ссылка устарела. Попросите агента открыть проверку заново.', 'bad'); }
      const data = await res.json();
      if (data.state === 'open') return say('Проверка открыта до ' + new Date(data.expiresAt).toLocaleTimeString());
      alive = false;
      if (data.state === 'done') say('Готово: вход выполнен и сохранён. Вкладку можно закрыть и вернуться к агенту.', 'ok');
      else say('Проверка закрыта (' + data.state + (data.error ? ': ' + data.error : '') + '). Скажите агенту.', 'bad');
    } catch {}
  }

  img.addEventListener('mousedown', (event) => { event.preventDefault(); img.focus(); dragFrom = point(event); });
  img.addEventListener('mouseup', (event) => {
    if (!dragFrom) return;
    const to = point(event);
    const moved = Math.hypot(to.x - dragFrom.x, to.y - dragFrom.y) > 4;
    post(moved ? { type: 'drag', from: dragFrom, to } : { type: 'click', x: to.x, y: to.y });
    dragFrom = null;
  });
  img.addEventListener('wheel', (event) => { event.preventDefault(); post({ type: 'wheel', dy: event.deltaY }); }, { passive: false });
  img.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (event.key.length === 1) post({ type: 'type', text: event.key });
    else post({ type: 'key', key: event.key });
  });
  img.addEventListener('paste', (event) => { event.preventDefault(); post({ type: 'type', text: event.clipboardData.getData('text') }); });
  document.getElementById('send').onclick = () => { const f = document.getElementById('text'); if (f.value) post({ type: 'type', text: f.value }); f.value = ''; };
  document.getElementById('go').onclick = () => { const f = document.getElementById('goto'); if (f.value) post({ type: 'goto', url: f.value.trim() }); };
  for (const button of document.querySelectorAll('[data-key]')) button.onclick = () => post({ type: 'key', key: button.dataset.key });

  frame(); state();
  setInterval(frame, 1000);
  setInterval(state, 2000);
</script>
</body>
</html>`;
}
