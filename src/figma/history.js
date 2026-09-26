/**
 * История макета: что поменялось за период.
 *
 * Журнала отдельных действий Figma наружу не отдаёт. Activity Logs есть только у Enterprise, через
 * OAuth, и пишут события организации (вход, экспорт, доступ), а не правки слоёв. Plugin API
 * истории не видит вовсе. Остаётся то, что есть в REST, и этого хватает на вопрос «что поменялось
 * с прошлой сдачи»:
 *
 *   - версии файла (/versions): автосохранения, которые Figma делает сама по ходу работы, и
 *     именованные версии с подписью — кто и когда;
 *   - комментарии с датами — они уже есть у figma_comments;
 *   - снимок узла на версию (/nodes?version=) — из двух таких снимков считается разница.
 *
 * Гранулярность — версия, а не действие: десять правок между двумя автосохранениями видны одной
 * разницей. Об этом говорится в ответе, чтобы отсутствие шага не читалось как «шага не было».
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../constants.js';
import { colorCss, round } from './css.js';
import { getRestClient } from './rest.js';
import { childNodes, normalizeRestTree, safeId } from './snapshot.js';
import { refOf, urlOf } from './url.js';

const TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 50;
/* Страниц версий за один вызов: у живого файла автосохранений сотни, а за год назад ходят редко. */
const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data), 'utf8');
  } catch {
    /* Кэш — удобство, а не состояние. */
  }
}

/**
 * Граница периода. Дата без времени — это сутки целиком: until: "2026-09-20" включает вечер
 * двадцатого, иначе правки этого дня молча выпадали бы.
 */
export function parseMoment(value, { end = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const start = Date.parse(`${text}T00:00:00Z`);
    return end ? start + DAY_MS - 1 : start;
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`Не разобрать дату «${value}»: нужен вид 2026-09-20 или 2026-09-20T15:30:00Z.`);
  return ms;
}

const versionOf = (raw) => ({
  id: String(raw.id),
  at: raw.created_at,
  by: raw.user?.handle ?? null,
  ...(raw.label ? { label: raw.label } : {}),
  ...(raw.description ? { description: raw.description } : {}),
  autosave: !raw.label,
});

/**
 * Версии файла от новых к старым, пока не дойдём до since.
 *
 * Список кэшируется на пять минут вместе с признаком, докуда он дочитан: повторный вызов за
 * более ранний период дочитывает хвост, а не листает всё с начала.
 */
export async function fetchVersions(
  fileKey,
  { since = null, client = getRestClient(), cacheDir = DIRS.figma, refresh = false, now = () => Date.now() } = {},
) {
  const file = path.join(cacheDir, fileKey, 'versions.json');
  let cached = refresh ? null : await readJson(file);
  if (cached && now() - Date.parse(cached.fetchedAt) >= TTL_MS) cached = null;

  let versions = cached?.versions ?? [];
  let exhausted = cached?.exhausted ?? false;
  let requests = 0;
  const reached = () => exhausted || (since !== null && versions.length && Date.parse(versions.at(-1).at) < since);

  if (!cached) {
    const res = await client.versions(fileKey, { pageSize: PAGE_SIZE });
    requests += 1;
    versions = (res.versions || []).map(versionOf);
    exhausted = !versions.length || !res.pagination?.next_page;
  }
  let pages = 0;
  while (since !== null && !reached() && pages < MAX_PAGES) {
    const res = await client.versions(fileKey, { pageSize: PAGE_SIZE, before: versions.at(-1)?.id });
    requests += 1;
    pages += 1;
    const more = (res.versions || []).map(versionOf).filter((v) => !versions.some((known) => known.id === v.id));
    versions.push(...more);
    if (!more.length || !res.pagination?.next_page) exhausted = true;
  }

  const fetchedAt = cached?.fetchedAt ?? new Date(now()).toISOString();
  if (requests) await writeJson(file, { fileKey, fetchedAt, versions, exhausted });
  return { versions, exhausted, requests, fromCache: !requests, truncated: since !== null && !reached() };
}

/**
 * Какие версии сравнивать. base — состояние на начало периода: последняя версия не позже since
 * (нет такой — самая ранняя из известных, и тогда это сказано). head — последняя не позже until;
 * без until — текущее состояние файла, а не последнее автосохранение: правки после него тоже
 * правки.
 */
