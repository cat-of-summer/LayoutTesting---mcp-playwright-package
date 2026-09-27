/**
 * Сравнение вёрстки с макетом.
 *
 * Попиксельное сравнение отвечает «похоже или нет», но не отвечает «что чинить»: на макете другой
 * контент, другие шрифтовые хинты, другая фотография — и три процента расхождения не значат ничего.
 * Поэтому основное здесь — смысловое сравнение: тексты макета сопоставляются с текстами страницы,
 * и по каждому считается, насколько он съехал и чем отличается его типографика. Такой ответ можно
 * сразу чинить: селектор, id узла в макете и разница в пикселях.
 *
 * Попиксельное сравнение остаётся вторым слоем — как карта, где смотреть глазами.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compare as odiffCompare } from 'odiff-bin';
import { artifactRef, newRunId, runDir, slug } from '../artifacts.js';
import { takeScreenshot } from '../checks/visual.js';
import { colorCss, round } from './css.js';
import { t } from '../i18n.js';
import { browserChrome, clip, contains, deltaE, parseColor, SAME_COLOR, visibleNodes } from './analyze/common.js';
import { exportRender } from './export.js';
import { orderedChildren } from './inspect.js';
import { textRole } from './analyze/breakpoints.js';

const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Что видно на странице: тексты с их геометрией и типографикой, картинки с адресами. */
export function probePage(rootSelector) {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return { error: `на странице нет элемента ${rootSelector}` };

  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
      if (cls) part += `.${CSS.escape(cls)}`;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const origin = root.getBoundingClientRect();
  const items = [];
  const walk = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return;
    /*
     * Спрятанное для глаз, но не для скринридера: .visually-hidden, sr-only. Бокс у такого есть —
     * 1×1 с clip, — и раньше его подпись занимала место видимого заголовка с тем же текстом, а
     * бокс уходил в сверку краски, где подбирался «сдвинутым» к чужому узлу.
     */
    const clipped =
      /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(style.clip) ||
      /inset\(\s*50%/.test(style.clipPath) ||
      (rect.width <= 1 && rect.height <= 1);
    if (clipped) return;
    const box = { x: rect.x - origin.x, y: rect.y - origin.y, w: rect.width, h: rect.height };

    const ownNodes = Array.from(el.childNodes).filter((node) => node.nodeType === 3 && node.nodeValue.trim());
    const own = ownNodes.map((node) => node.nodeValue.trim()).join(' ');
    if (own) {
      /*
       * Бокс самого текста и число его строк — по Range, а не по элементу: у кнопки бокс
       * элемента включает поля, а перенос строк (text-wrap: balance против жадного переноса
       * Figma) виден только по строкам текста.
       */
      const range = document.createRange();
      const tops = [];
      let text = null;
      for (const node of ownNodes) {
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (!r.width || !r.height) continue;
          tops.push(r.top);
          text = text
            ? { l: Math.min(text.l, r.left), t: Math.min(text.t, r.top), r: Math.max(text.r, r.right), b: Math.max(text.b, r.bottom) }
            : { l: r.left, t: r.top, r: r.right, b: r.bottom };
        }
      }
      tops.sort((a, b) => a - b);
      const lines = tops.filter((top, i) => i === 0 || top - tops[i - 1] > 2).length;
      /* Кнопка или ссылка, чей текст это: с ней сравнивается рамка кнопки из макета. */
      const control = el.closest('a, button, [role="button"], summary');
      const controlRect = control && control !== root && root.contains(control) ? control.getBoundingClientRect() : null;
      const wrap = style.textWrapStyle || style.textWrap || '';
      items.push({
        kind: 'text',
        text: own,
        selector: cssPath(el),
        box,
        ...(text ? { textBox: { x: text.l - origin.x, y: text.t - origin.y, w: text.r - text.l, h: text.b - text.t } } : {}),
        ...(lines ? { lines } : {}),
        ...(controlRect
          ? { control: { selector: cssPath(control), box: { x: controlRect.x - origin.x, y: controlRect.y - origin.y, w: controlRect.width, h: controlRect.height } } }
          : {}),
        style: {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          color: style.color,
          textTransform: style.textTransform,
          ...(wrap && !/^(wrap|auto)$/.test(wrap) ? { textWrap: wrap } : {}),
        },
      });
    }
    if (el.tagName === 'IMG') items.push({ kind: 'image', selector: cssPath(el), box, src: el.currentSrc || el.src || '' });
    /* Оформленные боксы: фон, рамка, скругление. По ним сверяется краска — толщина линии, цвет
       полосы, обводка обложки, — которой в текстах нет. */
    if (el !== root) {
      const sides = ['Top', 'Right', 'Bottom', 'Left'];
      const borders = sides.map((side) => parseFloat(style[`border${side}Width`]) || 0);
      const radius = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((corner) => style[`border${corner}Radius`]);
      const transparent = /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor);
      /*
       * Фон картинкой или градиентом — тоже краска.
       *
       * Без этого блок с background-image и прозрачным background-color в перечень не попадал
       * вовсе, а в макете тот же узел лежит заливкой и краску имеет. В сверке он оказывался
       * «не найден по месту» — и вина списывалась на псевдоэлементы, хотя элемент на странице
       * есть и стоит ровно там, где надо. Целый класс ложных unmatched держался на этой строке.
       */
      const hasImage = style.backgroundImage && style.backgroundImage !== 'none';
      if (!transparent || hasImage || borders.some(Boolean) || radius.some((value) => parseFloat(value) > 0)) {
        items.push({
          kind: 'box',
          selector: cssPath(el),
          box,
          paint: {
            background: transparent ? null : style.backgroundColor,
            ...(hasImage ? { backgroundImage: true } : {}),
            borders,
            borderColors: sides.map((side) => style[`border${side}Color`]),
            radius,
          },
        });
      }
    }
    for (const child of el.children) walk(child);
  };
  walk(root);
  return { origin: { w: origin.width, h: origin.height }, items };
}

/**
 * Ширина, которую у страницы отнимает полоса прокрутки корня.
 *
 * innerWidth − clientWidth тут не годится: со scrollbar-gutter: stable и своим
 * ::-webkit-scrollbar clientWidth корня равен окну, а уже сам корень (offsetWidth) на гуттер уже.
 */
export function scrollbarGutter() {
  const root = document.documentElement;
  return Math.max(0, Math.round(window.innerWidth - root.getBoundingClientRect().width - (parseFloat(getComputedStyle(root).marginLeft) || 0) - (parseFloat(getComputedStyle(root).marginRight) || 0)));
}

