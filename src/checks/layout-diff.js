/**
 * Геометрия блока до и после правки.
 *
 * Проверка одной правки отступов шла попиксельным сравнением целой страницы или своим скриптом
 * с getBoundingClientRect. Пиксели отвечают "что-то изменилось", а нужен ответ "что сдвинулось,
 * на сколько и какой стиль поменялся". Здесь снимок поддерева по селектору — боксы в координатах
 * документа и ключевые стили — хранится в сессии под именем, а после правки (HMR перерисовал
 * страницу) снимается заново и сравнивается.
 *
 * Узлы сопоставляются по пути от корня снимка (тег, первый класс, номер среди одноимённых), а не
 * по ссылке на элемент: после перерисовки элементы другие. Узел, сменивший номер из-за
 * вставленного соседа, находится по тегу, классу и тексту.
 */
import { diffBoxes } from '../browser/boxes.js';
import { WATCHED } from './compare-dom.js';
import { newRunId, slug } from '../artifacts.js';
import { takeScreenshot } from './visual.js';

/** Больше — уже не блок, а страница: такой снимок дешевле сравнивать compare_pages. */
export const TREE_LIMIT = 1500;

/**
 * Обход поддерева в браузере: снимок или пометка узлов по списку ключей. Одна функция на оба
 * случая, чтобы путь узла считался одинаково при снимке и при подсветке.
 */
function treeOp({ selector, watched, limit, mark }) {
  let root;
  try {
    root = document.querySelector(selector);
  } catch {
    return { error: `неверный селектор: ${selector}` };
  }
  if (!root) return { error: `селектор ${selector} ничего не нашёл` };

  const firstClass = (el) => Array.from(el.classList).find((c) => !/^(lt-|js-|is-)/.test(c)) || '';
  const keyOf = (el) => {
    if (el === root) return ':root';
    const parts = [];
    let node = el;
    while (node && node !== root) {
      const cls = firstClass(node);
      let part = node.tagName.toLowerCase() + (cls ? `.${cls}` : '');
      const parent = node.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName && firstClass(c) === cls) : [];
      if (same.length > 1) part += `[${same.indexOf(node) + 1}]`;
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };

  const all = [root, ...root.querySelectorAll('*')];
  if (mark) {
    const wanted = new Map(Object.entries(mark));
    let marked = 0;
    for (const el of all) {
      const kind = wanted.get(keyOf(el));
      if (kind) {
        el.setAttribute('data-lt-diff', kind);
        marked += 1;
      }
    }
    return { marked };
  }

  const nodes = {};
  let count = 0;
  let truncated = false;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (!r.width || !r.height || s.display === 'none' || s.visibility === 'hidden') continue;
    if (count >= limit) {
      truncated = true;
      break;
    }
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue.trim())
      .join(' ')
      .trim();
    nodes[keyOf(el)] = {
      x: Math.round((r.left + scrollX) * 10) / 10,
      y: Math.round((r.top + scrollY) * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      fixed: s.position === 'fixed' || s.position === 'sticky',
      viewport: { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10 },
      ...(own ? { text: own.slice(0, 40) } : {}),
      styles: Object.fromEntries(watched.map((p) => [p, s.getPropertyValue(p)])),
    };
    count += 1;
  }
  return { selector, nodes, count, truncated, url: location.href };
}

export async function snapshotTree(page, selector, { limit = TREE_LIMIT } = {}) {
  const snap = await page.evaluate(treeOp, { selector, watched: WATCHED, limit, mark: null });
  if (snap.error) throw new Error(snap.error);
  return { ...snap, takenAt: Date.now() };
}

/* Последний сегмент пути без номера: div.card[3] → div.card. */
const base = (key) => key.split(' > ').pop().replace(/\[\d+\]$/, '');
const parentOf = (key) => (key.includes(' > ') ? key.slice(0, key.lastIndexOf(' > ')) : key === ':root' ? null : ':root');

