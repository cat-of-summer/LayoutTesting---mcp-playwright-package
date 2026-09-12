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
 * Привязка к элементу — главное здесь. Комментарий, прикреплённый к узлу, показывается вместе с
 * путём до него; поставленный точкой на холсте — через попадание точки в узел кадра. Без этого
 * «поправить отступ» остаётся загадкой: отступ у чего.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../../constants.js';
import { getRestClient } from '../rest.js';
import { clip, contains, isVisible, visibleNodes } from './common.js';

const TTL_MS = 5 * 60 * 1000;

export async function fetchComments(
  fileKey,
  { client = getRestClient(), cacheDir = DIRS.figma, refresh = false, now = () => Date.now() } = {},
) {
  const file = path.join(cacheDir, fileKey, 'comments.json');
  if (!refresh) {
    try {
      const cached = JSON.parse(await fs.readFile(file, 'utf8'));
      if (now() - Date.parse(cached.fetchedAt) < TTL_MS) return { ...cached, fromCache: true };
    } catch {
      /* Нет кэша — спросим Figma. */
    }
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

/** Путь до узла именами предков: по нему понятно, о чём комментарий, без открытия Figma. */
function pathOf(snapshot, nodeId) {
  const names = [];
  let current = snapshot.nodes[nodeId];
  while (current && names.length < 4) {
    names.unshift(clip(current.name, 24));
    current = current.parent ? snapshot.nodes[current.parent] : null;
  }
  return names.join(' / ');
}

/** Самый глубокий видимый узел, накрывающий точку холста. */
function hitTest(frames, point) {
  let best = null;
  for (const frame of frames) {
    const root = frame.snapshot.nodes[frame.rootId];
    if (!root?.box || !contains(root.box, { ...point, w: 0, h: 0 }, 0)) continue;
    for (const { node, depth } of visibleNodes(frame.snapshot, frame.rootId)) {
      if (!node.box || !contains(node.box, { ...point, w: 0, h: 0 }, 0)) continue;
      if (!best || depth > best.depth) best = { node, depth, frame };
    }
  }
  return best;
}

export function anchorOf(comment, frames) {
  const meta = comment.client_meta || {};
  if (meta.node_id) {
    const frame = frames.find((item) => item.snapshot.nodes[meta.node_id]);
    if (!frame) return { node: meta.node_id, note: 'узел не снят — добавьте его в figma_sync, чтобы увидеть путь' };
    return {
      node: meta.node_id,
      frame: frame.ref,
      name: clip(frame.snapshot.nodes[meta.node_id].name, 40),
      path: pathOf(frame.snapshot, meta.node_id),
    };
  }
  const point = typeof meta.x === 'number' ? { x: meta.x, y: meta.y } : null;
  if (!point) return null;
  const hit = hitTest(frames, point);
  if (!hit) return { at: point, note: 'точка вне снятых кадров' };
  return {
    node: hit.node.id,
    frame: hit.frame.ref,
    name: clip(hit.node.name, 40),
    path: pathOf(hit.frame.snapshot, hit.node.id),
    by: 'точке на холсте',
  };
}

/**
 * Комментарии в треды: ответ без своей ветки теряет вопрос, к которому относится.
 */
export function buildThreads(comments, frames, { resolved = false } = {}) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const replies = new Map();
  for (const comment of comments) {
    if (!comment.parent_id) continue;
    replies.set(comment.parent_id, [...(replies.get(comment.parent_id) || []), comment]);
  }

  const threads = [];
  for (const comment of comments) {
    if (comment.parent_id && byId.has(comment.parent_id)) continue;
    const isResolved = Boolean(comment.resolved_at);
    if (isResolved && !resolved) continue;
    threads.push({
      id: comment.id,
      at: comment.created_at,
      by: comment.user?.handle ?? null,
      message: clip(comment.message, 600),
      ...(isResolved ? { resolved: comment.resolved_at } : {}),
      anchor: anchorOf(comment, frames),
      replies: (replies.get(comment.id) || [])
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((reply) => ({ at: reply.created_at, by: reply.user?.handle ?? null, message: clip(reply.message, 400) })),
    });
  }
  return threads.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
