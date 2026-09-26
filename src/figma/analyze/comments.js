/**
 * Комментарии к макету и аннотации Dev Mode.
 *
 * Половина требований живёт не в макете, а в комментариях рядом с ним: «этот блок только для
 * авторизованных», «тут будет до пяти строк», «кнопку убрали». Читать их приходится вручную и
 * поэтому обычно не приходится вовсе.
 *
 * Комментарии есть только в REST — у Plugin API доступа к ним нет. Кэш короткий: комментарии
 * пишут во время работы, и сутками старый список хуже отсутствующего.
 *
 * Привязка к элементу — главное здесь. Комментарий, поставленный на кнопку, Figma хранит не как
 * «на кнопке», а как «в кадре верхнего уровня, со смещением от его угла»: node_id в client_meta —
 * это кадр, а не элемент (проверено по документации REST 2026-09-26). Элемент восстанавливается
 * попаданием точки в самый глубокий узел кадра; комментарий-регион — самым глубоким узлом,
 * накрывающим регион целиком. Без этого «поправить отступ» остаётся загадкой: отступ у чего, — а
 * запрос карточки не находит комментарий на её кнопке.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../../constants.js';
import { getRestClient } from '../rest.js';
import { urlOf } from '../url.js';
import { clip, contains, isVisible, visibleNodes } from './common.js';

const TTL_MS = 5 * 60 * 1000;

const cacheFile = (cacheDir, fileKey) => path.join(cacheDir, fileKey, 'comments.json');

export async function fetchComments(
  fileKey,
  { client = getRestClient(), cacheDir = DIRS.figma, refresh = false, now = () => Date.now() } = {},
) {
  const file = cacheFile(cacheDir, fileKey);
  if (!refresh) {
    const cached = await readCachedComments(fileKey, { cacheDir });
    if (cached && now() - Date.parse(cached.fetchedAt) < TTL_MS) return { ...cached, fromCache: true };
  }
  const res = await client.comments(fileKey);
  const data = { fileKey, fetchedAt: new Date(now()).toISOString(), comments: res.comments || [] };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data), 'utf8');
  } catch {
    /* Кэш — удобство, а не состояние. */
  }
  return data;
}

/**
 * Список из кэша независимо от срока — для тех, кто не вправе тратить запрос: figma_inspect и
 * figma_spec показывают комментарии узла попутно и в Figma за ними не ходят.
 */
export async function readCachedComments(fileKey, { cacheDir = DIRS.figma } = {}) {
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile(cacheDir, fileKey), 'utf8'));
    return Array.isArray(cached?.comments) ? cached : null;
  } catch {
    return null;
  }
}

/** Путь до узла именами предков: по нему понятно, о чём комментарий, без открытия Figma. */
function pathOf(snapshot, nodeId, { stopAt = null, max = 4 } = {}) {
  const names = [];
  let current = snapshot.nodes[nodeId];
  while (current && names.length < max) {
    names.unshift(clip(current.name, 24));
    if (current.id === stopAt) break;
    current = current.parent ? snapshot.nodes[current.parent] : null;
  }
  return names.join(' / ');
}

/** Цепочка id от узла вверх: сам узел, предки внутри снимка, затем предки корня снимка. */
function lineageOf(snapshot, nodeId) {
  const ids = [];
  for (let current = snapshot.nodes[nodeId]; current; current = snapshot.nodes[current.parent]) ids.push(current.id);
  for (const up of [...(snapshot.ancestors || [])].reverse()) ids.push(up.id);
  return ids;
}

/**
 * Самый глубокий видимый узел поддерева, накрывающий прямоугольник (точка — прямоугольник
 * нулевого размера). Из равных по глубине берётся меньший: наложенные соседи — обычное дело, и
 * комментарий относится к тому, что под пальцем, а не к подложке.
 */
function deepestAt(snapshot, rootId, rect) {
  let best = null;
  for (const { node, depth } of visibleNodes(snapshot, rootId)) {
    if (!node.box || !contains(node.box, rect, 0.5)) continue;
    const area = node.box.w * node.box.h;
    if (!best || depth > best.depth || (depth === best.depth && area < best.area)) best = { node, depth, area };
  }
  return best?.node ?? null;
}

/**
 * Где искать кадр комментария: снимок, в котором он есть узлом, либо снимок, у корня которого он
 * значится предком (редактор отдаёт предков вместе с их рамкой).
 */
