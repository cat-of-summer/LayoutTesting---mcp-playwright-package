/**
 * Именованные профили условий просмотра.
 *
 * Зачем они есть. Полный набор условий — девятнадцать параметров — объявлялся в шести
 * инструментах сразу: browser_open, audit, web_vitals, seo_page, page_save, storybook_audit.
 * Один и тот же блок занимал 12 918 символов манифеста, то есть около четверти всего, что
 * агент вычитывает при подключении, ещё не сделав ни одного вызова.
 *
 * Убирать условия было нельзя — это ядро стенда. Поэтому они объявлены там, где им и место:
 * в browser_open, который сессию и открывает. Остальные инструменты берут три самых частых
 * параметра прямо (browser, viewport, colorScheme — «на мобиле», «в тёмной теме») плюс имя
 * профиля для всего прочего.
 *
 * Профиль снимается с живой сессии, а не описывается заново: тогда ему не нужна своя схема
 * условий, и он стоит полторы сотни символов вместо двух тысяч. Заодно это честный порядок
 * работы — открыл с условиями, убедился, что отрисовалось как надо, закрепил именем.
 *
 * Хранение. По умолчанию в памяти процесса: профиль нужен в пределах работы агента, и
 * переживать перезапуск ему незачем. persist: true записывает его в state/profiles.json —
 * для условий, которые набирают руками один раз и потом используют месяцами (стенд за vhost,
 * медленная сеть).
 *
 * Секретов здесь нет. auth и заголовки в профиль не попадают: файл лежит в томе и читается
 * глазами, а пароль в таком файле — пароль в резервной копии. Логин переносят storageState,
 * и вот его имя профиль хранит спокойно.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../constants.js';

const FILE = path.join(DIRS.state, 'profiles.json');

/** Поля, которые в профиль не пишем ни при каких условиях. */
const SECRET_FIELDS = new Set(['auth', 'httpCredentials', 'extraHTTPHeaders']);

/** name -> набор условий. Профили из файла и профили этого процесса лежат вместе. */
const saved = new Map();
const persisted = new Set();

export function stripSecrets(args = {}) {
  const clean = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (SECRET_FIELDS.has(key)) {
      dropped += 1;
      continue;
    }
    clean[key] = value;
  }
  return { clean, dropped };
}

export async function loadProfiles() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    for (const [name, args] of Object.entries(data)) {
      saved.set(name, args);
      persisted.add(name);
    }
  } catch {
    /* Нет файла — нет сохранённых профилей. Это не ошибка. */
  }
}

async function flush() {
  const data = Object.fromEntries([...persisted].map((name) => [name, saved.get(name)]).filter(([, v]) => v));
  await fs.mkdir(DIRS.state, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 2), 'utf8');
}

export async function saveProfile(name, args, { persist = false } = {}) {
  const key = String(name || '').trim();
  if (!key) throw new Error('Профилю нужно имя.');
  const { clean, dropped } = stripSecrets(args);
  if (!Object.keys(clean).length) {
    throw new Error(`Сессия открыта с условиями по умолчанию — сохранять в профиль нечего.`);
  }
  saved.set(key, clean);
  if (persist) {
    persisted.add(key);
    await flush();
  }
  return { name: key, conditions: clean, persisted: persisted.has(key), secretsDropped: dropped };
}

/**
 * Профиль на один вызов — для слоя совместимости.
 *
 * Секреты здесь сохраняются, в отличие от именованных профилей: этот на диск не попадает и
 * в списке не показывается, а без auth старый вызов молча получил бы 401. Держим последние
 * несколько десятков: имя нужно ровно до конца того вызова, который его завёл.
 */
const EPHEMERAL_KEEP = 32;
const ephemeral = [];

export function saveEphemeralProfile(args) {
  const name = `__inline_${Math.random().toString(36).slice(2, 10)}`;
  saved.set(name, { ...args });
  ephemeral.push(name);
  while (ephemeral.length > EPHEMERAL_KEEP) saved.delete(ephemeral.shift());
  return name;
}
export function getProfile(name) {
  return saved.get(String(name || '').trim()) || null;
}

export function listProfiles() {
  return [...saved.keys()]
    .filter((name) => !name.startsWith('__inline_'))
    .sort()
    .map((name) => ({
    name,
    conditions: saved.get(name),
    persisted: persisted.has(name),
  }));
}

export async function removeProfile(name) {
  const key = String(name || '').trim();
  const had = saved.delete(key);
  if (persisted.delete(key)) await flush();
  return had;
}

/**
 * Разрешить условия вызова: профиль как основа, явные параметры поверх.
 *
 * Явное всегда сильнее: profile: "mobile-dark" вместе с colorScheme: "light" означает
 * «как в mobile-dark, но светлую» — иначе профиль было бы нельзя уточнить, не завидя новый.
 */
export function resolveConditions({ profile, ...explicit } = {}) {
  if (!profile) return explicit;
  const base = getProfile(profile);
  if (!base) {
    const known = listProfiles().map((p) => p.name);
    throw new Error(
      `Профиль ${profile} не найден. ${known.length ? `Есть: ${known.join(', ')}.` : 'Сохранённых профилей нет.'} ` +
        'Профиль снимают с открытой сессии: browser_open с нужными условиями, затем profile_save.',
    );
  }
  return { ...base, ...explicit };
}