export function designItems(snapshot, rootId) {
  const root = snapshot.nodes[rootId];
  /* Нарисованная строка браузера — не часть страницы: поток начинается под ней. */
  const chrome = browserChrome(snapshot, rootId);
  const lift = chrome?.height ?? 0;
  const origin = root.box ? { x: root.box.x, y: root.box.y + lift } : { x: 0, y: 0 };
  const rel = (b) => ({ x: b.x - origin.x, y: b.y - origin.y, w: b.w, h: b.h });
  const lead = leadFrame(snapshot, rootId, origin);
  const names = {};
  const ancestorsOf = (node) => {
    const out = [];
    for (let id = node.parent; id && id !== rootId && snapshot.nodes[id]; id = snapshot.nodes[id].parent) {
      out.push(id);
      names[id] = snapshot.nodes[id].name;
    }
    return out;
  };
  const items = [];
  for (const { node } of visibleNodes(snapshot, rootId)) {
    if (!node.box || node.id === chrome?.node) continue;
    /* Закреплённое (fixed) живёт в координатах окна, а не потока: вычитать из него строку нельзя. */
    if (lift && node.scrollBehavior === 'FIXED') continue;
    const box = rel(node.box);
    if (node.type === 'TEXT' && node.text?.chars?.trim()) {
      const style = node.text.style || {};
      const ancestors = ancestorsOf(node);
      const frame = buttonFrame(snapshot, node, rootId);
      const lineHeight = lineHeightPx(style);
      items.push({
        kind: 'text',
        id: node.id,
        text: node.text.chars,
        box,
        ancestors,
        ...(lead && ancestors.includes(lead.node) ? { inLead: true } : {}),
        ...(node.text.autoResize ? { autoResize: node.text.autoResize } : {}),
        ...(style.align ? { align: style.align } : {}),
        ...(frame ? { frame: { id: frame.id, name: frame.name, box: rel(frame.box) } } : {}),
        ...(lineHeight && node.text.autoResize !== 'TRUNCATE' ? { lines: Math.max(1, Math.round(node.box.h / lineHeight)) } : {}),
        style: {
          fontSize: style.size,
          fontWeight: style.weight,
          lineHeight: style.lineHeight?.unit === 'px' ? style.lineHeight.value : null,
          letterSpacing: style.letterSpacing ?? 0,
          color: node.fills?.[0]?.kind === 'solid' ? node.fills[0].color : null,
          textTransform: style.case ? style.case.toLowerCase() : 'none',
        },
      });
    } else if (node.fills?.some((paint) => paint.kind === 'image')) {
      items.push({ kind: 'image', id: node.id, box, name: node.name });
    } else if (node.id !== rootId) {
      const paint = designPaint(node);
      if (paint) items.push({ kind: 'box', id: node.id, name: node.name, type: node.type, box, paint });
    }
  }
  return { size: { w: root.box?.w, h: root.box?.h - lift }, items, names, ...(chrome ? { chrome } : {}), ...(lead ? { lead } : {}) };
}

/** Межстрочный интервал текста в px: явный, «авто» из снимка или процент от кегля. */
function lineHeightPx(style) {
  const lh = style.lineHeight;
  if (!lh) return null;
  if (lh.unit === 'px') return lh.value || null;
  if (lh.unit === 'auto') return lh.px || null;
  if (lh.unit === '%' && style.size) return (style.size * lh.value) / 100 || null;
  return null;
}

const CONTAINERS = new Set(['FRAME', 'INSTANCE', 'COMPONENT', 'GROUP']);

/**
 * Рамка, внутри которой текст — единственный: кнопка, пилюля, пункт меню.
 *
 * Текст в макете часто растянут на ширину кнопки, а на странице его бокс — по содержимому или
 * это бокс самой кнопки с полями. Сравнивать надо рамку кнопки с кнопкой страницы, а не текстовый
 * слой с элементом: иначе совпадающая кнопка давала «w +203, h +26». Карточка, где текст тоже
 * единственный, кнопкой не считается — у неё площадь несоразмерна тексту.
 */
function buttonFrame(snapshot, text, rootId) {
  let node = snapshot.nodes[text.parent];
  for (let depth = 0; node && node.id !== rootId && depth < 3; depth += 1, node = snapshot.nodes[node.parent]) {
    if (!CONTAINERS.has(node.type) || !node.box) continue;
    let texts = 0;
    const count = (id) => {
      const kid = snapshot.nodes[id];
      if (!kid || kid.visible === false || texts > 1) return;
      if (kid.type === 'TEXT' && kid.text?.chars?.trim()) texts += 1;
      for (const child of kid.children || []) count(child);
    };
    count(node.id);
    if (texts !== 1) return null;
    const ratio = (node.box.w * node.box.h) / Math.max(1, text.box.w * text.box.h);
    return ratio <= 8 ? node : null;
  }
  return null;
}

/**
 * Кадр, контент которого начинается не с нуля.
 *
 * «Системы отделения»: дочерний Desktop на y=60, сверху наложена шапка. Сверка писала «57
 * элементов смещены на −60px» и считала это расхождением высоты. Кандидат — широкий дочерний
 * фрейм на половину высоты и больше, начатый ниже верха; подтверждается он уже парами текстов.
 */
export function leadFrame(snapshot, rootId, origin) {
  const root = snapshot.nodes[rootId];
  if (!root?.box) return null;
  for (const kid of orderedChildren(snapshot, root)) {
    if (!kid.box || !CONTAINERS.has(kid.type)) continue;
    const y = kid.box.y - origin.y;
    const wide = kid.box.w >= root.box.w * 0.98;
    const tall = kid.box.h >= (root.box.h - (origin.y - root.box.y)) * 0.5;
    if (wide && tall && y >= 20 && y <= 200) return { node: kid.id, name: kid.name, y: round(y) };
  }
  return null;
}

/** Фигуры, которые в вёрстке становятся SVG: их краска сверяется файлом иконки, а не CSS. */
const VECTOR_SHAPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'REGULAR_POLYGON']);

/**
 * Краска узла в том виде, в каком её можно сравнить с computed-стилями: верхняя сплошная
 * заливка, обводка по сторонам, радиусы по углам. null — сравнивать нечего.
 */