function locateFrame(frameId, frames) {
  for (const frame of frames) {
    const node = frame.snapshot.nodes[frameId];
    if (node) return { frame, box: node.box, searchRoot: frameId };
  }
  for (const frame of frames) {
    const up = (frame.snapshot.ancestors || []).find((item) => item.id === frameId);
    if (up?.box) return { frame, box: up.box, searchRoot: frame.snapshot.root ?? frame.rootId };
  }
  return null;
}

/** Прямоугольник комментария на холсте: точка булавки или регион. */
function rectOf(meta, origin = { x: 0, y: 0 }) {
  const at = meta.node_offset ?? { x: meta.x, y: meta.y };
  if (typeof at?.x !== 'number' || typeof at?.y !== 'number') return null;
  const w = meta.region_width > 0 ? meta.region_width : 0;
  const h = meta.region_height > 0 ? meta.region_height : 0;
  return { x: origin.x + at.x, y: origin.y + at.y, w, h };
}

/**
 * Привязка одного комментария. Возвращает то, что уйдёт в ответ, и цепочку предков элемента —
 * по ней решается, относится ли комментарий к запрошенному узлу.
 */
export function resolveAnchor(comment, frames) {
  const meta = comment.client_meta || {};
  const region = meta.region_width > 0 && meta.region_height > 0;
  const frameId = meta.node_id || null;

  let rect = null;
  let candidates = frames;
  let searchRoot = null;
  if (frameId) {
    const host = locateFrame(frameId, frames);
    if (!host) {
      return {
        anchor: { frame: frameId, note: 'кадр комментария не снят — figma_sync по нему покажет, к какому элементу он относится' },
        lineage: [frameId],
        unresolvedFrame: frameId,
      };
    }
    if (!host.box) return { anchor: { frame: frameId, note: 'у кадра комментария нет рамки в снимке' }, lineage: [frameId] };
    rect = rectOf(meta, host.box);
    candidates = [host.frame];
    searchRoot = host.searchRoot;
  } else {
    rect = rectOf(meta);
  }
  if (!rect) return { anchor: frameId ? { frame: frameId } : null, lineage: frameId ? [frameId] : [] };

  for (const frame of candidates) {
    const snapshot = frame.snapshot;
    const rootId = searchRoot ?? frame.rootId;
    const node = deepestAt(snapshot, rootId, rect);
    if (!node) continue;
    const fileKey = snapshot.fileKey;
    return {
      anchor: {
        node: node.id,
        name: clip(node.name, 40),
        path: pathOf(snapshot, node.id),
        ...(frameId && frameId !== node.id ? { frame: frameId } : {}),
        by: region ? 'region' : frameId ? 'element' : 'canvas',
        ...(fileKey ? { url: urlOf(fileKey, node.id) } : {}),
      },
      lineage: lineageOf(snapshot, node.id),
      snapshot,
    };
  }
  const at = { x: Math.round(rect.x), y: Math.round(rect.y) };
  return {
    anchor: { ...(frameId ? { frame: frameId } : {}), at, note: 'точка вне снятых узлов' },
    lineage: frameId ? [frameId] : [],
  };
}

/** Совместимость: только сама привязка. */
export const anchorOf = (comment, frames) => resolveAnchor(comment, frames).anchor;

/**
 * Комментарии в треды: ответ без своей ветки теряет вопрос, к которому относится.
 *
 * targets — id запрошенных узлов. С ними остаются только треды на самом узле (on: self) и на его
 * потомках (on: descendant, с путём от узла вниз и ссылкой на элемент): запрос карточки обязан
 * показать комментарий на её кнопке. Без targets — все треды файла, как раньше.
 *
 * Треды, чей кадр не нашёлся ни в одном снимке, при заданных targets отбрасываются, а их кадры
 * возвращаются в unresolvedFrames: снять их — дело вызывающего, он знает цену запроса.
 */
