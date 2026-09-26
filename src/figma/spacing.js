/**
 * Интервалы между элементами: макет против страницы.
 *
 * figma_compare отвечает «на месте ли каждый элемент», а здесь вопрос другой — «правильные ли
 * расстояния между ними». Накопленный сдвиг маскирует причину: сверка показывает «−60px у
 * последней ссылки подвала», а беда в том, что шаг ссылок 32 вместо 40, и в том, что блок
 * «Политика / Соглашение» стоит в 20px от соцсетей вместо 60. Здесь каждый интервал — строка
 * с числом в макете, числом на странице и свойством, которое этот интервал в макете задаёт:
 * gap родителя или padding, — тогда понятно, что править.
 *
 * Соответствие макета и страницы — по текстам, тем же сопоставлением, что у figma_compare.
 * Интервал меряется от последнего текста одного соседа до первого текста следующего: у
 * текстов есть пара на странице, у рамок и обёрток — нет. Для узлов без текста — pairs.
 */
import { round } from './css.js';
import { clip, visibleNodes } from './analyze/common.js';
import { designItems, pairTexts } from './compare.js';

const AXIS = { column: 'y', row: 'x' };

/** Тексты внутри узла, у которых есть пара на странице. */
function textsOf(snapshot, nodeId, pairsById) {
  const out = [];
  for (const { node } of visibleNodes(snapshot, nodeId)) {
    const pair = pairsById.get(node.id);
    if (pair) out.push(pair);
  }
  return out;
}

const edge = (box, axis, end) => (axis === 'y' ? box.y + (end ? box.h : 0) : box.x + (end ? box.w : 0));

/**
 * Свойство, которое даёт интервал в макете.
 *
 * gap родителя — если расстояние между рамками соседей равно ему. Иначе — свободное место:
 * space-between, выравнивание или абсолютная позиция; тогда смотреть на padding соседей.
 */
function sourceOf(parent, gapBoxes, prev, next, axis) {
  const layout = parent.layout;
  const parts = [];
  if (layout && AXIS[layout.mode] === axis && Math.abs((layout.gap ?? 0) - gapBoxes) <= 1) {
    parts.push(`gap ${round(layout.gap)} у «${clip(parent.name || parent.id, 30)}»`);
  } else if (layout && AXIS[layout.mode] === axis && layout.main === 'SPACE_BETWEEN') {
    parts.push(`space-between у «${clip(parent.name || parent.id, 30)}»`);
  } else if (layout && AXIS[layout.mode] === axis) {
    parts.push(`gap ${round(layout.gap ?? 0)} у «${clip(parent.name || parent.id, 30)}», но между рамками ${round(gapBoxes)}`);
  } else {
    parts.push('свободная позиция: у родителя нет авто-раскладки по этой оси');
  }
  /* Внутренние отступы соседей со стороны интервала: их тоже видно на странице как расстояние. */
  const pad = (node, side) => node.layout?.padding?.[side] || 0;
  const [endSide, startSide] = axis === 'y' ? [2, 0] : [1, 3];
  const inner = pad(prev, endSide) + pad(next, startSide);
  if (inner) parts.push(`плюс padding соседей ${round(inner)}`);
  return parts.join('; ');
}

/**
 * Интервалы внутри контейнера по снимку и по странице.
 *
 * Обходятся все узлы с авто-раскладкой внутри rootId (и сам он): для каждой пары соседей по
 * оси раскладки — расстояние между рамками в макете, расстояние «текст до текста» в макете и
 * на странице, разница и источник.
 */
