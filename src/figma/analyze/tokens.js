/**
 * Токены: что из макета становится переменной, а что остаётся числом на месте.
 *
 * Два уровня, и путать их нельзя:
 *
 *   - глобальные — палитра, типографика, шкалы отступов и радиусов, тени, длительности. Значение
 *     становится токеном, если оно привязано к переменной Figma, встречается не один раз или уже
 *     есть в проекте. Единственный отступ в 37px токеном не становится;
 *   - переменные компонента — то, что меняется по варианту, состоянию или ширине: .btn{--btn-bg}
 *     и .btn--ghost{--btn-bg:…}. Они берутся из осей, найденных разбором компонентов.
 *
 * Цвета сводятся по ΔE: #5e574d и #5f574d — один токен, а не два. Отдельно считается, сколько раз
 * то же значение вбито литералом при существующей переменной Figma: на «Земском докторе» цвет
 * Color 3 привязан в 56 местах и вбит руками ещё в 27 — это и есть работа, которую выносят в токен.
 */
import { colorCss, paintCss, round } from '../css.js';
import { bemName, deltaE, SAME_COLOR, SIMILAR_COLOR, textStyleKey, visibleNodes } from './common.js';
import { matchColor, matchLength } from '../project.js';
import { findComponents } from './components.js';
import { compareBreakpoints, sameScreen } from './breakpoints.js';

const WEIGHTS = { 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };

function bump(map, key, ref, extra = {}) {
  if (!map.has(key)) map.set(key, { key, uses: 0, refs: [], ...extra });
  const entry = map.get(key);
  entry.uses += 1;
  if (entry.refs.length < 5) entry.refs.push(ref);
  return entry;
}

function addColor(map, color, kind, ref, figmaName) {
  if (!color) return;
  const entry = bump(map, colorCss(color), ref, { color, kinds: {}, figma: new Set(), unbound: 0 });
  entry.kinds[kind] = (entry.kinds[kind] || 0) + 1;
  if (figmaName) entry.figma.add(figmaName);
  else entry.unbound += 1;
}

const shadowCss = (effect) =>
  `${effect.type === 'inner' ? 'inset ' : ''}${round(effect.x)}px ${round(effect.y)}px ${round(effect.blur)}px${
    effect.spread ? ` ${round(effect.spread)}px` : ''
  } ${colorCss(effect.color)}`;

const easingCss = (easing) => {
  if (easing?.easingFunctionCubicBezier) {
    const { x1, y1, x2, y2 } = easing.easingFunctionCubicBezier;
    return `cubic-bezier(${round(x1, 3)}, ${round(y1, 3)}, ${round(x2, 3)}, ${round(y2, 3)})`;
  }
  const map = { EASE_IN: 'ease-in', EASE_OUT: 'ease-out', EASE_IN_AND_OUT: 'ease-in-out', LINEAR: 'linear' };
  return map[easing?.type] || String(easing?.type || '').toLowerCase().replace(/_/g, '-');
};

/** Сводит цвета, которых глаз не различает, в один токен и помечает просто похожие. */
function mergeColors(map) {
  const sorted = [...map.values()].sort((a, b) => b.uses - a.uses);
  const kept = [];
  for (const entry of sorted) {
    const near = kept.find((other) => deltaE(other.color, entry.color) < SAME_COLOR);
    if (near) {
      near.uses += entry.uses;
      near.unbound += entry.unbound;
      near.merged = [...(near.merged || []), entry.key];
      for (const [kind, count] of Object.entries(entry.kinds)) near.kinds[kind] = (near.kinds[kind] || 0) + count;
      for (const name of entry.figma) near.figma.add(name);
      continue;
    }
    kept.push({ ...entry, merged: [] });
  }
  for (const entry of kept) {
    entry.similar = kept
      .filter((other) => other !== entry && deltaE(other.color, entry.color) < SIMILAR_COLOR)
      .map((other) => other.key);
  }
  return kept;
}

function colorName(entry, counters) {
  const [figma] = entry.figma;
  if (figma) return `--${bemName(figma)}`;
  const kind = Object.entries(entry.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] || 'color';
  const prefix = { text: 'text', bg: 'bg', border: 'line', shadow: 'shadow' }[kind] || 'color';
  counters[prefix] = (counters[prefix] || 0) + 1;
  return `--color-${prefix}-${counters[prefix]}`;
}

/** Шаг сетки отступов: 8 или 4, если по нему ложится большинство значений. */
function gridStep(values) {
  for (const step of [8, 4, 5, 10]) {
    if (values.length && values.filter((value) => value % step === 0).length / values.length >= 0.8) return step;
  }
  return null;
}