export function pickVersions(versions, { since, until = null }) {
  const sorted = [...versions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const base = sorted.find((v) => Date.parse(v.at) <= since) ?? null;
  const head = until === null ? { id: null, at: null, current: true } : sorted.find((v) => Date.parse(v.at) <= until) ?? null;
  return {
    base: base ?? sorted.at(-1) ?? null,
    baseIsOldest: !base,
    head,
  };
}

/** Снимок узла на версию. Версия неизменяема, поэтому кэш бессрочный. */
export async function snapshotAt(fileKey, nodeId, version, { client = getRestClient(), cacheDir = DIRS.figma } = {}) {
  const file = version ? path.join(cacheDir, fileKey, `v${version}`, `${safeId(nodeId)}.json`) : null;
  if (file) {
    const hit = await readJson(file);
    if (hit) return { snapshot: hit, requests: 0 };
  }
  const res = await client.fileNodes(fileKey, [nodeId], version ? { version } : {});
  const entry = res.nodes?.[nodeId];
  if (!entry?.document) return { snapshot: null, requests: 1 };
  const snapshot = {
    fileKey,
    root: nodeId,
    version: version ?? res.version ?? null,
    channel: 'rest',
    nodes: normalizeRestTree(entry.document, entry),
  };
  if (file) await writeJson(file, snapshot);
  return { snapshot, requests: 1 };
}

/* ── Разница двух снимков ─────────────────────────────────────────────────────────────── */

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function paintText(paints) {
  if (!paints?.length) return 'нет';
  return paints
    .map((paint) => {
      if (paint.kind === 'solid') return colorCss(paint.color);
      if (paint.kind === 'image') return 'картинка';
      return paint.kind;
    })
    .join(', ');
}

function styleText(style = {}) {
  return [style.family, style.weight, style.size ? `${style.size}px` : null].filter(Boolean).join(' ');
}

function namePath(snapshot, id, rootId) {
  const names = [];
  for (let node = snapshot.nodes[id]; node; node = snapshot.nodes[node.parent]) {
    names.unshift(node.name);
    if (node.id === rootId) break;
  }
  return names.join(' / ');
}

/** Поля узла, которые видны в вёрстке, и как их показать человеку. */
function nodeChanges(before, after, rootBefore, rootAfter) {
  const out = {};
  const put = (key, from, to) => {
    out[key] = { from, to };
  };
  if (before.name !== after.name) put('name', before.name, after.name);
  if ((before.visible !== false) !== (after.visible !== false)) put('visible', before.visible !== false, after.visible !== false);
  if (before.text || after.text) {
    if (before.text?.chars !== after.text?.chars) put('text', before.text?.chars ?? null, after.text?.chars ?? null);
    if (!same(before.text?.style, after.text?.style)) {
      const from = styleText(before.text?.style);
      const to = styleText(after.text?.style);
      if (from !== to) put('font', from, to);
      else if (!same(before.text?.style?.lineHeight, after.text?.style?.lineHeight)) put('lineHeight', before.text?.style?.lineHeight ?? null, after.text?.style?.lineHeight ?? null);
    }
  }
  const a = before.box;
  const b = after.box;
  if (a && b) {
    if (Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5) put('size', `${round(a.w)}x${round(a.h)}`, `${round(b.w)}x${round(b.h)}`);
    /* Положение — от угла запрошенного узла: сдвиг всего кадра по холсту вёрстку не меняет. */
    const ax = a.x - (rootBefore.box?.x ?? 0);
    const ay = a.y - (rootBefore.box?.y ?? 0);
    const bx = b.x - (rootAfter.box?.x ?? 0);
    const by = b.y - (rootAfter.box?.y ?? 0);
    if (before !== rootBefore && (Math.abs(ax - bx) > 0.5 || Math.abs(ay - by) > 0.5)) put('position', `${round(ax)},${round(ay)}`, `${round(bx)},${round(by)}`);
  }
  if (!same(before.fills, after.fills)) put('fill', paintText(before.fills), paintText(after.fills));
  if (!same(before.strokes, after.strokes) || !same(before.stroke, after.stroke)) {
    put('stroke', `${paintText(before.strokes)} ${before.stroke?.weight ?? 0}px`, `${paintText(after.strokes)} ${after.stroke?.weight ?? 0}px`);
  }
  if (!same(before.radius, after.radius)) put('radius', before.radius ?? 0, after.radius ?? 0);
  if (!same(before.opacity, after.opacity)) put('opacity', before.opacity ?? 1, after.opacity ?? 1);
  if (!same(before.effects, after.effects)) put('effects', (before.effects || []).length, (after.effects || []).length);
  if (!same(before.layout, after.layout)) put('layout', before.layout ?? null, after.layout ?? null);
  if (!same(before.item, after.item)) put('sizing', before.item ?? null, after.item ?? null);
  if (!same(before.component?.id, after.component?.id)) put('component', before.component?.name ?? before.component?.id ?? null, after.component?.name ?? after.component?.id ?? null);
  return out;
}

/** Узлы поддерева в порядке обхода: разница читается сверху вниз, как макет. */
function order(snapshot, rootId) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    out.push(node.id);
    for (const kid of childNodes(snapshot, node)) visit(kid);
  };
  visit(snapshot.nodes[rootId]);
  return out;
}

/**
 * Что поменялось в поддереве между двумя снимками одного узла.
 *
 * Добавленное и удалённое показывается верхушкой: новая карточка — одна запись, а не карточка и
 * все её тексты. Изменённое — по узлу, с полями «было → стало».
 */
export function diffSnapshots(before, after, rootId, { fileKey = after?.fileKey ?? before?.fileKey } = {}) {
  const idsBefore = order(before, rootId);
  const idsAfter = order(after, rootId);
  const inBefore = new Set(idsBefore);
  const inAfter = new Set(idsAfter);
  const entry = (snapshot, id) => ({
    node: id,
    name: snapshot.nodes[id].name,
    path: namePath(snapshot, id, rootId),
    ...(fileKey ? { ref: refOf(fileKey, id), url: urlOf(fileKey, id) } : {}),
  });

  const added = idsAfter
    .filter((id) => !inBefore.has(id) && inBefore.has(after.nodes[id].parent))
    .map((id) => ({ ...entry(after, id), type: after.nodes[id].type }));
  const removed = idsBefore
    .filter((id) => !inAfter.has(id) && inAfter.has(before.nodes[id].parent))
    .map((id) => ({ ...entry(before, id), type: before.nodes[id].type }));

  const changed = [];
  const rootBefore = before.nodes[rootId];
  const rootAfter = after.nodes[rootId];
  for (const id of idsAfter) {
    if (!inBefore.has(id)) continue;
    const changes = nodeChanges(before.nodes[id], after.nodes[id], rootBefore, rootAfter);
    if (Object.keys(changes).length) changed.push({ ...entry(after, id), changes });
  }
  return { added, removed, changed };
}
