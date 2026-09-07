/**
 * Выборка по архиву обхода.
 *
 * Два разных вопроса и потому две функции, а не одна с набором флагов:
 *   pages  — «какие страницы подходят», ответ список страниц;
 *   query  — «что нашлось внутри страниц по селектору», ответ список узлов с указанием страницы.
 * Складывать их в один инструмент нельзя: агент не должен получать то список одного, то список
 * другого в зависимости от набора аргументов.
 *
 * Разметку страниц наружу не отдаём никогда — только поля и ссылки на файлы. Мегабайт HTML в
 * ответе вытесняет из контекста агента ровно то, ради чего он и спрашивал.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pageDirOf } from '../mirror/save.js';
import { readIndex } from './store.js';

const DEFAULT_LIMIT = 50;

/** Разметка страницы: сначала зеркало, потом сырой ответ. Что нашлось, то и разбираем. */
async function htmlOf(siteId, pageId) {
  const dir = pageDirOf(siteId, pageId);
  for (const name of ['page.html', 'raw.html']) {
    try {
      return await fs.readFile(path.join(dir, name), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return null;
}

function matches(entry, filter = {}) {
  if (filter.status !== undefined && entry.status !== filter.status) return false;
  if (filter.indexable !== undefined && Boolean(entry.indexable) !== filter.indexable) return false;
  if (filter.maxDepth !== undefined && entry.depth > filter.maxDepth) return false;
  if (filter.minDepth !== undefined && entry.depth < filter.minDepth) return false;
  if (filter.rendered !== undefined && Boolean(entry.rendered) !== filter.rendered) return false;
  if (filter.maxWords !== undefined && (entry.words ?? 0) > filter.maxWords) return false;

  for (const field of filter.missing || []) {
    const value = entry[field];
    if (value !== null && value !== undefined && value !== '') return false;
  }
  return true;
}

/**
 * Группировка ради дублей.
 *
 * Возвращаются только группы больше одной страницы: одиночки — это норма, и показывать их
 * значит утопить находку в шуме.
 */
function groupDuplicates(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field];
    if (key === null || key === undefined || key === '') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.url);
  }
  return [...groups.entries()]
    .filter(([, urls]) => urls.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([value, urls]) => ({ value, count: urls.length, urls }));
}

export async function queryPages(siteId, { filter, text, groupBy, fields, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const index = await readIndex(siteId);
  const all = Object.entries(index.pages).map(([url, entry]) => ({ url, ...entry }));

  let rows = all.filter((entry) => matches(entry, filter));

  if (text) {
    const needle = String(text).toLowerCase();
    const found = [];
    for (const row of rows) {
      const html = await htmlOf(siteId, row.pageId);
      if (!html) continue;
      const plain = html.replace(/<[^>]+>/g, ' ').toLowerCase();
      if (plain.includes(needle)) found.push(row);
    }
    rows = found;
  }

  if (groupBy) {
    const groups = groupDuplicates(rows, groupBy);
    return {
      siteId,
      groupBy,
      total: groups.length,
      truncated: groups.length > limit,
      groups: groups.slice(0, limit),
    };
  }

  const project = (row) =>
    fields && fields.length ? Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f]])) : row;

  return {
    siteId,
    total: rows.length,
    /* Урезание сообщается всегда: без этого агент делает вывод по первым пятидесяти страницам
       из пятисот и не догадывается, что видел десятую часть. */
    truncated: rows.length > offset + limit,
    pages: rows.slice(offset, offset + limit).map(project),
  };
}

export async function querySelector(siteId, { select, attr, filter, limit = DEFAULT_LIMIT } = {}) {
  if (!select) throw new Error('Нужен select — CSS-селектор.');
  const { parseHTML } = await import('linkedom');

  const index = await readIndex(siteId);
  const rows = Object.entries(index.pages)
    .map(([url, entry]) => ({ url, ...entry }))
    .filter((entry) => matches(entry, filter));

  const hits = [];
  let scanned = 0;
  let pagesWithHits = 0;
  let totalMatches = 0;

  for (const row of rows) {
    const html = await htmlOf(siteId, row.pageId);
    if (!html) continue;
    scanned += 1;

    let found;
    try {
      found = [...parseHTML(html).document.querySelectorAll(select)];
    } catch (err) {
      throw new Error(`Селектор не разобран: ${err.message}`);
    }
    if (!found.length) continue;

    pagesWithHits += 1;
    totalMatches += found.length;
    if (hits.length >= limit) continue;

    hits.push({
      url: row.url,
      pageId: row.pageId,
      count: found.length,
      nodes: found.slice(0, 5).map((el) => ({
        text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        ...(attr ? { [attr]: el.getAttribute(attr) } : {}),
      })),
    });
  }

  return {
    siteId,
    select,
    scanned,
    pagesWithHits,
    totalMatches,
    truncated: pagesWithHits > hits.length,
    hits,
  };
}
