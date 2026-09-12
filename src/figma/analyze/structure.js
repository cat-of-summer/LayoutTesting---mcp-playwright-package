/**
 * Визуальная структура: какой разметкой стать кадру.
 *
 * Слои макета — не DOM. В них текст может лежать соседом прямоугольника, на котором он нарисован;
 * шапка — отдельным слоем поверх страницы; декоративный круг — внутри колонки с контентом. Сверстать
 * «по слоям» значит перенести всё это в разметку. Поэтому дерево строится по геометрии:
 *
 *   - auto-layout — это уже поток, ему верим;
 *   - у обычного фрейма дети раскладываются заново: прямоугольник под всем содержимым становится
 *     фоном, фигуры, торчащие за край или лежащие под текстом, — декором, то, что лежит в слоях
 *     рядом с карточкой, но нарисовано внутри неё, переносится внутрь, перекрывающее соседа —
 *     наложением, а остальное режется по зазорам на строки и колонки (XY-cut);
 *   - роли — по признакам, а не по именам слоёв: кегль, число текстов, заливка, взаимодействия.
 *     Имена лишь уточняют (header, footer, button) и дают классы.
 *
 * Результат — не код, а план разметки: теги, классы в стиле BEM, раскладка каждого контейнера и
 * заметки о том, где слои пришлось переставить. Решение остаётся за агентом.
 */
import { round } from '../css.js';
import { childNodes } from '../snapshot.js';
import { firstText, shapeSignature } from '../inspect.js';
import { bemName, bodyTextSize, clip, contains, coverage, isVisible, meaningfulName, visibleNodes } from './common.js';

const VECTORS = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'REGULAR_POLYGON']);
const CONTAINERS = new Set(['FRAME', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'GROUP', 'SECTION']);

const hasImage = (node) => Boolean(node.fills?.some((paint) => paint.kind === 'image'));
const painted = (node) => Boolean(node.fills?.length || node.strokes?.length || node.effects?.length);

const TAGS = {
  heading: 'h2',
  paragraph: 'p',
  label: 'span',
  link: 'a',
  placeholder: 'span',
  button: 'button',
  input: 'label',
  select: 'label',
  list: 'ul',
  card: 'article',
  header: 'header',
  footer: 'footer',
  nav: 'nav',
  section: 'section',
  image: 'img',
  icon: 'svg',
  decor: 'div',
  group: 'div',
  row: 'div',
  column: 'div',
  stack: 'div',
  root: 'main',
};

const ELEMENT = {
  heading: 'title',
  paragraph: 'text',
  label: 'label',
  link: 'link',
  placeholder: 'placeholder',
  button: 'button',
  input: 'field',
  select: 'select',
  list: 'list',
  image: 'image',
  icon: 'icon',
  decor: 'decor',
  group: 'group',
  section: 'section',
  header: 'header',
  footer: 'footer',
  nav: 'nav',
  card: 'card',
  row: 'row',
  column: 'col',
  stack: 'stack',
};

/** Роли, которые начинают новый BEM-блок, если у узла есть осмысленное имя. */
const BLOCKS = new Set(['header', 'footer', 'nav', 'section', 'card', 'list', 'button', 'input', 'select', 'root']);

function descendants(snapshot, node, out = []) {
  for (const kid of childNodes(snapshot, node)) {
    if (!isVisible(kid)) continue;
    out.push(kid);
    descendants(snapshot, kid, out);
  }
  return out;
}

export function isIconLike(snapshot, node) {
  const { w = 0, h = 0 } = node.box || {};
  if (w > 64 || h > 64) return false;
  if (VECTORS.has(node.type)) return true;
  if (!CONTAINERS.has(node.type)) return false;
  const all = descendants(snapshot, node);
  return all.length > 0 && !all.some((d) => d.type === 'TEXT' || hasImage(d));
}