function withProject(entry, project, kind) {
  if (!project) return entry;
  if (kind === 'color') {
    const { exact, similar, selectors, selectorCount } = matchColor(project, entry.color);
    if (exact.length) return { ...entry, project: { status: 'reuse', names: exact.slice(0, 3) } };
    /* Переменной нет, но цвет уже разложен по правилам: в проекте он есть, и второй токен лишний. */
    if (selectorCount) return { ...entry, project: { status: 'in-css', rules: selectorCount, selectors } };
    if (similar.length) return { ...entry, project: { status: 'similar', names: similar.slice(0, 3) } };
    return { ...entry, project: { status: 'new' } };
  }
  const px = parseFloat(entry.value ?? entry.key);
  if (Number.isFinite(px)) {
    const names = matchLength(project, px);
    if (names.length) return { ...entry, project: { status: 'reuse', names: names.slice(0, 3) } };
  }
  return { ...entry, project: { status: 'new' } };
}

const CSS_PROP = {
  bg: 'bg',
  color: 'color',
  radius: 'radius',
  padding: 'padding',
  gap: 'gap',
  border: 'border',
  shadow: 'shadow',
  height: 'height',
  font: 'font-size',
};

export function collectTokens(frames, { project = null, minUses = 2 } = {}) {
  const colors = new Map();
  const gradients = new Map();
  const typography = new Map();
  const spacing = new Map();
  const radii = new Map();
  const borders = new Map();
  const shadows = new Map();
  const effects = new Map();
  const durations = new Map();
  const easings = new Map();

  for (const frame of frames) {
    const variables = frame.snapshot.variables || {};
    const named = (id) => (id ? variables[id]?.name : null);

    for (const { node } of visibleNodes(frame.snapshot, frame.rootId)) {
      const ref = `${frame.ref}:${node.id}`;
      const kind = node.type === 'TEXT' ? 'text' : 'bg';

      (node.fills || []).forEach((paint, index) => {
        const figma = named(paint.vars?.color) || named(node.vars?.fills?.[index]) || node.styles?.fill;
        if (paint.kind === 'solid') addColor(colors, paint.color, kind, ref, figma);
        else if (paint.kind !== 'image' && node.box) bump(gradients, paintCss(paint, node.box), ref, { figma });
      });
      (node.strokes || []).forEach((paint, index) => {
        if (paint.kind === 'solid') {
          addColor(colors, paint.color, 'border', ref, named(paint.vars?.color) || named(node.vars?.strokes?.[index]) || node.styles?.stroke);
        }
      });
      if (node.stroke?.weight) bump(borders, `${round(node.stroke.weight)}px`, ref);

      for (const effect of node.effects || []) {
        if (effect.color) addColor(colors, effect.color, 'shadow', ref, node.styles?.effect);
        if (effect.type === 'drop' || effect.type === 'inner') bump(shadows, shadowCss(effect), ref, { figma: node.styles?.effect });
        /* Радиус размытия Figma вдвое больше того, что понимает blur(). */
        if (effect.type === 'blur') bump(effects, `filter: blur(${round(effect.blur / 2)}px)`, ref);
        if (effect.type === 'backdrop') bump(effects, `backdrop-filter: blur(${round(effect.blur / 2)}px)`, ref);
      }
      if (node.blend) bump(effects, `mix-blend-mode: ${node.blend.toLowerCase().replace(/_/g, '-')}`, ref);
      for (const paint of node.fills || []) {
        if (paint.kind === 'image' && paint.opacity != null && paint.opacity < 1) bump(effects, `image-fill opacity: ${round(paint.opacity)}`, ref);
      }

      if (node.radius) for (const radius of [].concat(node.radius)) if (radius) bump(radii, `${round(radius)}px`, ref);

      if (node.layout) {
        for (const value of [node.layout.gap, node.layout.crossGap, ...(node.layout.padding || [])]) {
          if (value) bump(spacing, `${round(value)}px`, ref);
        }
      }

      if (node.type === 'TEXT' && node.text?.style) {
        const style = node.text.style;
        bump(typography, textStyleKey(style), ref, { style, figma: node.styles?.text });
      }

      for (const interaction of node.interactions || []) {
        for (const action of interaction.actions || []) {
          const transition = action.transition;
          if (transition?.duration) bump(durations, `${Math.round(transition.duration * 1000)}ms`, ref);
          if (transition?.easing) bump(easings, easingCss(transition.easing), ref);
        }
      }
    }
  }

  const counters = {};
  const colorTokens = mergeColors(colors)
    .filter((entry) => entry.uses >= minUses || entry.figma.size)
    .map((entry) => {
      const base = {
        name: colorName(entry, counters),
        value: entry.key,
        uses: entry.uses,
        kinds: entry.kinds,
        ...(entry.figma.size ? { figma: [...entry.figma] } : {}),
        ...(entry.figma.size && entry.unbound ? { unbound: entry.unbound } : {}),
        ...(entry.merged.length ? { merged: entry.merged } : {}),
        ...(entry.similar.length ? { similar: entry.similar } : {}),
        refs: entry.refs,
        color: entry.color,
      };
      const result = withProject(base, project, 'color');
      delete result.color;
      return result;
    });

  const scale = (map, prefix) =>
    [...map.values()]
      .filter((entry) => entry.uses >= minUses)
      .sort((a, b) => parseFloat(a.key) - parseFloat(b.key))
      .map((entry) => withProject({ name: `--${prefix}-${parseFloat(entry.key)}`, value: entry.key, uses: entry.uses, refs: entry.refs }, project, 'length'));

  const typographyTokens = [...typography.values()]
    .filter((entry) => entry.uses >= minUses || entry.figma)
    .sort((a, b) => (b.style.size ?? 0) - (a.style.size ?? 0))
    .map((entry) => {
      const style = entry.style;
      const weight = WEIGHTS[style.weight] || style.weight || '';
      const lineHeight =
        style.lineHeight?.unit === 'px'
          ? `${style.lineHeight.value}px`
          : style.lineHeight?.unit === '%'
            ? round(style.lineHeight.value / 100, 3)
            : 'normal';
      return {
        name: entry.figma ? `--text-${bemName(entry.figma)}` : `--text-${round(style.size ?? 0)}-${weight}`,
        font: `${style.family} ${round(style.size ?? 0)}px/${style.weight ?? ''}`,
        lineHeight,
        ...(style.letterSpacing ? { letterSpacing: `${style.letterSpacing}px` } : {}),
        ...(style.case ? { textTransform: style.case.toLowerCase() } : {}),
        ...(entry.figma ? { figma: entry.figma } : {}),
        uses: entry.uses,
        refs: entry.refs,
      };
    });

  const spacingValues = [...spacing.values()].filter((entry) => entry.uses >= minUses).map((entry) => parseFloat(entry.key));

  /* Переменные компонентов — то, что меняется по варианту: их оси уже найдены разбором компонентов. */
  const componentVars = findComponents(frames, { project })
    .clusters.filter((cluster) => cluster.variants.length > 1)
    .slice(0, 20)
    .map((cluster) => ({
      block: cluster.block,
      role: cluster.role,
      vars: cluster.variants
        .flatMap((variant) => Object.keys(variant.differs || {}))
        /* Высота переменной темы не бывает: у раскрытой карточки её задаёт содержимое. */
        .filter((axis) => axis !== 'height')
        .filter((axis, index, list) => list.indexOf(axis) === index)
        .map((axis) => ({
          name: `--${cluster.block}-${CSS_PROP[axis] || axis}`,
          base: cluster.base[axis],
          byModifier: Object.fromEntries(
            cluster.variants.filter((variant) => variant.differs?.[axis]).map((variant) => [`${cluster.block}--${variant.modifier}`, variant.differs[axis]]),
          ),
        })),
    }))
    .filter((entry) => entry.vars.length);

  /* Значения, меняющиеся с шириной: это тоже токены, только с двумя значениями и clamp(). */
  /* Адаптивные значения считаются только по кадрам одного экрана: страница против модалки даёт
     бодрый clamp() из высоты страницы и высоты поля. */
  let responsive = [];
  const screen = sameScreen(frames).group;
  const widths = new Set(screen.map((frame) => frame.width).filter(Boolean));
  if (screen.length > 1 && widths.size > 1) {
    const report = compareBreakpoints(screen);
    const seen = new Set();
    for (const comparison of report.comparisons) {
      for (const change of comparison.changes) {
        for (const [prop, info] of Object.entries(change.changes)) {
          if (!info.fluid || !['font-size', 'gap', 'padding', 'border-radius'].includes(prop)) continue;
          /* Разница в разы — это не «то же значение, пересчитанное под ширину», а другой блок:
             такой clamp() только выглядит убедительно. */
          const ratio = Math.max(parseFloat(info.from), parseFloat(info.to)) / Math.max(0.01, Math.min(parseFloat(info.from), parseFloat(info.to)));
          if (!Number.isFinite(ratio) || ratio > 3) continue;
          const key = `${prop}:${info.from}:${info.to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          responsive.push({ prop, label: change.label, wide: info.from, narrow: info.to, fluid: info.fluid, refs: [change.base, change.other] });
        }
      }
    }
    responsive = responsive.slice(0, 30);
  }

  return {
    colors: colorTokens,
    gradients: [...gradients.values()].filter((entry) => entry.uses >= minUses).map((entry) => ({ name: `--gradient-${bemName(entry.figma || '') || entry.uses}`, value: entry.key, uses: entry.uses, refs: entry.refs })),
    typography: typographyTokens,
    spacing: { step: gridStep(spacingValues), values: scale(spacing, 'space') },
    radii: scale(radii, 'radius'),
    borders: scale(borders, 'border'),
    shadows: [...shadows.values()].filter((entry) => entry.uses >= minUses).map((entry, index) => ({ name: `--shadow-${index + 1}`, value: entry.key, uses: entry.uses, refs: entry.refs })),
    /* Без порога minUses: единственное размытие над фотографией — не токен, но пропустить его
       значит сверстать страницу ярче и резче макета. */
    effects: [...effects.values()].map((entry) => ({ value: entry.key, uses: entry.uses, refs: entry.refs })),
    motion: {
      durations: [...durations.values()].map((entry) => ({ name: `--duration-${parseInt(entry.key, 10)}`, value: entry.key, uses: entry.uses })),
      easings: [...easings.values()].map((entry, index) => ({ name: `--ease-${index + 1}`, value: entry.key, uses: entry.uses })),
    },
    component: componentVars,
    responsive,
  };
}