export function designPaint(node) {
  if (node.type === 'TEXT' || VECTOR_SHAPES.has(node.type)) return null;
  const top = (node.fills || []).at(-1);
  const strokePaint = node.strokes?.[0];
  const stroke =
    node.stroke && strokePaint?.kind === 'solid' && (node.stroke.weight || node.stroke.weights)
      ? {
          weights: node.stroke.weights || [0, 0, 0, 0].map(() => node.stroke.weight),
          color: strokePaint.color,
          align: node.stroke.align,
        }
      : null;
  const radius =
    node.type === 'ELLIPSE' || !node.radius ? null : Array.isArray(node.radius) ? node.radius : [0, 0, 0, 0].map(() => node.radius);
  const background = top?.kind === 'solid' ? top.color : null;
  if (!background && !stroke && !radius) return null;
  return { background, gradient: Boolean(top && top.kind !== 'solid'), stroke, radius, line: node.type === 'LINE' };
}

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function iou(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Тонкий узел — линия или полоса: сопоставляется как отрезок, а не по площади. */
const thinAxis = (b) => {
  const small = Math.min(b.w, b.h);
  const large = Math.max(b.w, b.h);
  if (small > 12 || large < 8 * Math.max(small, 1)) return null;
  return b.w >= b.h ? 'h' : 'v';
};

const colorDiff = (design, pageValue) => {
  if (!design) return null;
  if (!pageValue) return { design: colorCss(design), page: 'transparent' };
  const theirs = parseColor(pageValue);
  if (!theirs) return null;
  return deltaE(design, theirs) >= SAME_COLOR ? { design: colorCss(design), page: pageValue } : null;
};

/**
 * Сверка оформления: фон, рамка, толщина линий, радиусы, размеры декора.
 *
 * Тексты сопоставляются по содержимому, у боксов содержимого нет — они ищутся по месту. Но место
 * на странице почти никогда не совпадает с макетом: блок выше короче, и всё ниже него съезжает.
 * Поэтому смещение берётся у сопоставленных текстов: медиана по текстам внутри бокса, иначе по
 * ближайшему тексту. Так серая линия под заголовком находится рядом со своим заголовком, где бы
 * он ни оказался.
 */
/** Насколько далеко узел с краской может «уехать», чтобы его ещё считали тем же узлом, px. */
const SHIFT_RADIUS = 240;

export function comparePaint(design, page, { tolerance = 2 } = {}) {
  const { pairs } = pairTexts(design.items, page.items);
  const anchors = pairs.map((pair) => ({
    box: pair.design.box,
    dx: pair.page.box.x - pair.design.box.x,
    dy: pair.page.box.y - pair.design.box.y,
  }));
  const offsetFor = (b) => {
    const inside = anchors.filter((a) => contains(b, a.box, 1));
    if (inside.length) return { dx: median(inside.map((a) => a.dx)), dy: median(inside.map((a) => a.dy)) };
    let best = null;
    for (const a of anchors) {
      const dist = Math.abs(a.box.y + a.box.h / 2 - (b.y + b.h / 2));
      if (dist <= 600 && (!best || dist < best.dist)) best = { ...a, dist };
    }
    return best ? { dx: best.dx, dy: best.dy } : { dx: 0, dy: 0 };
  };

  const boxes = page.items.filter((item) => item.kind === 'box');
  const findings = [];
  const unmatched = [];
  /** Узлы страницы, уже сопоставленные по месту: во втором проходе их не берут. */
  const used = new Set();
  let matched = 0;

  for (const item of design.items.filter((entry) => entry.kind === 'box')) {
    const { dx, dy } = offsetFor(item.box);
    const at = { x: item.box.x + dx, y: item.box.y + dy, w: item.box.w, h: item.box.h };
    const axis = thinAxis(at);
    const diffs = {};
    let hit = null;

    if (axis) {
      /* Линия на странице — либо тонкий блок с фоном, либо сторона рамки соседнего блока. */
      const along = axis === 'h' ? ['x', 'w'] : ['y', 'h'];
      const cross = axis === 'h' ? ['y', 'h'] : ['x', 'w'];
      const center = at[cross[0]] + at[cross[1]] / 2;
      for (const box of boxes) {
        const r = box.box;
        const overlap = Math.min(at[along[0]] + at[along[1]], r[along[0]] + r[along[1]]) - Math.max(at[along[0]], r[along[0]]);
        if (overlap < 0.8 * Math.max(at[along[1]], 1)) continue;
        const sides = axis === 'h' ? [[0, r.y], [2, r.y + r.h]] : [[3, r.x], [1, r.x + r.w]];
        const options = [];
        if (r[cross[1]] <= 16 && box.paint.background) {
          options.push({ dist: Math.abs(r[cross[0]] + r[cross[1]] / 2 - center), thickness: r[cross[1]], color: box.paint.background });
        }
        for (const [side, edge] of sides) {
          const width = box.paint.borders[side];
          if (width > 0) options.push({ dist: Math.abs(edge - center), thickness: width, color: box.paint.borderColors[side], side });
        }
        for (const option of options) {
          if (option.dist <= 12 && (!hit || option.dist < hit.dist)) hit = { ...option, box };
        }
      }
      if (hit) {
        const designThickness = item.paint.line ? item.paint.stroke?.weights[0] ?? 0 : Math.min(item.box.w, item.box.h);
        const designColor = item.paint.line ? item.paint.stroke?.color : item.paint.background || item.paint.stroke?.color;
        if (Math.abs(designThickness - hit.thickness) > 0.5) diffs.thickness = { design: `${round(designThickness)}px`, page: `${round(hit.thickness)}px` };
        const color = colorDiff(designColor, hit.color);
        if (color) diffs.color = color;
        const length = item.box[along[1]] - hit.box.box[along[1]];
        if (Math.abs(length) > Math.max(tolerance, 4)) diffs.length = { design: `${round(item.box[along[1]])}px`, page: `${round(hit.box.box[along[1]])}px` };
      }
    } else {
      let bestScore = 0;
      for (const box of boxes) {
        const score = iou(at, box.box);
        if (score < 0.75) continue;
        /* Обёртка и её содержимое часто совпадают рамкой: берём тот, у кого краска того же рода. */
        const bonus = (item.paint.background && box.paint.background ? 0.01 : 0) + (item.paint.stroke && box.paint.borders.some(Boolean) ? 0.01 : 0);
        if (score + bonus > bestScore) {
          bestScore = score + bonus;
          hit = { box };
        }
      }
      if (hit) {
        const theirs = hit.box.paint;
        if (item.paint.background) {
          const bg = colorDiff(item.paint.background, theirs.background);
          if (bg) diffs.background = bg;
        }
        const stroke = item.paint.stroke;
        if (stroke && stroke.align !== 'OUTSIDE') {
          const widths = stroke.weights.map((w) => round(w || 0));
          if (widths.some((w, i) => Math.abs(w - theirs.borders[i]) > 0.5)) {
            diffs.border = { design: widths.map((w) => `${w}px`).join(' '), page: theirs.borders.map((w) => `${round(w)}px`).join(' ') };
          }
          const side = widths.findIndex((w) => w > 0);
          const color = side >= 0 && theirs.borders[side] > 0 ? colorDiff(stroke.color, theirs.borderColors[side]) : null;
          if (color) diffs.borderColor = color;
        } else if (!stroke && theirs.borders.some((w) => w > 0)) {
          diffs.border = { design: 'нет', page: theirs.borders.map((w) => `${round(w)}px`).join(' ') };
        }
        if (item.paint.radius && theirs.radius.every((value) => !String(value).includes('%'))) {
          const pageRadius = theirs.radius.map((value) => parseFloat(value) || 0);
          if (item.paint.radius.some((r, i) => Math.abs((r || 0) - pageRadius[i]) > 1)) {
            diffs.radius = { design: item.paint.radius.map((r) => `${round(r || 0)}px`).join(' '), page: pageRadius.map((r) => `${round(r)}px`).join(' ') };
          }
        }
        /* Высота блока с текстом — производная от содержимого, её расхождение уже видно по сдвигу
           текстов. Для декора и контролов размер — само оформление. */
        const r = hit.box.box;
        if (Math.abs(item.box.w - r.w) > tolerance || (item.box.h <= 120 && Math.abs(item.box.h - r.h) > tolerance)) {
          diffs.size = { design: `${round(item.box.w)}x${round(item.box.h)}`, page: `${round(r.w)}x${round(r.h)}` };
        }
      }
    }

    if (!hit) {
      /* at нужен второму проходу: без предсказанного места некуда мерить смещение. */
      const paintKind = item.paint.background ? 'background' : item.paint.stroke ? 'stroke' : null;
      unmatched.push({ node: item.id, name: clip(item.name || '', 30), size: `${round(item.box.w)}x${round(item.box.h)}`, at, type: item.type, paintKind });
      continue;
    }
    matched += 1;
    used.add(hit.box);
    if (Object.keys(diffs).length) {
      findings.push({ node: item.id, name: clip(item.name || '', 30), selector: hit.box.selector, diffs });
    }
  }

  /*
   * Второй проход: «не нашёлся здесь» и «не нашёлся нигде» — разные ответы.
   *
   * Первый проход ищет по месту с поправкой на сдвиг соседних текстов, и этого достаточно, пока
   * рядом есть текст-якорь. Где его нет — а это как раз декор, полосы и подложки, — поправка
   * выходит нулевой, узел не находится, и запись уезжает в общую кучу вместе с настоящими
   * пропажами. Разобрать кучу глазами нельзя: причины требуют разных действий.
   *
   * Здесь тот же узел ищется по размеру где угодно на странице. Нашёлся — это работа, и видно,
   * куда именно уехало. Не нашёлся — это отсутствие, и что за ним стоит, сверка по месту сказать
   * не может: псевдоэлемент, внутренность SVG или правда не свёрстано.
   */
  const shifted = [];
  const notFound = [];
  for (const entry of unmatched) {
    const size = { w: entry.at.w, h: entry.at.h };
    let best = null;
    for (const box of boxes) {
      /* Уже занятый узлом по месту — не кандидат: иначе поле подписки «сдвигалось» к соседу того
         же размера, стоящему ровно на своём месте. */
      if (used.has(box)) continue;
      const r = box.box;
      if (Math.abs(r.w - size.w) > Math.max(tolerance, 4) || Math.abs(r.h - size.h) > Math.max(tolerance, 4)) continue;
      /* Краска того же рода: фон ищется среди фонов, рамка — среди рамок. */
      if (entry.paintKind === 'background' && !box.paint.background && !box.paint.backgroundImage) continue;
      if (entry.paintKind === 'stroke' && !box.paint.borders.some(Boolean)) continue;
      const dx = r.x - entry.at.x;
      const dy = r.y - entry.at.y;
      const dist = Math.hypot(dx, dy);
      /* Дальше SHIFT_RADIUS — это уже не «тот же узел уехал», а случайный узел того же размера. */
      if (dist > SHIFT_RADIUS) continue;
      if (!best || dist < best.dist) best = { dist, dx, dy, box };
    }
    const { at, type, paintKind, ...rest } = entry;
    if (best) shifted.push({ ...rest, selector: best.box.selector, off: { x: round(best.dx), y: round(best.dy) } });
    else notFound.push({ ...rest, ...(type ? { type } : {}) });
  }

  /* Общий сдвиг — одна находка, как и у текстов: чинится высота блока выше, а не каждый узел. */
  const byShift = new Map();
  for (const entry of shifted) {
    if (Math.abs(entry.off.y) <= 20) continue;
    const bucket = Math.round(entry.off.y / 10) * 10;
    byShift.set(bucket, [...(byShift.get(bucket) || []), entry]);
  }
  const blocks = [];
  for (const [bucket, list] of byShift) {
    if (list.length < 3) continue;
    blocks.push({
      shiftedBlock: `${list.length} узлов с краской смещены по вертикали примерно на ${bucket}px`,
      hint: 'Обычно это разная высота блока выше, а не ошибка в каждом узле: сначала сверьте её.',
      sample: list.slice(0, 3).map(({ node, name, selector }) => ({ node, name, selector })),
    });
  }

  findings.sort((a, b) => Object.keys(b.diffs).length - Object.keys(a.diffs).length);
  return { boxes: matched + unmatched.length, matched, findings, shifted, blocks, notFound };
}

const byReadingOrder = (a, b) => a.box.y - b.box.y || a.box.x - b.box.x;

/** Сопоставление по тексту с учётом повторов — как между брейкпоинтами. */
export function pairTexts(design, page) {
  const group = (items) => {
    const map = new Map();
    for (const item of items.filter((entry) => entry.kind === 'text')) {
      const key = norm(item.text);
      map.set(key, [...(map.get(key) || []), item]);
    }
    for (const list of map.values()) list.sort(byReadingOrder);
    return map;
  };
  const left = group(design);
  const right = group(page);
  const pairs = [];
  const matchedLeft = new Set();
  const matchedRight = new Set();
  for (const [key, list] of left) {
    const others = right.get(key) || [];
    for (let i = 0; i < Math.min(list.length, others.length); i += 1) {
      pairs.push({ design: list[i], page: others[i] });
      matchedLeft.add(list[i]);
      matchedRight.add(others[i]);
    }
  }
  return {
    pairs,
    onlyDesign: design.filter((item) => item.kind === 'text' && !matchedLeft.has(item)),
    onlyPage: page.filter((item) => item.kind === 'text' && !matchedRight.has(item)),
  };
}

const px = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function styleDiff(design, page) {
  const out = {};
  const size = px(page.style.fontSize);
  if (design.style.fontSize && size !== null && Math.abs(design.style.fontSize - size) > 0.5) {
    out['font-size'] = { design: `${round(design.style.fontSize)}px`, page: page.style.fontSize };
  }
  const weight = px(page.style.fontWeight);
  if (design.style.fontWeight && weight !== null && design.style.fontWeight !== weight) {
    out['font-weight'] = { design: design.style.fontWeight, page: page.style.fontWeight };
  }
  const lineHeight = px(page.style.lineHeight);
  if (design.style.lineHeight && lineHeight !== null && Math.abs(design.style.lineHeight - lineHeight) > 1) {
    out['line-height'] = { design: `${round(design.style.lineHeight)}px`, page: page.style.lineHeight };
  }
  const letter = px(page.style.letterSpacing) ?? 0;
  if (Math.abs((design.style.letterSpacing ?? 0) - letter) > 0.2) {
    out['letter-spacing'] = { design: `${round(design.style.letterSpacing ?? 0)}px`, page: page.style.letterSpacing };
  }
  const theirs = parseColor(page.style.color);
  if (design.style.color && theirs && deltaE(design.style.color, theirs) >= SAME_COLOR) {
    out.color = { design: colorCss(design.style.color), page: page.style.color };
  }
  return out;
}

/**
 * Разный шаг: у элементов подряд в одной колонке сдвиг растёт на одно и то же число.
 *
 * Навигация подвала на мобильном: в макете шаг ссылок 40, на странице 32. Сверка давала
 * «−8, −16, −24 … −60» у каждой ссылки, а причина — одна: не тот отступ между пунктами. Здесь
 * такие серии ищутся явно: соседи по колонке (одна левая граница в макете), шаг в макете
 * постоянный, шаг на странице постоянный, и они различаются.
 */
export function findStepDrift(pairs, { tolerance = 2, minRun = 3 } = {}) {
  const columns = new Map();
  for (const pair of pairs) {
    const key = Math.round(pair.design.box.x / 4);
    columns.set(key, [...(columns.get(key) || []), pair]);
  }
  const out = [];
  for (const list of columns.values()) {
    if (list.length < minRun) continue;
    list.sort((a, b) => a.design.box.y - b.design.box.y);
    let run = [list[0]];
    const flush = () => {
      if (run.length >= minRun) {
        const designStep = round(run[1].design.box.y - run[0].design.box.y);
        const pageStep = round(run[1].page.box.y - run[0].page.box.y);
        if (Math.abs(designStep - pageStep) > tolerance / 2) {
          const delta = round(pageStep - designStep);
          out.push({
            stepDrift: `${run.length} элементов подряд: шаг в макете ${designStep}px, на странице ${pageStep}px`,
            hint: `Сдвиг копится на ${delta}px с каждым элементом: чинится отступ между ними (gap, margin, padding пункта), а не положение каждого.`,
            designStep,
            pageStep,
            delta,
            sample: run.slice(0, 3).map((pair) => ({ text: clip(pair.design.text, 40), node: pair.design.id, selector: pair.page.selector })),
            nodes: run.map((pair) => pair.design.id),
            severity: Math.abs(delta) * run.length,
          });
        }
      }
    };
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      const designStep = cur.design.box.y - prev.design.box.y;
      const pageStep = cur.page.box.y - prev.page.box.y;
      if (run.length >= 2) {
        const first = run[1].design.box.y - run[0].design.box.y;
        const firstPage = run[1].page.box.y - run[0].page.box.y;
        if (Math.abs(designStep - first) <= 1 && Math.abs(pageStep - firstPage) <= 1) {
          run.push(cur);
          continue;
        }
        flush();
        run = [prev, cur];
        continue;
      }
      run.push(cur);
    }
    flush();
  }
  return out;
}