function textRole(node, ctx) {
  const style = node.text?.style || {};
  const size = round(style.size ?? ctx.body);
  const navigates = node.interactions?.some((i) =>
    (i.actions || []).some((a) => a?.type === 'URL' || a?.navigation === 'NAVIGATE'),
  );
  if (navigates || style.decoration === 'UNDERLINE') return 'link';
  if ((node.fills?.[0]?.color?.a ?? 1) < 0.75 && ctx.inField) return 'placeholder';
  /* Текст внутри кнопки, поля или ссылки заголовком не бывает, каким бы крупным ни был кегль. */
  if (ctx.headingLevels.has(size) && !ctx.inControl) return 'heading';
  if (style.case === 'UPPER' && size <= ctx.body) return 'label';
  if ((node.text?.chars?.length ?? 0) <= 30) return 'label';
  return 'paragraph';
}

export function leafRole(snapshot, node, ctx) {
  if (node.type === 'TEXT') return textRole(node, ctx);
  if (isIconLike(snapshot, node)) return 'icon';
  if (hasImage(node) && !node.children?.length) return 'image';
  if (VECTORS.has(node.type)) return 'image';
  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') return 'decor';
  return null;
}

/** Роль контейнера по тому, что в нём, а не по имени слоя. Имя лишь уточняет. */
export function containerRole(snapshot, node, level) {
  const name = `${node.component?.set || ''} ${node.name || ''}`.toLowerCase();
  if (/header|шапк/.test(name) || (/\bmenu\b|меню/.test(name) && level <= 2)) return 'header';
  if (/footer|подвал/.test(name)) return 'footer';
  if (/breadcrumb|крошк|\bnav\b|навигац/.test(name)) return 'nav';

  const all = descendants(snapshot, node);
  const texts = all.filter((d) => d.type === 'TEXT');
  const chars = texts.reduce((sum, t) => sum + (t.text?.chars?.length || 0), 0);
  const h = node.box?.h ?? 0;
  const interactive = node.interactions?.some((i) => ['ON_CLICK', 'ON_PRESS', 'ON_HOVER', 'MOUSE_ENTER'].includes(i.trigger?.type));

  if (texts.length === 1 && h <= 80) {
    if (/select|dropdown|фильтр|filter|сортир/.test(name)) return 'select';
    const faint = (texts[0].fills?.[0]?.color?.a ?? 1) < 0.75 || (texts[0].opacity ?? 1) < 0.75;
    if (/input|search|поиск|field|поле/.test(name) || (faint && painted(node) && (node.box?.w ?? 0) > 120)) return 'input';
  }
  if (texts.length <= 2 && chars <= 40 && h <= 80) {
    if (/button|btn|кнопк/.test(name) || interactive || (painted(node) && node.radius && texts.length === 1)) return 'button';
  }
  if (!texts.length && interactive && all.length && h <= 80) return 'button';
  return null;
}

function layoutText(layout) {
  const bits = [layout.mode];
  if (layout.gap && layout.main !== 'SPACE_BETWEEN') bits.push(`gap${layout.gap}`);
  if (layout.padding?.some(Boolean)) bits.push(`pad${layout.padding.join('/')}`);
  if (layout.main && layout.main !== 'MIN') bits.push(`main:${layout.main.toLowerCase()}`);
  if (layout.cross && layout.cross !== 'MIN') bits.push(`cross:${layout.cross.toLowerCase()}`);
  if (layout.wrap) bits.push('wrap');
  return bits.join(' ');
}

const boxOf = (items) => {
  const x = Math.min(...items.map((i) => i.box.x));
  const y = Math.min(...items.map((i) => i.box.y));
  return {
    x,
    y,
    w: Math.max(...items.map((i) => i.box.x + i.box.w)) - x,
    h: Math.max(...items.map((i) => i.box.y + i.box.h)) - y,
  };
};

/** Разбиение по одной оси: группы, между проекциями которых есть зазор. */
function splitAxis(items, axis) {
  const start = (it) => (axis === 'y' ? it.box.y : it.box.x);
  const size = (it) => (axis === 'y' ? it.box.h : it.box.w);
  const groups = [];
  let end = -Infinity;
  for (const it of [...items].sort((a, b) => start(a) - start(b))) {
    if (!groups.length || start(it) >= end - 0.5) {
      groups.push([it]);
      end = start(it) + size(it);
    } else {
      groups.at(-1).push(it);
      end = Math.max(end, start(it) + size(it));
    }
  }
  return groups;
}

