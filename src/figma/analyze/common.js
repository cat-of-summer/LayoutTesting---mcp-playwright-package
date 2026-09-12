/**
 * Общее для разбора макета: цвета, имена, обход видимых узлов.
 *
 * Разбор сравнивает то, что дизайнер делал «одинаково», а в макете это почти никогда не
 * одинаково до бита: #5e574d в одной карточке и #5f574d в соседней, 20px и 19.5px. Поэтому
 * сравнение здесь не на равенство, а на близость — цвета по ΔE в Lab, числа с допуском.
 */
import { colorCss, round } from '../css.js';
import { childNodes } from '../snapshot.js';

export const isVisible = (node) => node.visible !== false;

/** Видимые узлы поддерева в порядке обхода (родитель раньше детей). */
export function visibleNodes(snapshot, rootId) {
  const out = [];
  const visit = (node, depth) => {
    if (!node || !isVisible(node)) return;
    out.push({ node, depth });
    for (const kid of childNodes(snapshot, node)) visit(kid, depth + 1);
  };
  visit(snapshot.nodes[rootId], 0);
  return out;
}

const linear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function lab({ r, g, b }) {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * Разница цветов.
 *
 * CIE76 плюс прозрачность: rgba(190,158,111,.06) и rgba(190,158,111,.1) — это разные подложки,
 * хотя цвет один. ΔE < 2 глаз не различает — это один токен; до 5 — «похожи», повод спросить,
 * не ошибся ли дизайнер.
 */
export function deltaE(a, b) {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2, Math.abs((a.a ?? 1) - (b.a ?? 1)) * 100);
}

export const SAME_COLOR = 2;
export const SIMILAR_COLOR = 5;

/** Разбор CSS-цвета в {r,g,b,a}: hex, rgb(a). Нужен для сверки с проектом. */
export function parseColor(value) {
  const v = String(value || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((ch) => ch + ch).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? round(parseInt(hex.slice(6, 8), 16) / 255, 3) : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
  }
  if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

export const colorKey = (color) => colorCss(color);

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Имя слоя → имя класса: латиница, дефисы, без цифр в начале. «Вакансия mobile» → vakansiya-mobile. */
export function bemName(value) {
  const latin = [...String(value || '').toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('');
  const name = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return /^\d/.test(name) ? `b-${name}` : name;
}

/*
 * Имена, которые Figma ставит сама: Frame 2131329404, Group 12, Rectangle, Vector. По ним нельзя
 * назвать класс — такое имя говорит, что слой создан, а не что он значит.
 */
const GENERIC =
  /^(frame|group|rectangle|ellipse|vector|line|union|subtract|intersect|exclude|mask|slice|image|traced image|container|auto layout|layer|слой|polygon|star|text|component|instance|property \d+)(\s*[\d_.-]+)?$/i;

/** Осмысленное имя узла или null. У инстанса — имя набора компонентов, варианты отрезаются. */
export function meaningfulName(node) {
  const candidates = [node.component?.set, node.name];
  for (const raw of candidates) {
    const name = String(raw || '')
      .replace(/(^|,\s*)[\w\s]+=[^,]+/g, '')
      .split('/')
      .pop()
      .trim();
    if (!name || GENERIC.test(name) || /^\d+$/.test(name) || /^(ri|mdi|ic|icon)[:_-]/i.test(name)) continue;
    return name;
  }
  return null;
}

/** Ключ стиля текста для сравнения: без цвета, он сравнивается отдельно. */
export function textStyleKey(style = {}) {
  const lh = style.lineHeight;
  const lineHeight = lh?.unit === 'px' ? `${lh.value}px` : lh?.unit === '%' ? `${lh.value}%` : 'auto';
  return [style.family, round(style.size ?? 0, 1), style.weight, lineHeight, style.letterSpacing || 0, style.case || ''].join('|');
}

/** Основной кегль страницы — самый частый по числу символов, а не по числу слоёв. */
export function bodyTextSize(snapshot, rootId) {
  const weight = new Map();
  for (const { node } of visibleNodes(snapshot, rootId)) {
    if (node.type !== 'TEXT' || !node.text?.style?.size) continue;
    const size = round(node.text.style.size);
    weight.set(size, (weight.get(size) || 0) + (node.text.chars?.length || 0));
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 16;
}

export const within = (a, b, tolerance) => Math.abs((a ?? 0) - (b ?? 0)) <= tolerance;

/** Доля площади a, покрытая b. */
export function coverage(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0 || !a.w || !a.h) return 0;
  return (w * h) / (a.w * a.h);
}

export const contains = (outer, inner, tolerance = 1) =>
  inner.x >= outer.x - tolerance &&
  inner.y >= outer.y - tolerance &&
  inner.x + inner.w <= outer.x + outer.w + tolerance &&
  inner.y + inner.h <= outer.y + outer.h + tolerance;

/** Easing прототипа Figma → то, что пишут в CSS. */
export function easingCss(easing) {
  if (easing?.easingFunctionCubicBezier) {
    const { x1, y1, x2, y2 } = easing.easingFunctionCubicBezier;
    return `cubic-bezier(${round(x1, 3)}, ${round(y1, 3)}, ${round(x2, 3)}, ${round(y2, 3)})`;
  }
  const known = { EASE_IN: 'ease-in', EASE_OUT: 'ease-out', EASE_IN_AND_OUT: 'ease-in-out', LINEAR: 'linear' };
  return known[easing?.type] || String(easing?.type || 'ease').toLowerCase().replace(/_/g, '-');
}

export const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