export function buildThreads(comments, frames, { resolved = false, targets = null, since = null, until = null } = {}) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const replies = new Map();
  for (const comment of comments) {
    if (!comment.parent_id) continue;
    replies.set(comment.parent_id, [...(replies.get(comment.parent_id) || []), comment]);
  }
  const wanted = targets?.length ? targets : null;
  const unresolvedFrames = new Set();
  /* Неснятый кадр — повод для беспокойства, только если предки запрошенных узлов неизвестны
     (снимок REST). Снимок редактора их знает: кадр, которого нет среди предков и в поддереве,
     к узлу заведомо не относится. Контекстные кадры (context) подгружены ради комментариев и
     в этом счёте не участвуют. */
  const blind = frames.filter((frame) => !frame.context).some((frame) => !frame.snapshot.ancestors?.length);
  const inRange = (at) => (!since || Date.parse(at) >= since) && (!until || Date.parse(at) <= until);

  const threads = [];
  for (const comment of comments) {
    if (comment.parent_id && byId.has(comment.parent_id)) continue;
    const isResolved = Boolean(comment.resolved_at);
    if (isResolved && !resolved) continue;
    const thread = replies.get(comment.id) || [];
    if ((since || until) && ![comment, ...thread].some((item) => inRange(item.created_at))) continue;

    const { anchor, lineage, snapshot, unresolvedFrame } = resolveAnchor(comment, frames);
    let relation = null;
    if (wanted) {
      const target = wanted.find((id) => lineage.includes(id));
      if (!target) {
        if (unresolvedFrame && blind) unresolvedFrames.add(unresolvedFrame);
        continue;
      }
      relation =
        anchor?.node === target
          ? { on: 'self' }
          : {
              on: 'descendant',
              ...(wanted.length > 1 ? { target } : {}),
              ...(snapshot && anchor?.node ? { path: pathOf(snapshot, anchor.node, { stopAt: target, max: 8 }) } : {}),
            };
    }
    threads.push({
      id: comment.id,
      at: comment.created_at,
      by: comment.user?.handle ?? null,
      message: clip(comment.message, 600),
      ...(isResolved ? { resolved: comment.resolved_at } : {}),
      ...(relation || {}),
      anchor,
      replies: thread
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((reply) => ({ at: reply.created_at, by: reply.user?.handle ?? null, message: clip(reply.message, 400) })),
    });
  }
  const selfFirst = (thread) => (thread.on === 'self' ? 0 : 1);
  threads.sort((a, b) => selfFirst(a) - selfFirst(b) || Date.parse(b.at) - Date.parse(a.at));
  if (wanted) Object.defineProperty(threads, 'unresolvedFrames', { value: [...unresolvedFrames] });
  return threads;
}

/**
 * Кадры открытых комментариев, которых нет в загруженных снимках, — кандидаты на подгрузку.
 * Нужны только тогда, когда у снимка запрошенного узла нет предков: иначе по предкам и так видно,
 * что чужой кадр к узлу отношения не имеет.
 */
export function missingFrames(comments, frames, { resolved = false } = {}) {
  const out = new Set();
  for (const comment of comments) {
    if (comment.parent_id || (comment.resolved_at && !resolved)) continue;
    const frameId = comment.client_meta?.node_id;
    if (frameId && !locateFrame(frameId, frames)) out.add(frameId);
  }
  return [...out];
}

/**
 * Короткая сводка для figma_inspect и figma_spec: сколько тредов на узле и под ним и три
 * последних. Считается по тому, что уже лежит в кэше, — запросов не тратит.
 */
export function commentsDigest(comments, frames, nodeId, { fetchedAt = null } = {}) {
  const threads = buildThreads(comments, frames, { targets: [nodeId] });
  const self = threads.filter((thread) => thread.on === 'self').length;
  const unresolved = threads.unresolvedFrames?.length || 0;
  if (!threads.length && !unresolved) return { self: 0, descendants: 0, ...(fetchedAt ? { fetchedAt } : {}) };
  return {
    self,
    descendants: threads.length - self,
    top: threads.slice(0, 3).map((thread) => ({
      ...(thread.anchor?.node ? { node: thread.anchor.node, name: thread.anchor.name } : {}),
      on: thread.on,
      by: thread.by,
      message: clip(thread.message, 120),
      ...(thread.replies.length ? { replies: thread.replies.length } : {}),
    })),
    ...(unresolved ? { framesNotSynced: unresolved } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
    how: 'figma_comments',
  };
}

/** Аннотации Dev Mode и метки готовности: то же требование, только внутри самого макета. */
export function collectAnnotations(frames) {
  const out = [];
  for (const frame of frames) {
    for (const { node } of visibleNodes(frame.snapshot, frame.rootId)) {
      if (!isVisible(node)) continue;
      if (node.annotations?.length) {
        out.push({
          node: node.id,
          frame: frame.ref,
          name: clip(node.name, 40),
          labels: node.annotations.map((annotation) => clip(annotation.label, 200)).filter(Boolean),
          properties: node.annotations.flatMap((annotation) => (annotation.properties || []).map((property) => property.type)),
        });
      }
      if (node.devStatus) out.push({ node: node.id, frame: frame.ref, name: clip(node.name, 40), devStatus: node.devStatus });
    }
  }
  return out;
}