/**
 * Боксы, которые сравниваются у пары текстов.
 *
 * Текст внутри кнопки сравнивается рамкой кнопки с кнопкой страницы. Текст фиксированной ширины
 * (растянутый в макете на блок) — по той кромке, к которой он выровнен, а разница ширины уходит
 * в textBox: ширина текстового слоя — свойство макета, а не вёрстки. Число строк такой текст
 * всё равно проверяет — через lines.
 */
export function pairBoxes(pair, lift = 0) {
  const d = pair.design;
  const p = pair.page;
  const up = (box) => (lift && d.inLead ? { ...box, y: box.y - lift } : box);
  if (d.frame && p.control) return { design: up(d.frame.box), page: p.control.box, frame: d.frame.id, selector: p.control.selector };
  const fixed = d.autoResize === 'NONE' || d.autoResize === 'HEIGHT';
  const aligned = d.align === 'CENTER' || d.align === 'RIGHT';
  return { design: up(d.box), page: p.box, ...(fixed || aligned ? { loose: d.align || 'LEFT' } : {}) };
}

/** Сдвиг пары: для растянутого текста x — по кромке выравнивания, ширина — отдельно. */
function pairShift(boxes) {
  const { design: a, page: b, loose } = boxes;
  const edge = (box) => (loose === 'CENTER' ? box.x + box.w / 2 : loose === 'RIGHT' ? box.x + box.w : box.x);
  return {
    x: round(loose ? edge(b) - edge(a) : b.x - a.x),
    y: round(b.y - a.y),
    w: round(b.w - a.w),
    h: round(b.h - a.h),
  };
}

