/**
 * Именованные скрипты browser_eval.
 *
 * Проверку для всех страниц агент держал в localStorage и вызывал eval(localStorage.__chk) после
 * каждого перехода, а в новой сессии (другая ширина — другая сессия) записывал заново. Скрипт,
 * сохранённый под именем, живёт на стенде: в state/scripts.json, между сессиями и перезапусками,
 * — и вызывается одним name.
 *
 * Хранится текст выражения как есть: тот же, что принял бы browser_eval. Секретов здесь быть не
 * должно — файл лежит в томе и читается глазами.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../constants.js';

const FILE = path.join(DIRS.state, 'scripts.json');

/** Предел одного скрипта: это проверка, а не бандл. */
export const MAX_SCRIPT_CHARS = 20000;

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = new Map(Object.entries(JSON.parse(await fs.readFile(FILE, 'utf8'))));
  } catch {
    /* Нет файла — нет сохранённых скриптов. Это не ошибка. */
    cache = new Map();
  }
  return cache;
}

async function flush() {
  await fs.mkdir(DIRS.state, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(Object.fromEntries(cache), null, 2), 'utf8');
}

const keyOf = (name) => {
  const key = String(name || '').trim();
  if (!/^[\w.-]{1,64}$/.test(key)) throw new Error(`Имя скрипта — латиница, цифры, точка, дефис и подчёркивание, до 64 символов: "${name}".`);
  return key;
};

export async function saveScript(name, expression) {
  const key = keyOf(name);
  if (!String(expression || '').trim()) throw new Error('Скрипту нужен expression.');
  if (expression.length > MAX_SCRIPT_CHARS) throw new Error(`Скрипт — ${expression.length} символов, предел ${MAX_SCRIPT_CHARS}.`);
  const scripts = await load();
  const replaced = scripts.has(key);
  scripts.set(key, { expression, savedAt: new Date().toISOString() });
  await flush();
  return { name: key, replaced };
}

export async function getScript(name) {
  const key = keyOf(name);
  const scripts = await load();
  const found = scripts.get(key);
  if (!found) {
    const known = [...scripts.keys()];
    throw new Error(`Скрипта "${key}" нет${known.length ? ` — есть: ${known.join(', ')}` : ''}. Сохранить: browser_eval с name и expression.`);
  }
  return found.expression;
}

export async function listScripts() {
  const scripts = await load();
  return [...scripts.entries()].map(([name, { expression, savedAt }]) => ({
    name,
    savedAt,
    chars: expression.length,
    preview: expression.length > 120 ? `${expression.slice(0, 120)}…` : expression,
  }));
}

export async function removeScript(name) {
  const key = keyOf(name);
  const scripts = await load();
  const removed = scripts.delete(key);
  if (removed) await flush();
  return { name: key, removed };
}

/** Для тестов: забыть прочитанное, чтобы следующий вызов перечитал файл. */
export function resetScripts() {
  cache = null;
}
