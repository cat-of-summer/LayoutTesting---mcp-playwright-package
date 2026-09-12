/**
 * Узел снимка Figma → CSS-декларации.
 *
 * Своя конвертация, а не getCSSAsync редактора: REST-канал его не отдаёт, а разбор обязан
 * выглядеть одинаково, откуда бы ни пришёл снимок. Если снимок снят через редактор и у узла есть
 * css от самой Figma, figma_inspect показывает оба — расхождение между ними само по себе находка.
 *
 * Результат — массив пар [свойство, значение], а не строка. Дальше декларации сравнивают при
 * группировке компонентов и подменяют значения токенами; разбирать строку обратно было бы
 * глупо.
 *
 * Модель узла описана в snapshot.js.
 */

export const round = (n, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
};

export function px(n) {
  const v = round(Number(n) || 0);
  return v === 0 ? '0' : `${v}px`;
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Непрозрачный цвет — hex, полупрозрачный — rgba: так его пишут руками, и так его ищут в проекте. */
export function colorCss(color) {
  if (!color) return 'transparent';
  const a = color.a ?? 1;
  if (a >= 0.999) return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${round(a, 3)})`;
}

function stopsCss(stops, place = (t) => t) {
  return stops.map((s) => `${colorCss(s.color)} ${round(place(s.pos) * 100)}%`).join(', ');
}

/**
 * Линейный градиент.
 *
 * Figma задаёт его ручками в долях рамки узла, CSS — углом и линией, длина которой зависит от
 * угла и пропорций блока. Угол из ручек без пересчёта позиций остановок врёт на любом
 * неквадратном блоке: остановки съезжают, и «тот же» градиент выглядит иначе. Поэтому каждая
 * остановка проецируется на линию CSS-градиента.
 */
export function linearGradientCss(paint, w, h) {
  const [p0, p1] = paint.handles;
  const x0 = p0.x * w;
  const y0 = p0.y * h;
  const dx = (p1.x - p0.x) * w;
  const dy = (p1.y - p0.y) * h;
  let angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  const rad = (angle * Math.PI) / 180;
  const dirX = Math.sin(rad);
  const dirY = -Math.cos(rad);
  const len = Math.abs(w * dirX) + Math.abs(h * dirY) || 1;
  const sx = w / 2 - (dirX * len) / 2;
  const sy = h / 2 - (dirY * len) / 2;
  const place = (t) => ((x0 + dx * t - sx) * dirX + (y0 + dy * t - sy) * dirY) / len;
  return `linear-gradient(${round(angle)}deg, ${stopsCss(paint.stops, place)})`;
}

/** Радиальный и ромбовидный. Поворот эллипса CSS не выражает — он теряется, это известная потеря. */
export function radialGradientCss(paint, w, h) {
  const [p0, p1, p2] = paint.handles;
  const rx = Math.hypot((p1.x - p0.x) * w, (p1.y - p0.y) * h);
  const ry = Math.hypot((p2.x - p0.x) * w, (p2.y - p0.y) * h);
  return `radial-gradient(${px(rx)} ${px(ry)} at ${round(p0.x * 100)}% ${round(p0.y * 100)}%, ${stopsCss(paint.stops)})`;
}

export function conicGradientCss(paint, w, h) {
  const [p0, p1] = paint.handles;
  let angle = (Math.atan2((p1.x - p0.x) * w, -(p1.y - p0.y) * h) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return `conic-gradient(from ${round(angle)}deg at ${round(p0.x * 100)}% ${round(p0.y * 100)}%, ${stopsCss(paint.stops)})`;
}

const IMAGE_FIT = {
  FILL: 'center / cover no-repeat',
  FIT: 'center / contain no-repeat',
  CROP: 'center / cover no-repeat',
  TILE: 'repeat',
  STRETCH: '0 0 / 100% 100% no-repeat',
};

/**
 * Один слой заливки. Картинка отдаётся псевдоадресом figma-image:<ref>: настоящий файл
 * появляется только после figma_export, и выдумывать ему путь в проекте здесь нельзя.
 */
export function paintCss(paint, box) {
  const w = box?.w || 1;
  const h = box?.h || 1;
  switch (paint?.kind) {
    case 'solid':
      return colorCss(paint.color);
    case 'linear':
      return linearGradientCss(paint, w, h);
    case 'radial':
    case 'diamond':
      return radialGradientCss(paint, w, h);
    case 'angular':
      return conicGradientCss(paint, w, h);
    case 'image':
      /* STRETCH с матрицей — это кадрирование (CROP в редакторе): процентами фона оно не
         выражается, поэтому здесь cover, а точный кадр отдаёт figma_export с kind: image. */
      return `url("figma-image:${paint.ref}") ${
        paint.scaleMode === 'STRETCH' && paint.transform ? IMAGE_FIT.CROP : IMAGE_FIT[paint.scaleMode] || IMAGE_FIT.FILL
      }`;
    default:
      return null;
  }
}

/** Заливки Figma перечислены снизу вверх, слои background в CSS — сверху вниз. */
export function backgroundValue(fills, box) {
  const layers = (fills || [])
    .map((paint) => paintCss(paint, box))
    .filter(Boolean)
    .reverse();
  if (!layers.length) return null;
  /* Сплошной цвет допустим только нижним слоем; выше него он записывается вырожденным
     градиентом, иначе объявление целиком недействительно. */
  return layers
    .map((layer, i) =>
      i < layers.length - 1 && !/gradient\(|url\(/.test(layer) ? `linear-gradient(${layer}, ${layer})` : layer,
    )
    .join(', ');
}

export function boxShorthand(values) {
  if (!values) return null;
  const [t, r, b, l] = values.map((v) => round(v || 0));
  if (!t && !r && !b && !l) return null;
  if (t === r && r === b && b === l) return px(t);
  if (t === b && r === l) return `${px(t)} ${px(r)}`;
  if (r === l) return `${px(t)} ${px(r)} ${px(b)}`;
  return `${px(t)} ${px(r)} ${px(b)} ${px(l)}`;
}

function radiusValue(radius) {
  if (!radius) return null;
  if (Array.isArray(radius)) return boxShorthand(radius);
  return px(radius);
}

const JUSTIFY = { CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
const TEXT_ALIGN = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };
const TEXT_CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };
const DECORATION = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' };
const BLEND = {
  MULTIPLY: 'multiply',
  SCREEN: 'screen',
  OVERLAY: 'overlay',
  DARKEN: 'darken',
  LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn',
  HARD_LIGHT: 'hard-light',
  SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

/** Фигуры, у которых заливка — это форма, а не фон блока. Их место — SVG из figma_export. */
const SHAPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'REGULAR_POLYGON']);

const fontFamily = (family) => (/^[A-Za-z0-9-]+$/.test(family) ? family : `"${family}"`);

function gap(add, row, column) {
  if (!row && !column) return;
  if (round(row || 0) === round(column || 0)) add('gap', px(row));
  else add('gap', `${px(row)} ${px(column)}`);
}

/**
 * Размер по одной оси.
 *
 * Figma хранит не число, а намерение: FIXED, HUG, FILL. Переписать всё в width/height значит
 * получить вёрстку, которая совпадает с макетом ровно на его ширине и ломается на любой другой.
 * Поэтому HUG не даёт размера вовсе, FILL становится flex или stretch, и только FIXED — числом.
 */
function sizeAxis(add, node, parent, flow, axis) {
  const box = node.box;
  if (!box) return;
  const prop = axis === 'h' ? 'width' : 'height';
  const value = axis === 'h' ? box.w : box.h;
  const mode = axis === 'h' ? node.item?.sizingH : node.item?.sizingV;

  if (node.type === 'TEXT') {
    const resize = node.text?.autoResize;
    if (resize === 'WIDTH_AND_HEIGHT') return;
    if (resize === 'HEIGHT' && axis === 'v') return;
  }

  if (!flow) {
    if (mode !== 'HUG') add(prop, px(value));
    return;
  }

  const layout = parent.layout;
  if (layout.mode === 'grid') {
    if (mode === 'FIXED') add(prop, px(value));
    return;
  }
  const main = (layout.mode === 'row') === (axis === 'h');
  if (mode === 'FILL') {
    if (main) {
      add('flex', '1 1 0');
      add(axis === 'h' ? 'min-width' : 'min-height', '0');
    } else {
      add('align-self', 'stretch');
    }
    return;
  }
  if (mode === 'HUG') return;
  add(prop, px(value));
  if (main) add('flex-shrink', '0');
}

function strokeParts(node) {
  const stroke = node.stroke;
  const paint = (node.strokes || [])[0];
  if (!stroke || !paint || (!stroke.weight && !stroke.weights)) return { decls: [], shadow: null };

  const style = stroke.dashes?.length ? 'dashed' : 'solid';
  const color = paint.kind === 'solid' ? colorCss(paint.color) : null;

  if (!color) {
    const width = stroke.weights ? Math.max(...stroke.weights) : stroke.weight;
    return {
      decls: [
        ['border', `${px(width)} ${style} transparent`],
        ['border-image', `${paintCss(paint, node.box)} 1`],
      ],
      shadow: null,
    };
  }
  /* Обводка снаружи в CSS — это не border: border сдвинул бы содержимое. Тень без размытия
     рисует ровно то же и складывается с остальными тенями. */
  if (stroke.align === 'OUTSIDE' && !stroke.weights) {
    return { decls: [], shadow: `0 0 0 ${px(stroke.weight)} ${color}` };
  }
  if (stroke.weights) {
    const sides = ['top', 'right', 'bottom', 'left'];
    return {
      decls: stroke.weights
        .map((w, i) => [`border-${sides[i]}`, `${px(w)} ${style} ${color}`, w])
        .filter(([, , w]) => w > 0)
        .map(([prop, value]) => [prop, value]),
      shadow: null,
    };
  }
  return { decls: [['border', `${px(stroke.weight)} ${style} ${color}`]], shadow: null };
}

function textDecls(add, node) {
  const style = node.text?.style;
  if (!style) return;

  const fills = node.fills || [];
  if (fills.length === 1 && fills[0].kind === 'solid') {
    add('color', colorCss(fills[0].color));
  } else if (fills.length) {
    add('background', backgroundValue(fills, node.box));
    add('-webkit-background-clip', 'text');
    add('background-clip', 'text');
    add('color', 'transparent');
  }

  if (style.family) add('font-family', fontFamily(style.family));
  if (style.size) add('font-size', px(style.size));
  if (style.weight) add('font-weight', style.weight);
  if (style.italic) add('font-style', 'italic');
  const lh = style.lineHeight;
  if (lh?.unit === 'px') add('line-height', px(lh.value));
  else if (lh?.unit === '%') add('line-height', round(lh.value / 100, 3));
  if (style.letterSpacing) add('letter-spacing', px(style.letterSpacing));
  if (style.case === 'SMALL_CAPS' || style.case === 'SMALL_CAPS_FORCED') add('font-variant', 'small-caps');
  else add('text-transform', TEXT_CASE[style.case]);
  add('text-decoration', DECORATION[style.decoration]);
  add('text-align', TEXT_ALIGN[style.align]);

  const lines = node.text.maxLines;
  if (lines > 1) {
    add('display', '-webkit-box');
    add('-webkit-line-clamp', lines);
    add('-webkit-box-orient', 'vertical');
    add('overflow', 'hidden');
  } else if (lines === 1 || node.text.truncate) {
    add('overflow', 'hidden');
    add('text-overflow', 'ellipsis');
    add('white-space', 'nowrap');
  }
}

/**
 * Декларации одного узла.
 *
 * parent нужен для раскладки: одно и то же намерение FILL означает flex у ребёнка строки и
 * stretch у ребёнка колонки. children — чтобы понять, нужен ли узлу position: relative.
 */
export function nodeCss(node, { parent = null, children = [] } = {}) {
  const out = [];
  const add = (prop, value) => {
    if (value === null || value === undefined || value === '') return;
    out.push([prop, String(value)]);
  };
  const isText = node.type === 'TEXT';
  const flow = Boolean(parent?.layout) && !node.item?.absolute;

  if (parent && !flow && node.box && parent.box) {
    add('position', 'absolute');
    add('left', px(node.box.x - parent.box.x));
    add('top', px(node.box.y - parent.box.y));
  } else if (children.some((child) => child.item?.absolute || (!node.layout && child.visible !== false))) {
    add('position', 'relative');
  }

  const layout = node.layout;
  if (layout) {
    if (layout.mode === 'grid') {
      add('display', 'grid');
      if (layout.grid?.columns) add('grid-template-columns', `repeat(${layout.grid.columns}, minmax(0, 1fr))`);
      if (layout.grid?.rows > 1) add('grid-template-rows', `repeat(${layout.grid.rows}, auto)`);
      gap(add, layout.grid?.rowGap, layout.grid?.columnGap);
    } else {
      add('display', 'flex');
      if (layout.mode === 'column') add('flex-direction', 'column');
      if (layout.wrap) add('flex-wrap', 'wrap');
      add('justify-content', JUSTIFY[layout.main]);
      add('align-items', ALIGN[layout.cross]);
      /* При SPACE_BETWEEN Figma игнорирует itemSpacing: зазор вычисляется. Перенести его в gap
         значит задать минимум, которого в макете нет. */
      if (layout.main !== 'SPACE_BETWEEN') {
        if (layout.wrap && layout.crossGap != null) {
          const [row, column] = layout.mode === 'row' ? [layout.crossGap, layout.gap] : [layout.gap, layout.crossGap];
          gap(add, row, column);
        } else if (layout.gap) {
          add('gap', px(layout.gap));
        }
      }
    }
  }

  sizeAxis(add, node, parent, flow, 'h');
  sizeAxis(add, node, parent, flow, 'v');
  const { min, max } = node.item || {};
  if (min?.w) add('min-width', px(min.w));
  if (min?.h) add('min-height', px(min.h));
  if (max?.w) add('max-width', px(max.w));
  if (max?.h) add('max-height', px(max.h));

  if (layout) add('padding', boxShorthand(layout.padding));

  if (SHAPES.has(node.type)) {
    if (node.opacity != null && node.opacity < 1) add('opacity', round(node.opacity));
    return out;
  }

  if (node.type === 'ELLIPSE') add('border-radius', '50%');
  else add('border-radius', radiusValue(node.radius));

  if (!isText) add('background', backgroundValue(node.fills, node.box));

  const stroke = isText ? { decls: [], shadow: null } : strokeParts(node);
  for (const [prop, value] of stroke.decls) add(prop, value);
  if (isText && node.stroke?.weight && node.strokes?.[0]?.kind === 'solid') {
    add('-webkit-text-stroke', `${px(node.stroke.weight)} ${colorCss(node.strokes[0].color)}`);
  }

  const shadows = stroke.shadow ? [stroke.shadow] : [];
  const textShadows = [];
  for (const effect of node.effects || []) {
    if (effect.type === 'drop' || effect.type === 'inner') {
      if (isText) {
        if (effect.type === 'drop') {
          textShadows.push(`${px(effect.x)} ${px(effect.y)} ${px(effect.blur)} ${colorCss(effect.color)}`);
        }
        continue;
      }
      const spread = effect.spread ? ` ${px(effect.spread)}` : '';
      shadows.push(
        `${effect.type === 'inner' ? 'inset ' : ''}${px(effect.x)} ${px(effect.y)} ${px(effect.blur)}${spread} ${colorCss(effect.color)}`,
      );
    } else if (effect.type === 'blur') {
      /* Радиус размытия Figma вдвое больше того, что понимает filter: blur(). */
      add('filter', `blur(${px(effect.blur / 2)})`);
    } else if (effect.type === 'backdrop') {
      add('backdrop-filter', `blur(${px(effect.blur / 2)})`);
    }
  }
  if (shadows.length) add('box-shadow', shadows.join(', '));
  if (textShadows.length) add('text-shadow', textShadows.join(', '));

  if (node.opacity != null && node.opacity < 1) add('opacity', round(node.opacity));
  if (node.blend && BLEND[node.blend]) add('mix-blend-mode', BLEND[node.blend]);
  if (node.clips && !isText) add('overflow', 'hidden');
  /* rotation в снимке уже в смысле CSS — по часовой стрелке; перевод из соглашений Figma делает
     нормализация канала. */
  if (node.rotation) add('transform', `rotate(${round(node.rotation)}deg)`);

  if (isText) textDecls(add, node);
  return out;
}

export const cssText = (decls) => decls.map(([prop, value]) => `${prop}:${value}`).join(';');
