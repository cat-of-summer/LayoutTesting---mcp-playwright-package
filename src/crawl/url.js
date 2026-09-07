/**
 * Нормализация адресов — основание, на котором стоит весь архив.
 *
 * От неё зависит pageId, дедупликация очереди и то, сойдётся ли canonical сам с собой. Ошибка
 * здесь не падает, а тихо раздваивает страницу: один и тот же материал приезжает в архив дважды
 * под разными именами, счётчики врут, дубли находятся там, где их нет.
 *
 * Что схлопывается и почему:
 *   - якорь: сервер его не видит вовсе, это адрес одной и той же страницы;
 *   - метки кампаний (utm_ и родня): не меняют содержимое, но плодят бесконечные варианты;
 *   - порядок параметров: ?a=1&b=2 и ?b=2&a=1 — один адрес;
 *   - регистр хоста и порт по умолчанию.
 *
 * Что НЕ трогается: регистр пути (на *nix-серверах это разные файлы) и хвостовой слеш (для
 * сервера это разные адреса, и он сам решает, редиректить ли).
 */
import { createHash } from 'node:crypto';
import { slug } from '../artifacts.js';

const TRACKING = /^(utm_[a-z]+|yclid|ysclid|gclid|fbclid|_openstat|_ga|mc_[a-z]+|ref|referrer)$/i;

export function normalizeUrl(value, base) {
  const u = new URL(value, base || undefined);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();

  const kept = [...u.searchParams.entries()].filter(([key]) => !TRACKING.test(key));
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = kept.length ? new URLSearchParams(kept).toString() : '';

  return u.href;
}

/** Тихо возвращает null вместо исключения: в разметке чужого сайта мусорных href хватает. */
export function tryNormalize(value, base) {
  try {
    return normalizeUrl(value, base);
  } catch {
    return null;
  }
}

/**
 * Имя страницы в архиве — хэш, а не путь с сайта.
 *
 * Раскладывать по путям заманчиво, но пути ломаются: кириллица, длина за 255 символов, знак ?
 * в имени файла и регистр, который на WSL-шаре не различается, а на сервере различается.
 */
export function pageIdFor(url) {
  return createHash('sha1').update(normalizeUrl(url)).digest('hex').slice(0, 16);
}

export function siteIdFor(url) {
  return slug(new URL(url).host);
}

export function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/** eTLD+1 нам взять неоткуда, поэтому «тот же сайт» — это хост или его поддомен. */
export function sameSite(a, b) {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, '');
    const hb = new URL(b).hostname.replace(/^www\./, '');
    return ha === hb || ha.endsWith('.' + hb) || hb.endsWith('.' + ha);
  } catch {
    return false;
  }
}