/**
 * Подтвердилось ли, что контент кадра начинается не с нуля.
 *
 * Кандидат из designItems (lead) принимается, только если большинство текстов внутри него
 * на странице выше ровно на его отступ: иначе это обычное расхождение, и молча вычитать нельзя.
 */
export function confirmLead(design, pairs, { tolerance = 2 } = {}) {
  if (!design.lead) return null;
  const inside = pairs.filter((pair) => pair.design.inLead);
  if (inside.length < 3) return null;
  const agree = inside.filter((pair) => Math.abs(pair.page.box.y - pair.design.box.y + design.lead.y) <= Math.max(tolerance, 4));
  return agree.length / inside.length >= 0.6 ? design.lead : null;
}

/**
 * Состояния, которых нет на странице: контейнер макета, чьи тексты не нашлись все до одного.
 *
 * Раскрытые «Партнёры» на мобильном — это не пять разных пропаж, а одно состояние, которое на
 * странице открывается действием. Берётся самый верхний такой контейнер.
 */
export function absentBlocks(design, onlyDesign, pairs, { min = 3 } = {}) {
  const missing = new Map();
  const present = new Set();
  for (const item of onlyDesign) for (const id of item.ancestors || []) missing.set(id, [...(missing.get(id) || []), item]);
  for (const pair of pairs) for (const id of pair.design.ancestors || []) present.add(id);
  const candidates = new Map([...missing].filter(([id, list]) => list.length >= min && !present.has(id)));
  /* ancestors идут от текста вверх: у верхнего кандидата выше него других кандидатов нет. */
  const topmost = [...candidates].filter(([id, list]) => {
    const chain = list[0].ancestors;
    return !chain.slice(chain.indexOf(id) + 1).some((up) => candidates.has(up));
  });
  return topmost.map(([id, list]) => ({ node: id, name: design.names?.[id], texts: list.length, sample: list.slice(0, 3).map((item) => clip(item.text, 40)) }));
}

/**
 * Разный контент выше сдвинутого блока.
 *
 * Мобильный макет с заглушками и другим порядком картинок давал «shiftedBlock −250px», хотя
 * вёрстка верна: выше блока в макете и на странице просто разные тексты. Смотрится полоса между
 * последним несдвинутым текстом и началом блока — с обеих сторон.
 */
export function contentAbove(block, pairs, onlyDesign, onlyPage) {
  const members = new Set(block);
  const top = Math.min(...block.map((pair) => pair.design.box.y));
  const topPage = Math.min(...block.map((pair) => pair.page.box.y));
  const above = pairs.filter((pair) => !members.has(pair) && pair.design.box.y < top);
  const anchor = above.length ? Math.max(...above.map((pair) => pair.design.box.y)) : -Infinity;
  const anchorPage = above.length ? Math.max(...above.map((pair) => pair.page.box.y)) : -Infinity;
  const design = onlyDesign.filter((item) => item.box.y > anchor && item.box.y < top);
  const page = onlyPage.filter((item) => item.box.y > anchorPage && item.box.y < topPage);
  if (!design.length && !page.length) return null;
  return {
    ...(design.length ? { onlyDesign: design.slice(0, 3).map((item) => ({ node: item.id, text: clip(item.text, 40) })) } : {}),
    ...(page.length ? { onlyPage: page.slice(0, 3).map((item) => ({ selector: item.selector, text: clip(item.text, 40) })) } : {}),
  };
}

export function compareGeometry(design, page, { tolerance = 2 } = {}) {
  const { pairs, onlyDesign, onlyPage } = pairTexts(design.items, page.items);
  const lead = confirmLead(design, pairs, { tolerance });
  const findings = [];
  const pairOf = new Map();

  for (const pair of pairs) {
    const boxes = pairBoxes(pair, lead?.y ?? 0);
    const shift = pairShift(boxes);
    const styles = styleDiff(pair.design, pair.page);
    const worst = Math.max(Math.abs(shift.x), Math.abs(shift.y), boxes.loose ? 0 : Math.abs(shift.w));
    const lines =
      pair.design.lines && pair.page.lines && pair.design.lines !== pair.page.lines
        ? { design: pair.design.lines, page: pair.page.lines, ...(pair.page.style?.textWrap ? { textWrap: pair.page.style.textWrap } : {}) }
        : null;
    if (worst <= tolerance && !Object.keys(styles).length && !lines) continue;
    const kept = Object.fromEntries(
      Object.entries(shift).filter(([key, value]) => Math.abs(value) > tolerance && !(boxes.loose && (key === 'w' || key === 'h'))),
    );
    const finding = {
      text: clip(pair.design.text, 40),
      node: pair.design.id,
      selector: pair.page.selector,
      ...(boxes.frame ? { frame: boxes.frame, control: boxes.selector } : {}),
      ...(worst > tolerance && Object.keys(kept).length ? { shift: kept } : {}),
      ...(boxes.loose && (Math.abs(shift.w) > tolerance || Math.abs(shift.h) > tolerance)
        ? { textBox: { w: shift.w, h: shift.h, note: 'размер текстового слоя: в макете он растянут на блок, сравнивается кромка выравнивания' } }
        : {}),
      ...(lines
        ? { lines: { ...lines, note: `в макете ${lines.design} стр., на странице ${lines.page}${lines.textWrap ? ` (text-wrap: ${lines.textWrap})` : ''}` } }
        : {}),
      ...(Object.keys(styles).length ? { styles } : {}),
      severity: worst + Object.keys(styles).length * 4 + (lines ? 6 : 0),
    };
    /* Растянутый текст без других расхождений — это не находка, а свойство макета. */
    if (!finding.shift && !finding.styles && !finding.lines) continue;
    findings.push(finding);
    pairOf.set(finding, pair);
  }

  /* Разный шаг в колонке — одна находка до общего сдвига: иначе растущий сдвиг частями
     попадал бы в корзины shiftedBlock и выглядел бы как несколько разных сдвигов блока. */
  const swallowed = new Set();
  const residual = (finding) => Object.keys(finding.shift).length || finding.styles || finding.lines;
  const byNode = new Map(findings.map((finding) => [finding.node, finding]));
  const drifts = findStepDrift(pairs, { tolerance });
  for (const drift of drifts) {
    for (const node of drift.nodes) {
      const finding = byNode.get(node);
      if (!finding?.shift?.y) continue;
      delete finding.shift.y;
      finding.stepDrift = drift.pageStep - drift.designStep;
      if (!residual(finding)) swallowed.add(finding);
    }
  }
  const stepFindings = drifts.map(({ nodes, ...drift }) => drift);

  /*
   * Общий сдвиг блока — одна находка, а не двадцать.
   *
   * Если страница короче макета, весь подвал уезжает вверх на одно и то же число, и список
   * расхождений превращается в двадцать одинаковых строк, за которыми не видно настоящих правок.
   */
  const shifted = new Map();
  for (const finding of findings) {
    const y = finding.shift?.y;
    if (y === undefined || Math.abs(y) <= 20) continue;
    const bucket = Math.round(y / 10) * 10;
    shifted.set(bucket, [...(shifted.get(bucket) || []), finding]);
  }
  const grouped = [];
  for (const [bucket, list] of shifted) {
    if (list.length < 3) continue;
    const cause = contentAbove(list.map((finding) => pairOf.get(finding)), pairs, onlyDesign, onlyPage);
    grouped.push({
      shiftedBlock: `${list.length} элементов смещены по вертикали примерно на ${bucket}px`,
      hint: cause
        ? 'Выше блока контент в макете и на странице разный (above): сдвиг, скорее всего, от него, а не от вёрстки. Сверьте контент, прежде чем чинить отступы.'
        : 'Обычно это разная высота блока выше, а не ошибка в каждом элементе: сначала сверьте её.',
      ...(cause ? { cause: 'content', above: cause } : {}),
      sample: list.slice(0, 3).map((finding) => ({ text: finding.text, node: finding.node, selector: finding.selector })),
      severity: Math.abs(bucket),
    });
    /* У самих элементов остаётся только их собственное расхождение: общий сдвиг уже назван. */
    for (const finding of list) {
      delete finding.shift.y;
      finding.blockShift = bucket;
      if (!residual(finding)) swallowed.add(finding);
      else finding.severity -= Math.abs(bucket);
    }
  }
  for (const finding of findings) if (finding.shift && !Object.keys(finding.shift).length) delete finding.shift;

  const rest = findings.filter((finding) => !swallowed.has(finding));
  const all = [...stepFindings, ...grouped, ...rest].sort((a, b) => b.severity - a.severity);
  const absent = absentBlocks(design, onlyDesign, pairs);
  return {
    matched: pairs.length,
    findings: all,
    ...(lead ? { lead } : {}),
    onlyDesign: onlyDesign.slice(0, 15).map((item) => ({ node: item.id, text: clip(item.text, 40) })),
    onlyPage: onlyPage.slice(0, 15).map((item) => ({ selector: item.selector, text: clip(item.text, 40) })),
    ...(absent.length ? { onlyDesignBlocks: absent.slice(0, 5) } : {}),
  };
}