function alignment(boxes, direction) {
  const same = (values) => values.every((v) => Math.abs(v - values[0]) <= 1);
  if (direction === 'column') {
    if (same(boxes.map((b) => b.x))) return 'start';
    if (same(boxes.map((b) => b.x + b.w / 2))) return 'center';
    if (same(boxes.map((b) => b.x + b.w))) return 'end';
  } else {
    if (same(boxes.map((b) => b.y))) return 'start';
    if (same(boxes.map((b) => b.y + b.h / 2))) return 'center';
    if (same(boxes.map((b) => b.y + b.h))) return 'end';
  }
  return null;
}

/**
 * XY-cut: сначала строки по вертикальным зазорам, внутри — колонки по горизонтальным.
 *
 * Неравные зазоры не подгоняются под один gap: они отдаются диапазоном, и это сигнал, что
 * между блоками разные отступы, а не ошибка измерения.
 */
function cut(items, depth = 0) {
  if (items.length <= 1) return items[0];
  for (const [axis, direction] of [
    ['y', 'column'],
    ['x', 'row'],
  ]) {
    const groups = splitAxis(items, axis);
    if (groups.length < 2) continue;
    const children = groups.map((group) => (group.length === 1 ? group[0] : cut(group, depth + 1)));
    const boxes = groups.map(boxOf);
    const gaps = boxes.slice(1).map((b, i) => round(axis === 'y' ? b.y - (boxes[i].y + boxes[i].h) : b.x - (boxes[i].x + boxes[i].w)));
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    return {
      wrapper: true,
      role: direction,
      box: boxOf(items),
      layout: [direction, max - min <= 1 ? `gap${min}` : `gap${min}…${max}`, alignment(boxes, direction) && `align:${alignment(boxes, direction)}`]
        .filter(Boolean)
        .join(' '),
      items: children,
    };
  }
  return { wrapper: true, role: 'stack', box: boxOf(items), layout: 'stack', items };
}

/**
 * Дети обычного фрейма: фон, декор, переподчинение, наложения, поток.
 */
