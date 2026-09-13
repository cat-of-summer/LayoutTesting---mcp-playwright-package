/**
 * Регламент вёрстки по макету: порядок работы, разложенный по фазам.
 *
 * Не путать с checks/guide.js — тот собирает визуальный справочник вариантов для человека.
 * Здесь — текст, который читает агент: что делать и в каком порядке, когда верстают по Figma.
 *
 * Почему markdown в каталоге, а не строки в коде. Правила разбора макета уже жили в четырёх
 * местах сразу — в instructions, в теме figma у help, в промпте figma-layout и в оговорках по
 * инструментам, — и все четыре были сокращёнными пересказами друг друга. Пятая копия сделала бы
 * хуже: расходиться они начинают на первой же правке, а читающий не знает, какой верить.
 * Поэтому текст лежит один раз файлами, а help, ресурс и промпт — три витрины одного и того же.
 *
 * Формат файла намеренно примитивен и обходится без парсера YAML: первая строка — «# Заголовок»,
 * третья — одна строка-аннотация, дальше тело. Аннотация идёт в перечни разделов и остаётся в
 * теле: разделу полезно начинаться с того, о чём он.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG } from './i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guide');

/**
 * Разделы в порядке работы, а не по алфавиту.
 *
 * Список явный, по образцу groups.js: фазы упорядочены по смыслу, и readdir перемешал бы их.
 * Заодно это единственный словарь разделов в проекте — файл на диске не из этого списка и слаг
 * из списка без файла одинаково валят тест, и разъехаться молча они не могут.
 */
export const ORDER = [
  'index',
  'setup',
  'frames',
  'inventory',
  'system',
  'assets',
  'fonts',
  'content',
  'questions',
  'motion',
  'shell',
  'block',
  'page',
  'project',
  'rules',
  'symptoms',
];

const cache = new Map();

/** Заголовок и аннотация — первая и третья строки. Всё остальное тело. */
function parse(text) {
  const lines = text.split('\n');
  const title = (lines[0] || '').replace(/^#\s*/, '').trim();
  const about = (lines.slice(1).find((line) => line.trim()) || '').trim();
  return { title, about };
}

async function load(slug) {
  const cached = cache.get(slug);
  if (cached) return cached;

  const read = async (lang) => {
    try {
      return await fs.readFile(path.join(ROOT, lang, `${slug}.md`), 'utf8');
    } catch {
      return null;
    }
  };

  let lang = LANG;
  let text = await read(LANG);
  let note = null;
  if (!text && LANG !== 'ru') {
    /* Честнее отдать русский и сказать об этом, чем промолчать пустым ответом. */
    text = await read('ru');
    lang = 'ru';
    note = `Английской версии раздела «${slug}» нет — отдан русский текст.`;
  }
  if (!text) throw new Error(`Раздел регламента «${slug}» не найден в ${ROOT}.`);

  const entry = { slug, lang, text, ...parse(text), ...(note ? { note } : {}) };
  cache.set(slug, entry);
  return entry;
}

/** Перечень разделов для витрин: чем открывается каждый и о чём он. */
export async function list() {
  return Promise.all(
    ORDER.map(async (slug) => {
      const entry = await load(slug);
      return { section: slug, title: entry.title, about: entry.about };
    }),
  );
}

/**
 * Один раздел.
 *
 * Слаг сверяется со списком, а не только чистится basename: список — это и проверка границы,
 * и ответ на опечатку. За пределы каталога отсюда не выйти ни при каком вводе.
 */
export async function read(slug) {
  const name = path.basename(String(slug || ''));
  if (!ORDER.includes(name)) return null;
  return load(name);
}