/* Показаны не все находки. Одного числа found мало: модель читает список и считает его полным,
   а расхождение за пределом limit остаётся в вёрстке непроверенным. */
const truncatedNote = (found, limit) =>
  `Показано ${limit} из ${found}. Остальные не проверены — повторите с limit: ${found}, прежде чем считать сверку законченной.`;

/** Попиксельно: рендер узла против снимка страницы, обрезанных по общей области. */
async function comparePixels({ figmaRef, page, selector, dir, name, threshold, client, editor }) {
  const render = await exportRender([figmaRef], { client, editor, scale: 1 });
  const design = render.renders[0];
  if (!design?.image) return { error: design?.error || 'макет не отрисовался' };

  const shot = await takeScreenshot(page, { runId: path.basename(dir), name: `${name}-page`, selector, fullPage: !selector });
  const designMeta = await sharp(design.image.path).metadata();
  const pageMeta = await sharp(shot.path).metadata();
  const width = Math.min(designMeta.width, pageMeta.width);
  const height = Math.min(designMeta.height, pageMeta.height);

  const cropA = path.join(dir, `${name}-design.crop.png`);
  const cropB = path.join(dir, `${name}-page.crop.png`);
  await sharp(design.image.path).extract({ left: 0, top: 0, width, height }).png().toFile(cropA);
  await sharp(shot.path).extract({ left: 0, top: 0, width, height }).png().toFile(cropB);

  const diffFile = path.join(dir, `${name}.diff.png`);
  const result = await odiffCompare(cropA, cropB, diffFile, { threshold: 0.1, antialiasing: true, outputDiffMask: false });
  const diffPercentage = result.match ? 0 : Number(result.diffPercentage || 0);
  if (result.match) await fs.rm(diffFile, { force: true });

  return {
    match: diffPercentage <= threshold,
    diffPercentage: round(diffPercentage, 3),
    size: {
      design: `${designMeta.width}x${designMeta.height}`,
      page: `${pageMeta.width}x${pageMeta.height}`,
      compared: `${width}x${height}`,
    },
    design: artifactRef(design.image.path),
    page: artifactRef(shot.path),
    ...(result.match ? {} : { diff: artifactRef(diffFile) }),
  };
}