const depth = (key) => (key === ':root' ? 0 : key.split(' > ').length);
const join = (parent, segment) => (parent && parent !== ':root' ? `${parent} > ${segment}` : segment);

/**
 * Сопоставление узлов до и после: ключ "до" → ключ "после" (null — узел пропал).
 *
 * Номер среди одноимённых соседей ([2]) сдвигается от вставки: строка, вставленная первой,
 * делала бы "новыми" все строки после неё, а у каждой — "сменившимся" текст. Поэтому внутри группы
 * одноимённых соседей узлы сопоставляются по тексту, а уже потом — по номеру. Обход идёт по
 * уровням сверху вниз: переименование предка переносится на потомков.
 */
function rekey(before, after) {
  const map = {};
  const groupsAfter = new Map();
  for (const key of Object.keys(after)) {
    if (key === ':root') continue;
    const group = `${parentOf(key)}|${base(key)}`;
    if (!groupsAfter.has(group)) groupsAfter.set(group, []);
    groupsAfter.get(group).push(key);
  }

  const keys = Object.keys(before).sort((a, b) => depth(a) - depth(b));
  for (let level = 0, i = 0; i < keys.length; level += 1) {
    const groups = new Map();
    for (; i < keys.length && depth(keys[i]) === level; i += 1) {
      const key = keys[i];
      if (key === ':root') {
        map[key] = key in after ? key : null;
        continue;
      }
      const parent = parentOf(key);
      /* Предка нет в снимке (был невидим) — путь остаётся как есть. */
      const newParent = parent in map ? map[parent] : parent;
      if (newParent === null) {
        map[key] = null;
        continue;
      }
      const group = `${newParent}|${base(key)}`;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ key, candidate: join(newParent, key.split(' > ').pop()) });
    }
    for (const [group, list] of groups) {
      const pool = groupsAfter.get(group) || [];
      const used = new Set();
      const unchanged = list.every(({ key, candidate }) => candidate in after && after[candidate].text === before[key].text);
      if (!unchanged) {
        for (const item of list) {
          const text = before[item.key].text;
          const match = text && pool.find((k) => !used.has(k) && after[k].text === text);
          if (match) {
            used.add(match);
            map[item.key] = match;
          }
        }
      }
      for (const item of list) {
        if (item.key in map) continue;
        if (item.candidate in after && !used.has(item.candidate)) {
          used.add(item.candidate);
          map[item.key] = item.candidate;
        } else {
          map[item.key] = null;
        }
      }
    }
  }
  return map;
}

const boxOf = (node) => ({ x: node.x, y: node.y, w: node.w, h: node.h, fixed: node.fixed, viewport: node.viewport });

/**
 * Разница двух снимков. Узел, сдвинутый ровно так же, как его родитель, отдельной находкой не
 * считается: правка отступа заголовка сдвигает всё, что ниже, и список из сотни "сдвигов" прятал
 * бы ту одну строку, ради которой сравнение и затевали.
 */