export function measureSpacing(snapshot, rootId, probed, { tolerance = 2 } = {}) {
  const design = designItems(snapshot, rootId);
  const { pairs } = pairTexts(design.items, probed.items);
  const pairsById = new Map(pairs.map((pair) => [pair.design.id, pair]));
  const rows = [];

  for (const { node: parent } of visibleNodes(snapshot, rootId)) {
    const axis = AXIS[parent.layout?.mode];
    const kids = (parent.children || [])
      .map((id) => snapshot.nodes[id])
      .filter((kid) => kid?.box && kid.visible !== false && !kid.item?.absolute);
    if (!axis || kids.length < 2) continue;
    kids.sort((a, b) => edge(a.box, axis, false) - edge(b.box, axis, false));
    for (let i = 1; i < kids.length; i += 1) {
      const prev = kids[i - 1];
      const next = kids[i];
      const gapBoxes = edge(next.box, axis, false) - edge(prev.box, axis, true);
      const prevTexts = textsOf(snapshot, prev.id, pairsById);
      const nextTexts = textsOf(snapshot, next.id, pairsById);
      const row = {
        parent: parent.id,
        between: [clip(prev.name || prev.id, 30), clip(next.name || next.id, 30)],
        nodes: [prev.id, next.id],
        axis,
        designGap: round(gapBoxes),
        source: sourceOf(parent, gapBoxes, prev, next, axis),
      };
      if (prevTexts.length && nextTexts.length) {
        /* Последний текст одного соседа и первый следующего — по оси раскладки. */
        const last = prevTexts.reduce((a, b) => (edge(b.design.box, axis, true) > edge(a.design.box, axis, true) ? b : a));
        const first = nextTexts.reduce((a, b) => (edge(b.design.box, axis, false) < edge(a.design.box, axis, false) ? b : a));
        const designText = edge(first.design.box, axis, false) - edge(last.design.box, axis, true);
        const pageText = edge(first.page.box, axis, false) - edge(last.page.box, axis, true);
        row.textToText = { design: round(designText), page: round(pageText) };
        row.delta = round(pageText - designText);
        row.via = [clip(last.design.text, 30), clip(first.design.text, 30)];
        row.selectors = [last.page.selector, first.page.selector];
      } else {
        row.unmeasured = 'У соседа нет текста с парой на странице: такой интервал меряется через pairs.';
      }
      rows.push(row);
    }
  }

  const off = rows.filter((row) => row.delta !== undefined && Math.abs(row.delta) > tolerance);
  return { rows, off, steps: collapseSteps(off) };
}

/**
 * Повторяющийся шаг: подряд у одного родителя одинаковая ошибка интервала — одна строка «×N».
 * Отдельными строками восемь одинаковых «40 → 32» выглядят как восемь правок, а правка одна.
 */
export function collapseSteps(rows) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      out.push({
        parent: run[0].parent,
        step: `шаг ${run[0].textToText.design} → ${run[0].textToText.page}, ×${run.length}`,
        from: run[0].between[0],
        to: run.at(-1).between[1],
        source: run[0].source,
      });
    }
    run = [];
  };
  for (const row of rows) {
    const head = run[0];
    if (
      head &&
      head.parent === row.parent &&
      Math.abs(head.textToText.design - row.textToText.design) <= 1 &&
      Math.abs(head.textToText.page - row.textToText.page) <= 1
    ) {
      run.push(row);
      continue;
    }
    flush();
    run = [row];
  }
  flush();
  return out;
}

/**
 * Явные пары «узел ↔ селектор»: расстояния между соседями по списку в макете и на странице.
 * Для элементов в разных ветках дерева, как ссылки «Политика» относительно соцсетей.
 */
export function measurePairs(snapshot, rootId, entries) {
  const origin = snapshot.nodes[rootId]?.box || { x: 0, y: 0 };
  const rows = [];
  for (let i = 1; i < entries.length; i += 1) {
    const a = entries[i - 1];
    const b = entries[i];
    const na = snapshot.nodes[a.node];
    const nb = snapshot.nodes[b.node];
    if (!na?.box || !nb?.box) {
      rows.push({ between: [a.node, b.node], error: 'Узла нет в снимке этого кадра.' });
      continue;
    }
    if (!a.page || !b.page) {
      rows.push({ between: [a.selector, b.selector], error: 'Селектор не нашёл видимого элемента на странице.' });
      continue;
    }
    const d = (box) => ({ x: box.x - origin.x, y: box.y - origin.y, w: box.w, h: box.h });
    const da = d(na.box);
    const db = d(nb.box);
    const design = { topToTop: round(db.y - da.y), bottomToTop: round(db.y - (da.y + da.h)), leftToLeft: round(db.x - da.x) };
    const page = {
      topToTop: round(b.page.y - a.page.y),
      bottomToTop: round(b.page.y - (a.page.y + a.page.h)),
      leftToLeft: round(b.page.x - a.page.x),
    };
    rows.push({
      between: [clip(na.name || a.node, 30), clip(nb.name || b.node, 30)],
      nodes: [a.node, b.node],
      selectors: [a.selector, b.selector],
      design,
      page,
      delta: Object.fromEntries(Object.keys(design).map((k) => [k, round(page[k] - design[k])])),
    });
  }
  return rows;
}

/** Боксы элементов относительно корня блока на странице — для pairs. */
export function pageBoxes({ root, selectors }) {
  const base = root ? document.querySelector(root) : document.body;
  const origin = base ? base.getBoundingClientRect() : { x: 0, y: 0 };
  return selectors.map((selector) => {
    let el = null;
    try {
      el = [...document.querySelectorAll(selector)].find((node) => {
        const r = node.getBoundingClientRect();
        return r.width && r.height && getComputedStyle(node).visibility !== 'hidden';
      });
    } catch {
      return null;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height };
  });
}