export async function compareWithDesign({
  figmaRef,
  snapshot,
  rootId,
  page,
  selector = null,
  mode = 'both',
  sections = false,
  tolerance = 2,
  threshold = 0.1,
  limit = 30,
  client,
  editor,
  widenedBy = 0,
}) {
  const runId = newRunId('figma-compare');
  const dir = await runDir(runId);
  const name = slug(snapshot.nodes[rootId].name || 'frame') || 'frame';

  const design = designItems(snapshot, rootId);
  const out = {
    runId,
    ref: figmaRef,
    frame: design.size,
    ...(design.chrome
      ? {
          chromeNote: t({
            ru: `В начале кадра нарисована строка браузера «${design.chrome.name}» (${design.chrome.node}) высотой ${round(design.chrome.height)}px: координаты макета считаются от её низа, а закреплённые (fixed) узлы из смысловой сверки исключены.`,
            en: `A browser bar «${design.chrome.name}» (${design.chrome.node}) ${round(design.chrome.height)}px tall is drawn at the top of the frame: design coordinates count from its bottom, and pinned (fixed) nodes are left out of the semantic comparison.`,
          }),
        }
      : {}),
  };

  /* Секциям нужны пары текстов для сдвига — то есть тот же обход страницы, что и semantic. */
  let probed = null;
  if (mode !== 'pixel' || sections) {
    probed = await page.evaluate(probePage, selector);
    if (probed.error) throw new Error(probed.error);
  }

  if (mode !== 'pixel') {
    const semantic = compareGeometry(design, probed, { tolerance });
    out.page = probed.origin;
    out.semantic = {
      matched: semantic.matched,
      found: semantic.findings.length,
      findings: semantic.findings.slice(0, limit).map(({ severity, ...rest }) => rest),
      ...(semantic.findings.length > limit ? { note: truncatedNote(semantic.findings.length, limit) } : {}),
      onlyDesign: semantic.onlyDesign,
      onlyPage: semantic.onlyPage,
      ...(semantic.onlyDesignBlocks
        ? {
            onlyDesignBlocks: semantic.onlyDesignBlocks,
            onlyDesignBlocksNote: t({
              ru: 'Контейнеры макета, ни один текст которых не нашёлся на странице. Похоже на состояние (раскрытый блок, вкладка, модалка), которого без действия на странице нет: откройте его через browser_act и сверьте ещё раз. Если такого состояния нет и в задаче — спросите человека.',
              en: 'Design containers none of whose texts were found on the page. Looks like a state (an expanded block, a tab, a modal) the page shows only after an action: open it with browser_act and compare again. If the task has no such state either — ask the human.',
            }),
          }
        : {}),
    };
    /* Контакты и адреса без пары — чаще заглушки одного кадра, чем ошибка вёрстки. */
    const roles = [...new Set([...semantic.onlyDesign, ...semantic.onlyPage].map((item) => textRole(item.text)).filter(Boolean))];
    if (roles.length) {
      out.contentNote = t({
        ru: `Среди несовпавших текстов есть ${roles.join(', ')}: частая причина — заглушки в одном кадре и реальные данные в другом. figma_breakpoints по кадрам этого экрана покажет contentMismatch — расхождения макета с самим собой.`,
        en: `The unmatched texts include ${roles.join(', ')}: a common cause is placeholders in one frame and real data in another. figma_breakpoints over this screen's frames shows contentMismatch — the design disagreeing with itself.`,
      });
    }
    if (semantic.lead) {
      out.originNote = t({
        ru: `Кадр начинается не с нуля: «${semantic.lead.name}» (${semantic.lead.node}) стоит на y=${semantic.lead.y}, а его тексты на странице выше ровно на столько. Поправка учтена: координаты внутри него считаются от его верха.`,
        en: `The frame does not start at zero: «${semantic.lead.name}» (${semantic.lead.node}) sits at y=${semantic.lead.y}, and its texts on the page are higher by exactly that. The correction is applied: coordinates inside it count from its top.`,
      });
    }
    const paint = comparePaint(design, probed, { tolerance });
    out.paint = {
      boxes: paint.boxes,
      matched: paint.matched,
      found: paint.findings.length,
      findings: paint.findings.slice(0, limit),
      ...(paint.findings.length > limit ? { note: truncatedNote(paint.findings.length, limit) } : {}),
      /*
       * Две корзины вместо одной кучи.
       *
       * shifted — измеренное: узел на странице есть, видно, куда уехал, и это работа.
       * notFound — отсутствие, и что за ним стоит, эта сверка сказать не может: она ходит по
       * элементам, а псевдоэлемента и внутренности SVG среди них нет. Раньше обе причины лежали
       * вперемешку под одной общей оговоркой, и разделять их приходилось глазами.
       */
      ...(paint.shifted.length || paint.notFound.length
        ? {
            unmatched: {
              total: paint.shifted.length + paint.notFound.length,
              ...(paint.shifted.length
                ? {
                    shifted: {
                      count: paint.shifted.length,
                      ...(paint.blocks.length ? { blocks: paint.blocks } : {}),
                      items: paint.shifted.slice(0, 5),
                    },
                  }
                : {}),
              ...(paint.notFound.length
                ? {
                    notFound: {
                      count: paint.notFound.length,
                      items: paint.notFound.slice(0, 10),
                      note: t({
                        ru: 'Этих узлов на странице не нашлось нигде — ни по месту, ни по размеру. Причину сверка не различает: это может быть псевдоэлемент или внутренность SVG (их она не видит вовсе — проверяйте computed_styles с pseudo), а может быть и не свёрстанный блок.',
                        en: 'These nodes were not found anywhere on the page — neither by position nor by size. This check cannot tell the reason apart: it may be a pseudo-element or the inside of an SVG (which it does not see at all — check those with computed_styles and pseudo), or a block that simply was not built.',
                      }),
                    },
                  }
                : {}),
            },
          }
        : {}),
    };
    if (Math.abs((design.size.w ?? 0) - (probed.origin.w ?? 0)) > 2) {
      out.widthNote = t({
        ru: `Ширина кадра ${round(design.size.w)}px, а сравниваемого блока на странице ${round(probed.origin.w)}px: смещения по x читайте с поправкой на это.`,
        en: `The frame is ${round(design.size.w)}px wide, the compared block on the page ${round(probed.origin.w)}px: read the x offsets with that correction in mind.`,
      });
    }
    /* Кадр со сдвинутым контентом выше страницы на этот сдвиг: разница высот от него — не расхождение. */
    const frameH = (design.size.h ?? 0) - (semantic.lead?.y ?? 0);
    if (Math.abs(frameH - (probed.origin.h ?? 0)) > 8) {
      out.heightNote = t({
        ru: `Высота кадра ${round(frameH)}px${semantic.lead ? ' (за вычетом сдвига контента)' : ''}, страницы ${round(probed.origin.h)}px — разница ${round((probed.origin.h ?? 0) - frameH)}px. Пока она не сойдётся, всё, что ниже расхождения, будет смещено целиком.`,
        en: `The frame is ${round(frameH)}px tall${semantic.lead ? ' (less the content offset)' : ''}, the page ${round(probed.origin.h)}px — a difference of ${round((probed.origin.h ?? 0) - frameH)}px. Until that closes, everything below the discrepancy is shifted as a whole.`,
      });
    }
    /* Гуттер полосы прокрутки: в своей сессии окно уже расширено на него, в чужой — сказать, откуда разница. */
    const gutter = await page.evaluate(scrollbarGutter).catch(() => 0);
    if (widenedBy > 0) {
      out.scrollbarNote = t({
        ru: `Полоса прокрутки страницы отнимает ${widenedBy}px (свой ::-webkit-scrollbar и scrollbar-gutter): окно расширено на неё, контент сверялся шириной кадра.`,
        en: `The page scrollbar takes ${widenedBy}px (its own ::-webkit-scrollbar and scrollbar-gutter): the window was widened by it, so the content was compared at the frame width.`,
      });
    } else if (gutter > 0) {
      out.scrollbarNote = t({
        ru: `Полоса прокрутки страницы отнимает ${gutter}px: контент на столько уже окна, и все x съезжают на половину этого. Откройте сессию с scrollbars: "overlay" (как на телефоне) или шире на ${gutter}px — либо передайте url без sessionId, стенд поправит сам.`,
        en: `The page scrollbar takes ${gutter}px: the content is that much narrower than the window, and every x shifts by half of it. Open the session with scrollbars: "overlay" (as on a phone) or ${gutter}px wider — or pass url without sessionId and the stand will correct it itself.`,
      });
    }
  }

  if (mode !== 'semantic') {
    out.pixel = await comparePixels({ figmaRef, page, selector, dir, name, threshold, client, editor });
  }

  if (sections) {
    out.sections = await compareSections({ figmaRef, snapshot, rootId, page, selector, dir, name, threshold, client, editor, design, probed });
  }

  return out;
}


/**
 * Секции кадра: видимые дочерние узлы верхнего уровня, достаточно крупные, чтобы их сравнивать.
 *
 * Отдельная функция ради теста: разбиение считается по снимку и не требует браузера.
 */
export function frameSections(snapshot, rootId, { minSize = 40 } = {}) {
  const root = snapshot.nodes[rootId];
  if (!root?.box) return [];
  return orderedChildren(snapshot, root)
    .filter((kid) => kid.box && kid.box.w >= minSize && kid.box.h >= minSize)
    .map((kid) => ({
      node: kid.id,
      name: clip(kid.name || '', 40),
      box: { x: round(kid.box.x - root.box.x), y: round(kid.box.y - root.box.y), w: round(kid.box.w), h: round(kid.box.h) },
    }));
}

/**
 * Сдвиг секции на странице относительно макета — по совпавшим текстам внутри неё.
 *
 * Медиана, а не среднее: один перенесённый заголовок не должен утянуть всю секцию. Пустой
 * список пар — сдвиг нулевой, и об этом секция скажет полем texts: 0.
 */