export function diffTrees(before, after, { threshold = 1, maxItems = 30 } = {}) {
  const map = rekey(before.nodes, after.nodes);
  /* Пропавший узел получает ключ, которого во втором снимке нет: иначе его место занял бы сосед. */
  const GONE = ' ';
  const boxesA = {};
  const boxesB = {};
  const original = {};
  for (const [key, node] of Object.entries(before.nodes)) {
    const target = map[key] ?? `${key}${GONE}`;
    boxesA[target] = boxOf(node);
    original[target] = key;
  }
  for (const [key, node] of Object.entries(after.nodes)) boxesB[key] = boxOf(node);
  const boxes = diffBoxes(boxesA, boxesB, { threshold });

  const deltaOf = new Map((boxes.moved || []).map((m) => [m.selector, m]));
  const sameShift = (a, b) => ['dx', 'dy'].every((k) => Math.abs((a?.[k] || 0) - (b?.[k] || 0)) <= threshold) && !a.dw && !a.dh;
  const moved = [];
  let withParent = 0;
  for (const item of boxes.moved || []) {
    const parent = deltaOf.get(parentOf(item.selector));
    if (parent && sameShift(item, parent)) {
      withParent += 1;
      continue;
    }
    moved.push(item);
  }
  moved.sort((a, b) => Math.abs(b.dw || 0) + Math.abs(b.dh || 0) + Math.abs(b.dx || 0) + Math.abs(b.dy || 0) - (Math.abs(a.dw || 0) + Math.abs(a.dh || 0) + Math.abs(a.dx || 0) + Math.abs(a.dy || 0)));

  const styles = [];
  for (const [keyA, nodeA] of Object.entries(before.nodes)) {
    const key = map[keyA];
    const nodeB = key && after.nodes[key];
    if (!nodeB) continue;
    for (const [prop, value] of Object.entries(nodeA.styles)) {
      if (nodeB.styles[prop] !== value) styles.push({ node: key, prop, before: value, after: nodeB.styles[prop] });
    }
  }

  const named = (list) =>
    list.map((key) => {
      const node = key.endsWith(GONE) ? key.slice(0, -1) : key;
      const text = after.nodes[key]?.text || before.nodes[original[key] ?? key]?.text;
      return { node, ...(text ? { text } : {}) };
    });
  const renumbered = Object.entries(map).filter(([from, to]) => to && to !== from).length;
  const cut = (list) => list.slice(0, maxItems).map(({ selector, ...rest }) => (selector ? { node: selector, ...rest } : rest));
  const changed = moved.length + (boxes.vanished?.length || 0) + (boxes.appeared?.length || 0) + styles.length;
  return {
    compared: Object.keys(boxesA).length,
    unchanged: changed === 0,
    stable: boxes.stable,
    counts: {
      moved: moved.length,
      movedWithParent: withParent,
      vanished: boxes.vanished?.length || 0,
      appeared: boxes.appeared?.length || 0,
      styles: styles.length,
    },
    ...(moved.length ? { moved: cut(moved) } : {}),
    ...(boxes.vanished?.length ? { vanished: named(boxes.vanished).slice(0, maxItems) } : {}),
    ...(boxes.appeared?.length ? { appeared: named(boxes.appeared).slice(0, maxItems) } : {}),
    ...(styles.length ? { styles: styles.slice(0, maxItems) } : {}),
    ...(renumbered ? { renumbered } : {}),
  };
}

/**
 * Кадр блока с обводкой изменившегося: красным — сдвиг и размер, зелёным — новое, жёлтым — только
 * стиль. Пометки и стиль подсветки снимаются сразу после кадра.
 */
export async function highlightDiff(page, selector, diff, { name = 'layout-diff' } = {}) {
  const mark = {};
  for (const item of diff.styles || []) mark[item.node] = 'style';
  for (const item of diff.appeared || []) mark[item.node] = 'appeared';
  for (const item of diff.moved || []) mark[item.node] = 'moved';
  const { marked } = await page.evaluate(treeOp, { selector, watched: [], limit: TREE_LIMIT, mark });
  const style = await page.addStyleTag({
    content:
      '[data-lt-diff]{outline:2px solid #e5484d !important;outline-offset:-1px !important}' +
      '[data-lt-diff="appeared"]{outline-color:#30a46c !important}' +
      '[data-lt-diff="style"]{outline-color:#f5a524 !important}',
  });
  try {
    const shot = await takeScreenshot(page, { runId: newRunId(slug(name)), name: slug(name), selector, fullPage: false });
    return { ...shot, marked, legend: 'красный — сдвиг или размер, зелёный — новое, жёлтый — только стиль' };
  } finally {
    await style.evaluate((node) => node.remove()).catch(() => {});
    await page.evaluate(() => document.querySelectorAll('[data-lt-diff]').forEach((el) => el.removeAttribute('data-lt-diff'))).catch(() => {});
  }
}