function arrange(snapshot, node, ctx) {
  let kids = [];
  for (const kid of childNodes(snapshot, node).filter(isVisible)) {
    if (kid.type === 'GROUP' && !isIconLike(snapshot, kid) && !hasImage(kid)) {
      ctx.notes.push({ kind: 'group', id: kid.id, note: 'группа не создаёт бокс в вёрстке — её дети разложены на уровень выше' });
      kids.push(...childNodes(snapshot, kid).filter(isVisible));
    } else {
      kids.push(kid);
    }
  }
  kids = kids.concat(ctx.adopted.get(node.id) || []);

  if (node.layout) {
    return {
      layout: layoutText(node.layout),
      flow: kids.filter((kid) => !kid.item?.absolute),
      layers: kids.filter((kid) => kid.item?.absolute).map((kid) => ({ node: kid, kind: 'absolute' })),
    };
  }

  const box = node.box;
  const z = new Map(kids.map((kid, i) => [kid.id, i]));
  const layers = [];
  let flow = [];
  const isShape = (kid) =>
    !kid.children?.length && (kid.type === 'RECTANGLE' || kid.type === 'ELLIPSE' || (VECTORS.has(kid.type) && !isIconLike(snapshot, kid)));

  for (const kid of kids) {
    if (!kid.box || !box) {
      flow.push(kid);
      continue;
    }
    if (isShape(kid) && coverage(box, kid.box) >= 0.9 && kids.some((o) => o !== kid && z.get(o.id) > z.get(kid.id))) {
      layers.push({ node: kid, kind: 'background' });
      ctx.notes.push({ kind: 'background', id: kid.id, of: node.id, note: 'фигура под всем содержимым — это фон контейнера, а не элемент' });
      continue;
    }
    if (isShape(kid) && !hasImage(kid)) {
      const outside = !contains(box, kid.box, 1);
      const underText = kids.some((o) => o.type === 'TEXT' && z.get(o.id) > z.get(kid.id) && coverage(o.box, kid.box) > 0);
      if (outside || (underText && coverage(kid.box, boxOf(kids.filter((o) => o.type === 'TEXT'))) < 0.5)) {
        const hint = outside ? 'выходит за край — псевдоэлемент или фон' : 'под текстом';
        layers.push({ node: kid, kind: 'decor', hint });
        ctx.notes.push({ kind: 'decor', id: kid.id, of: node.id, note: hint });
        continue;
      }
    }
    flow.push(kid);
  }

  /* Нарисовано внутри соседа, а в слоях лежит рядом. */
  const moved = new Set();
  const virtual = [];
  for (const host of flow) {
    if (!host.box || moved.has(host.id) || !(painted(host) || hasImage(host))) continue;
    const guests = flow.filter(
      (g) =>
        g !== host &&
        g.box &&
        !moved.has(g.id) &&
        z.get(g.id) > z.get(host.id) &&
        contains(host.box, g.box, 1) &&
        g.box.w * g.box.h < host.box.w * host.box.h * 0.9,
    );
    if (!guests.length) continue;
    for (const guest of guests) moved.add(guest.id);
    if (host.children?.length) {
      ctx.adopted.set(host.id, [...(ctx.adopted.get(host.id) || []), ...guests]);
    } else {
      moved.add(host.id);
      /* Внутренняя раскладка такой карточки выводится тут же: снаружи её уже никто не посчитает. */
      const inner = cut(guests);
      virtual.push({
        wrapper: true,
        role: 'group',
        box: host.box,
        background: host,
        layout: inner.wrapper ? inner.layout : null,
        items: inner.wrapper ? inner.items : [inner],
      });
    }
    ctx.notes.push({
      kind: 'reparented',
      ids: guests.map((g) => g.id),
      into: host.id,
      note: host.children?.length
        ? 'в слоях лежат рядом, но нарисованы внутри — в разметке это дети'
        : 'прямоугольник под ними — фон общего блока, а не отдельный элемент',
    });
  }
  flow = flow.filter((kid) => !moved.has(kid.id)).concat(virtual);

  /* Наложения: верхний из двух перекрывающихся уходит из потока. */
  const zOf = (item) => (item.wrapper ? z.get(item.background?.id) ?? -1 : z.get(item.id));
  for (const item of [...flow].sort((a, b) => zOf(b) - zOf(a))) {
    if (!item.box) continue;
    const under = flow.find(
      (other) =>
        other !== item &&
        other.box &&
        zOf(other) < zOf(item) &&
        (coverage(item.box, other.box) > 0.3 || coverage(other.box, item.box) > 0.3),
    );
    if (!under) continue;
    const top = Math.abs(item.box.y - box.y) <= 1 && Math.abs(item.box.w - box.w) <= 1;
    const hint = top ? 'поверх страницы у верхнего края — fixed или sticky' : `поверх ${under.id ?? 'блока'} — position: absolute`;
    layers.push({ node: item, kind: 'overlay', hint });
    ctx.notes.push({ kind: 'overlay', id: item.id ?? item.background?.id, of: node.id, note: hint });
    flow = flow.filter((f) => f !== item);
  }

  let layout = null;
  if (flow.length > 1) {
    const tree = cut(flow);
    layout = tree.layout;
    flow = tree.items;
  }
  if (box && flow.length) {
    const inner = boxOf(flow.filter((f) => f.box));
    const padding = [inner.y - box.y, box.x + box.w - (inner.x + inner.w), box.y + box.h - (inner.y + inner.h), inner.x - box.x].map(
      /* Отрицательный отступ в пиксель — это слой, съехавший на пиксель, а не отступ. */
      (v) => (v < 0 && v > -2 ? 0 : round(v)),
    );
    if (padding.some(Boolean)) layout = `${layout || 'block'} pad${padding.join('/')}`;
  }
  return { layout, flow, layers };
}