export function sectionShift(section, pairs) {
  const inside = pairs.filter(
    (pair) => pair.design.box.y >= section.box.y - 1 && pair.design.box.y + pair.design.box.h <= section.box.y + section.box.h + 1,
  );
  return {
    texts: inside.length,
    shift: {
      x: round(median(inside.map((pair) => pair.page.box.x - pair.design.box.x))),
      y: round(median(inside.map((pair) => pair.page.box.y - pair.design.box.y))),
    },
  };
}

/** Селекторы совпавших текстов каждой секции и всех остальных: по ним ищется обёртка секции. */
export function sectionGroups(sections, pairs) {
  const inside = (section, pair) =>
    pair.design.box.y >= section.box.y - 1 && pair.design.box.y + pair.design.box.h <= section.box.y + section.box.h + 1;
  return sections.map((section) => ({
    own: pairs.filter((pair) => inside(section, pair)).map((pair) => pair.page.selector),
    other: pairs.filter((pair) => !inside(section, pair)).map((pair) => pair.page.selector),
  }));
}

/** В странице: высота общего предка текстов секции, не захватывающего тексты других секций. */
export function pageSectionHeights({ root, groups }) {
  const top = root ? document.querySelector(root) : document.body;
  const find = (list) => list.map((sel) => document.querySelector(sel)).filter(Boolean);
  return groups.map(({ own, other }) => {
    const mine = find(own);
    if (!mine.length) return null;
    const theirs = find(other).filter((el) => !mine.includes(el));
    let box = mine[0];
    while (box && !mine.every((el) => box.contains(el))) box = box.parentElement;
    if (!box || box === top || !top.contains(box) || theirs.some((el) => box.contains(el))) return null;
    /* Подняться до самой широкой обёртки, пока в неё не попадают чужие тексты. */
    while (box.parentElement && box.parentElement !== top && !theirs.some((el) => box.parentElement.contains(el))) box = box.parentElement;
    return box.getBoundingClientRect().height;
  });
}

/**
 * Попиксельно по секциям, а не по кадру целиком.
 *
 * На длинной странице с подменённым шрифтом сдвиг копится по секциям, и общий diff показывает
 * четверть страницы при верной вёрстке — поэтому pixel не запускали вовсе, и чёрные иконки с
 * уехавшим рядом ушли в сдачу. Здесь каждая секция кадра сравнивается со своим куском страницы,
 * взятым с поправкой на сдвиг её же текстов: накопленное смещение секцию не трогает, а внутри
 * неё разница — настоящая.
 */
async function compareSections({ figmaRef, snapshot, rootId, page, selector, dir, name, threshold, client, editor, design, probed }) {
  const render = await exportRender([figmaRef], { client, editor, scale: 1 });
  const image = render.renders[0];
  if (!image?.image) return { error: image?.error || 'макет не отрисовался' };

  const meta = await sharp(image.image.path).metadata();
  const pageOrigin = await page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : document.body;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      docW: document.documentElement.scrollWidth,
      docH: document.documentElement.scrollHeight,
    };
  }, selector);
  const { pairs } = pairTexts(design.items, probed.items);
  const frame = frameSections(snapshot, rootId);
  const heights = await page.evaluate(pageSectionHeights, { root: selector, groups: sectionGroups(frame, pairs) }).catch(() => []);

  const sections = [];
  for (const [index, section] of frame.entries()) {
    const { texts, shift } = sectionShift(section, pairs);
    const pageH = heights[index];
    const heightOf = pageH == null ? { design: section.box.h, page: null } : { design: section.box.h, page: round(pageH), delta: round(pageH - section.box.h) };
    const left = Math.min(Math.max(0, section.box.x), meta.width - 1);
    const top = Math.min(Math.max(0, section.box.y), meta.height - 1);
    const width = Math.min(section.box.w, meta.width - left);
    const height = Math.min(section.box.h, meta.height - top);
    if (width <= 0 || height <= 0) continue;

    const stem = `${name}-section-${String(index + 1).padStart(2, '0')}`;
    const designCrop = path.join(dir, `${stem}-design.png`);
    await sharp(image.image.path).extract({ left, top, width, height }).png().toFile(designCrop);

    /* Снимок страницы — в координатах документа: fullPage делает clip абсолютным. */
    const clipBox = {
      x: Math.max(0, Math.round(pageOrigin.x + section.box.x + shift.x)),
      y: Math.max(0, Math.round(pageOrigin.y + section.box.y + shift.y)),
    };
    clipBox.width = Math.max(1, Math.min(width, pageOrigin.docW - clipBox.x));
    clipBox.height = Math.max(1, Math.min(height, pageOrigin.docH - clipBox.y));
    const pageCrop = path.join(dir, `${stem}-page.png`);
    await fs.writeFile(pageCrop, await page.screenshot({ fullPage: true, clip: clipBox, type: 'png' }));

    /* Общая область: у края документа кусок страницы бывает короче куска макета. */
    const pageMeta = await sharp(pageCrop).metadata();
    const cw = Math.min(width, pageMeta.width);
    const ch = Math.min(height, pageMeta.height);
    if (cw !== width || ch !== height) {
      await sharp(designCrop).extract({ left: 0, top: 0, width: cw, height: ch }).png().toFile(`${designCrop}.tmp`);
      await fs.rename(`${designCrop}.tmp`, designCrop);
    }
    if (cw !== pageMeta.width || ch !== pageMeta.height) {
      await sharp(pageCrop).extract({ left: 0, top: 0, width: cw, height: ch }).png().toFile(`${pageCrop}.tmp`);
      await fs.rename(`${pageCrop}.tmp`, pageCrop);
    }

    const diffFile = path.join(dir, `${stem}.diff.png`);
    const result = await odiffCompare(designCrop, pageCrop, diffFile, { threshold: 0.1, antialiasing: true, outputDiffMask: false });
    const diffPercentage = result.match ? 0 : Number(result.diffPercentage || 0);
    if (result.match) await fs.rm(diffFile, { force: true });

    sections.push({
      node: section.node,
      name: section.name,
      box: section.box,
      shift,
      texts,
      height: heightOf,
      diffPercentage: round(diffPercentage, 3),
      match: diffPercentage <= threshold,
      compared: `${cw}x${ch}`,
      design: artifactRef(designCrop),
      page: artifactRef(pageCrop),
      ...(result.match ? {} : { diff: artifactRef(diffFile) }),
    });
  }

  /* Высоты — в порядке секций сверху вниз: так видно, с какой секции начинается разница. */
  const sectionHeights = sections.map((section) => ({ name: section.name, node: section.node, ...section.height }));
  sections.sort((a, b) => b.diffPercentage - a.diffPercentage);
  return {
    count: sections.length,
    matched: sections.filter((section) => section.match).length,
    sectionHeights,
    sectionHeightsNote: t({
      ru: 'Высота секции на странице — у общего предка её текстов, в который не попадают тексты соседних секций; page: null — такого предка нет (секция не обёрнута своим элементом или в ней нет совпавших текстов).',
      en: 'A section height on the page is taken from the common ancestor of its texts that holds no texts of neighbouring sections; page: null — there is no such ancestor (the section has no wrapper of its own or no matched texts).',
    }),
    sections,
    note: t({
      ru: 'Каждая секция кадра сравнена со своим куском страницы с поправкой на сдвиг её текстов (shift). Разница шрифтового рендеринга даёт единицы процентов; десятки — цвет, ряд, выравнивание, пропавший элемент: смотрите diff. texts: 0 — секцию не по чему выровнять, сдвиг взят нулевым.',
      en: 'Every section of the frame is compared with its own piece of the page, corrected by the shift of its texts (shift). Font rendering differences give a few percent; tens mean color, a row, alignment or a missing element: look at the diff. texts: 0 — nothing to align the section by, the shift was taken as zero.',
    }),
  };
}
