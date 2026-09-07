/**
 * Язык описаний инструментов.
 *
 * Описания читает модель, а не человек, и читает она их на том языке, на котором к ней
 * обращаются. Русские описания на англоязычной задаче хуже находятся: совпадение идёт по смыслу,
 * но термины вроде «горизонтальный скролл» и «horizontal scroll» соседствуют в модели не так
 * плотно, как кажется.
 *
 * Автоопределение здесь ненадёжно по существу, и это надо признать честно: в контейнере обычно
 * LANG=C.UTF-8 или вовсе пусто, и оно не говорит ничего ни о языке пользователя, ни о языке
 * задачи. Поэтому порядок такой:
 *
 *   1. LT_LANG — явное указание, оно и главное;
 *   2. LANG / LC_ALL — работает на машине разработчика, в контейнере обычно бесполезно;
 *   3. русский по умолчанию — язык проекта и его документации.
 *
 * Переводить наизнанку (описание одного инструмента по-русски, другого по-английски) нельзя:
 * список инструментов читается целиком, и разнобой в нём сбивает выбор сильнее, чем неудачно
 * выбранный язык.
 */

const SUPPORTED = ['ru', 'en'];

export function detectLang(env = process.env) {
  const explicit = String(env.LT_LANG || '').trim().toLowerCase();
  if (SUPPORTED.includes(explicit)) return explicit;

  /*
   * Непонятное значение LT_LANG считаем незаданным и смотрим дальше на окружение. Уйти отсюда
   * сразу в русский было бы хуже: LT_LANG=de — это внятно выраженное «не по-русски», и молча
   * сделать наоборот значит поступить ровно против намерения.
   */
  const fromLocale = String(env.LC_ALL || env.LANG || '').trim().toLowerCase();
  if (/^ru/.test(fromLocale)) return 'ru';
  if (/^en/.test(fromLocale)) return 'en';

  return 'ru';
}

export const LANG = detectLang();

/**
 * Выбор строки по языку.
 *
 * Тексты живут рядом с инструментом, а не в отдельном словаре: словарь разъезжается с кодом
 * молча — правку описания вносят в одном месте, а второй язык остаётся с прежним смыслом, и
 * заметить это можно только сравнив построчно.
 */
export function t(variants, lang = LANG) {
  if (typeof variants === 'string') return variants;
  return variants[lang] ?? variants.ru ?? variants.en ?? '';
}

/** Язык и то, откуда он взялся: чтобы в stand_info было видно, почему описания на этом языке. */
export function langInfo(env = process.env) {
  const explicit = String(env.LT_LANG || '').trim().toLowerCase();
  const source = SUPPORTED.includes(explicit)
    ? 'LT_LANG'
    : /^(ru|en)/.test(String(env.LC_ALL || env.LANG || '').toLowerCase())
      ? 'LANG'
      : 'по умолчанию';
  return { lang: LANG, source, supported: SUPPORTED, hint: 'Задаётся переменной LT_LANG=ru|en|auto' };
}