function isList(snapshot, items) {
  const nodes = items.filter((item) => !item.wrapper);
  if (nodes.length < 3) return false;
  const counts = new Map();
  for (const node of nodes) {
    const signature = shapeSignature(snapshot, node);
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  const best = Math.max(...counts.values());
  return best >= 3 && best / items.length >= 0.6;
}

function classFor(el, block) {
  const own = el.name ? bemName(el.name) : null;
  /* Контейнер с осмысленным именем начинает свой блок: иначе имя первой секции протекает вниз на
     всю страницу и классы выходят вида mobile__… у каждого узла. */
  if (own && (BLOCKS.has(el.role) || el.container)) return { cls: own, block: own };
  if (el.role === 'root') return { cls: own || 'page', block: own || 'page' };
  const element = own || ELEMENT[el.role] || 'box';
  return { cls: block ? `${block}__${element}` : element, block };
}

function build(snapshot, item, ctx, level, block, parentRole) {
  if (item.wrapper) {
    const el = { role: item.role, layout: item.layout, children: [], layers: [] };
    if (item.background) {
      el.background = item.background.id;
      el.role = 'card';
    }
    const named = classFor(el, block);
    el.cls = named.cls;
    for (const child of item.items) el.children.push(build(snapshot, child, ctx, level + 1, named.block, el.role));
    return el;
  }

  const node = item;
  const el = { id: node.id, name: meaningfulName(node), children: [], layers: [] };
  if (node.interactions) el.interactive = node.interactions.map((i) => i.trigger?.type?.toLowerCase().replace('on_', '')).join(',');
  if (node.component && !node.component.definition) {
    el.component = [node.component.set, node.component.name].filter(Boolean).join(' / ');
  }

  const inControl = ['button', 'link', 'input', 'select'].includes(parentRole) || ctx.inControl;
  const leaf = leafRole(snapshot, node, { ...ctx, inControl, inField: parentRole === 'input' || parentRole === 'select' });
  if (leaf) {
    el.role = leaf;
    Object.assign(el, classFor(el, block));
    if (node.type === 'TEXT') {
      const style = node.text?.style || {};
      el.text = node.text?.chars ?? '';
      el.font = `${round(style.size ?? 0)}/${style.weight ?? ''}`;
      if (leaf === 'heading') el.level = ctx.headingLevels.get(round(style.size));
      const lineHeight = style.lineHeight?.value && style.lineHeight.unit === 'px' ? style.lineHeight.value : style.lineHeight?.px;
      ctx.slots.texts.push({
        id: node.id,
        role: leaf,
        chars: el.text.length,
        width: round(node.box?.w ?? 0),
        lines: lineHeight ? Math.max(1, Math.round((node.box?.h ?? 0) / lineHeight)) : undefined,
      });
    } else if (leaf === 'image' && node.box) {
      ctx.slots.images.push({ id: node.id, ratio: round(node.box.w / (node.box.h || 1)) });
    }
    return el;
  }

  el.role = level === 0 ? 'root' : containerRole(snapshot, node, level) || 'group';
  el.container = true;
  if (level >= ctx.depth) {
    el.truncated = descendants(snapshot, node).length;
    Object.assign(el, classFor(el, block));
    return el;
  }

  const arranged = arrange(snapshot, node, ctx);
  el.layout = arranged.layout;
  if (el.role === 'group') {
    if (isList(snapshot, arranged.flow)) el.role = 'list';
    else if (painted(node) && (node.radius || node.effects?.length) && (node.box?.w ?? 0) <= 900) el.role = 'card';
    else if (parentRole === 'root' && (node.box?.h ?? 0) >= 150) el.role = 'section';
  }
  const named = classFor(el, block);
  el.cls = named.cls;

  if (el.role === 'list') {
    ctx.slots.lists.push({ id: node.id, items: arranged.flow.length, first: arranged.flow[0]?.id });
  }
  const inner = { ...ctx, inControl };
  for (const child of arranged.flow) el.children.push(build(snapshot, child, inner, level + 1, named.block, el.role));
  for (const layer of arranged.layers) {
    const built = build(snapshot, layer.node, ctx, level + 1, named.block, el.role);
    built.kind = layer.kind;
    if (layer.hint) built.hint = layer.hint;
    el.layers.push(built);
  }
  return el;
}

function tagOf(el, parentRole) {
  if (parentRole === 'list') return 'li';
  if (el.role === 'heading') return `h${el.level || 2}`;
  return TAGS[el.role] || 'div';
}

function render(snapshot, el, lines, level, parentRole = null) {
  const pad = '  '.repeat(level);
  let line = `${pad}${tagOf(el, parentRole)}${el.cls ? `.${el.cls}` : ''}`;
  if (el.id) line += ` ${el.id}`;
  if (el.kind) line += ` {${el.kind}${el.hint ? `: ${el.hint}` : ''}}`;
  if (el.layout) line += ` [${el.layout}]`;
  if (el.background) line += ` [фон ${el.background}]`;
  if (el.text !== undefined) line += ` «${clip(el.text, 60)}» ${el.font}`;
  if (el.component) line += ` <${el.component}>`;
  if (el.interactive) line += ` →${el.interactive}`;
  if (el.truncated) line += ` … ещё ${el.truncated} узлов глубже depth`;
  lines.push(line);

  const kids = el.children;
  for (let i = 0; i < kids.length; ) {
    let j = i + 1;
    const signature = kids[i].id && snapshot.nodes[kids[i].id] ? shapeSignature(snapshot, snapshot.nodes[kids[i].id]) : null;
    while (signature && j < kids.length && kids[j].id && shapeSignature(snapshot, snapshot.nodes[kids[j].id]) === signature) j += 1;
    render(snapshot, kids[i], lines, level + 1, el.role);
    /* Сворачивать пару одинаковых незачем: строка «×1 как …» длиннее самой строки элемента. */
    if (j - i < 3) {
      i += 1;
      continue;
    }
    const same = kids.slice(i + 1, j);
    if (same.length) {
      const listed = same
        .slice(0, 8)
        .map((kid) => {
          const text = clip(firstText(snapshot, snapshot.nodes[kid.id]), 30);
          return text ? `${kid.id} «${text}»` : kid.id;
        })
        .join(', ');
      lines.push(`${pad}  ×${same.length} как ${kids[i].id}: ${listed}${same.length > 8 ? ', …' : ''}`);
    }
    i = j;
  }
  for (const layer of el.layers) render(snapshot, layer, lines, level + 1, el.role);
}

/**
 * Уровни заголовков по кеглям.
 *
 * Заголовок — кегль заметно крупнее основного (×1.25 и не меньше 18px). Самый крупный, если он
 * один на кадре, — h1; если их несколько, это заголовки карточек, и h1 на кадре нет.
 */
function headingLevels(snapshot, rootId, body) {
  const counts = new Map();
  for (const { node } of visibleNodes(snapshot, rootId)) {
    if (node.type !== 'TEXT') continue;
    const style = node.text?.style || {};
    const size = round(style.size ?? 0);
    /* Дробный кегль — это масштабированная группа, обычно логотип: 26.87px заголовком не бывает.
       Крупный, но светлый текст — тоже: «2 ... 10» в пагинации набран 20/400 при основном 14. */
    if (Math.abs(size - Math.round(size)) > 0.01) continue;
    if ((style.weight ?? 400) < 500 && size < body * 1.5) continue;
    if (size >= Math.max(18, body * 1.25)) counts.set(size, (counts.get(size) || 0) + 1);
  }
  const sizes = [...counts.keys()].sort((a, b) => b - a);
  const start = sizes.length && counts.get(sizes[0]) === 1 ? 1 : 2;
  return new Map(sizes.map((size, i) => [size, Math.min(4, start + i)]));
}

export function inferStructure(snapshot, rootId, { depth = 10 } = {}) {
  const body = bodyTextSize(snapshot, rootId);
  const ctx = {
    body,
    headingLevels: headingLevels(snapshot, rootId, body),
    depth,
    notes: [],
    adopted: new Map(),
    slots: { texts: [], lists: [], images: [] },
  };
  const tree = build(snapshot, snapshot.nodes[rootId], ctx, 0, null, null);
  const lines = [];
  render(snapshot, tree, lines, 0);
  return {
    body,
    headings: Object.fromEntries([...ctx.headingLevels].map(([size, level]) => [`${size}px`, `h${level}`])),
    lines,
    notes: ctx.notes,
    slots: ctx.slots,
    tree,
  };
}
