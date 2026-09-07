/**
 * Куки и хранилища страницы: прочитать, подложить, сохранить между сессиями.
 *
 * До этого их не было вовсе. Внутри сессии куки работали сами собой — это обычный контекст
 * Chromium, — но прочитать их было нечем, подложить нечем, а browser_close уносил вместе с
 * контекстом и логин. Единственной аутентификацией оставался HTTP basic.
 *
 * Три разных механизма, которые важно не перепутать:
 *
 *   - куки живут на контексте: context.cookies() и context.addCookies() видят все домены сразу;
 *   - localStorage и sessionStorage API уровня контекста в Playwright не имеют вовсе — только
 *     page.evaluate, то есть в области origin текущей страницы;
 *   - context.storageState() отдаёт куки и localStorage по посещённым origin, а sessionStorage
 *     не отдаёт в принципе.
 *
 * Отсюда честная граница: get и export для local и session работают по текущей странице, а не по
 * всему сайту. Молча выдавать часть за целое здесь нельзя — на этом строят выводы о логине.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../config.js';
import { slug } from '../artifacts.js';

/**
 * Единственное место, которому положено ходить в state/.
 *
 * Каталог закрыт для read_project_file и browser_route через DENIED_DIRS в paths.js — именно
 * потому, что здесь лежат живые куки. Своя проверка тут не послабление, а та же граница:
 * имя схлопывается до одного сегмента, выйти за каталог им нельзя.
 */
export function statePath(name) {
  const file = slug(name);
  if (!file) throw new Error('Нужно имя файла состояния.');
  const abs = path.join(DIRS.state, `${file}.json`);
  if (path.dirname(abs) !== DIRS.state) {
    throw new Error(`Недопустимое имя состояния: ${name}.`);
  }
  return abs;
}

export async function listStates() {
  await fs.mkdir(DIRS.state, { recursive: true });
  const entries = await fs.readdir(DIRS.state, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .sort();
}

/** Снимок состояния на диск. Возвращает счётчики, а не сам файл: в нём куки. */
export async function exportState(session, name) {
  const state = await session.context.storageState();
  const abs = statePath(name);
  await fs.mkdir(DIRS.state, { recursive: true });
  await fs.writeFile(abs, JSON.stringify(state, null, 2), 'utf8');
  return {
    name: slug(name),
    cookies: state.cookies.length,
    origins: state.origins.length,
    note: 'sessionStorage в storageState не входит — Playwright его не сохраняет.',
  };
}

export async function loadState(name) {
  const raw = await fs.readFile(statePath(name), 'utf8').catch((err) => {
    if (err.code === 'ENOENT') throw new Error(`Состояние ${slug(name)} не найдено. Есть: ${DIRS.state}`);
    throw err;
  });
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Состояние ${slug(name)} повреждено: ${err.message}`);
  }
}

/**
 * Влить состояние в живую сессию.
 *
 * Playwright умеет storageState только при создании контекста, поэтому в уже открытую сессию
 * куки заливаются вручную, а localStorage — по одному origin. Ради этого приходится переходить
 * на каждый origin: localStorage пишется только из его собственной страницы.
 */
export async function importState(session, name) {
  const state = await loadState(name);
  await session.context.addCookies(state.cookies || []);

  const wasAt = session.page.url();
  let originsApplied = 0;
  for (const origin of state.origins || []) {
    if (!origin.localStorage?.length) continue;
    try {
      await session.page.goto(origin.origin, { waitUntil: 'domcontentloaded' });
      await session.page.evaluate((items) => {
        for (const item of items) window.localStorage.setItem(item.name, item.value);
      }, origin.localStorage);
      originsApplied += 1;
    } catch {
      // Недоступный origin не повод терять уже залитые куки: сообщаем счётчиком.
    }
  }

  // Возвращаем сессию туда, где она была: иначе импорт молча уводит агента на чужую страницу.
  if (wasAt && wasAt !== 'about:blank') await session.page.goto(wasAt).catch(() => {});

  return {
    name: slug(name),
    cookies: (state.cookies || []).length,
    originsApplied,
    originsTotal: (state.origins || []).length,
  };
}

const webStorage = (session, scope, action, payload) =>
  session.page.evaluate(
    ([which, act, data]) => {
      const store = which === 'session' ? window.sessionStorage : window.localStorage;
      if (act === 'clear') {
        const n = store.length;
        store.clear();
        return { cleared: n };
      }
      if (act === 'set') {
        store.setItem(data.name, data.value);
        return { set: data.name };
      }
      const out = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        out[key] = store.getItem(key);
      }
      return out;
    },
    [scope, action, payload],
  );

export async function getStorage(session, scope) {
  const out = {};
  if (scope === 'cookies' || scope === 'all') out.cookies = await session.context.cookies();
  if (scope === 'local' || scope === 'all') out.localStorage = await webStorage(session, 'local', 'get');
  if (scope === 'session' || scope === 'all') out.sessionStorage = await webStorage(session, 'session', 'get');
  if (scope !== 'cookies') {
    out.scopeNote = `localStorage и sessionStorage сняты с текущей страницы (${session.page.url()}), а не со всего сайта.`;
  }
  return out;
}

export async function setStorage(session, scope, name, value) {
  if (scope === 'cookies') {
    // Кука без домена и пути молча не применится — достраиваем из текущего адреса.
    const parsed = JSON.parse(value);
    const cookies = [].concat(parsed).map((c) => (c.domain || c.url ? c : { ...c, url: session.page.url() }));
    await session.context.addCookies(cookies);
    return { added: cookies.length };
  }
  if (!name) throw new Error('Для local и session нужен name.');
  return webStorage(session, scope, 'set', { name, value: String(value ?? '') });
}

export async function clearStorage(session, scope) {
  const out = {};
  if (scope === 'cookies' || scope === 'all') {
    await session.context.clearCookies();
    out.cookies = 'очищены';
  }
  if (scope === 'local' || scope === 'all') out.localStorage = await webStorage(session, 'local', 'clear');
  if (scope === 'session' || scope === 'all') out.sessionStorage = await webStorage(session, 'session', 'clear');
  return out;
}
