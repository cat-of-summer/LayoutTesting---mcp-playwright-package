/**
 * Разница двух вариантов компонента по всем потомкам — и сверка ховера на странице с ней.
 *
 * Ховер карточки миссии перенесли по краске корня: в варианте Hover меняется и потомок — кнопка
 * «Детали миссии» становится жёлтой (фон, обводка, радиус, цвет текста с тенью), а радиус самой
 * карточки растёт с 4 до 12. Ни один инструмент не показывал, что меняется между вариантами
 * целиком: figma_spec по двум узлам давал два длинных дерева, и сравнивали их глазами.
 *
 * Варианты одного набора — разные узлы с разными id, поэтому потомки сопоставляются по пути
 * имён (с номером среди одноимённых соседей), а не по id, как в истории версий.
 */
import { colorCss, round } from './css.js';

/* Значения свойства варианта, которые означают состояния элемента, — целыми словами: подстрокой
   «on» находилось в «Secondary», и Type=Secondary сходил за состояние рядом с Primary. */
const STATE_TOKEN = /^(hover|hovered|active|pressed|focus|focused|selected|current|checked|open|on|наведен\S*|актив\S*|выбран\S*)$/i;
const DEFAULT_TOKEN = /^(default|normal|rest|enabled|idle|off|base|обычн\S*)$/i;
const words = (value) => String(value).split(/[\s/,_=()[\]\-–—:]+/).filter(Boolean);
const isStateValue = (value) => words(value).some((token) => STATE_TOKEN.test(token));
const DEFAULT_WORDS = /^(default|normal|rest|enabled|idle|off|base|по умолчанию|обычн)/i;

/** "State=Hover, Size=L" → { State: 'Hover', Size: 'L' }. */
export function variantProps(name = '') {
  const out = {};
  for (const part of String(name).split(',')) {
    const [key, ...rest] = part.split('=');
    if (rest.length) out[key.trim()] = rest.join('=').trim();
  }
  return out;
}

/** Вариант-состояние: Hover, Active, Selected — а не Default и не размер. */
export const isStateVariant = (name) =>
  Object.values(variantProps(name)).some((value) => isStateValue(value) && !DEFAULT_WORDS.test(value));

const matches = (variant, query) => {
  if (!query) return false;
  const q = String(query).trim().toLowerCase();
  if (variant.name.toLowerCase() === q) return true;
  const props = variantProps(variant.name);
  if (q.includes('=')) {
    const wanted = variantProps(query);
    return Object.entries(wanted).every(([k, v]) => String(props[k] ?? '').toLowerCase() === v.toLowerCase());
  }
  return Object.values(props).some((value) => value.toLowerCase() === q);
};

/**
 * Имя компонента без слова-состояния: «Card Hover», «Card / hover», «Card (hover)» → «card».
 * По нему одиночный компонент находит свой ховер, нарисованный отдельным компонентом рядом.
 */
export function stateBase(name = '') {
  const kept = words(name).filter((token) => !STATE_TOKEN.test(token) && !DEFAULT_TOKEN.test(token) && !/^state$/i.test(token));
  return kept.join(' ').toLowerCase();
}

/** Есть ли в имени слово-состояние (не «Default»). */
export const namesState = (name = '') => isStateValue(name);

/**
 * Пара для одиночного компонента — без набора вариантов: компоненты с тем же именем без
 * слова-состояния. Карточку миссии и её ховер нарисовали двумя самостоятельными компонентами
 * («Card», «Card Hover»), и figma_variants отвечал только «не принадлежит набору».
 *
 * Возвращает { from, to } при однозначной паре либо { candidates } — все похожие соседи.
 */
export function pairSiblings(node, siblings) {
  const base = stateBase(node.name);
  const same = siblings.filter((other) => other.id !== node.id && other.type === 'COMPONENT' && base && stateBase(other.name) === base);
  if (!same.length) return { candidates: [] };
  if (namesState(node.name)) {
    /* Ссылка ведёт на сам ховер: «откуда» — сосед без слова-состояния. */
    const plain = same.filter((other) => !namesState(other.name));
    return plain.length === 1 ? { from: plain[0], to: node } : { candidates: same };
  }
  const states = same.filter((other) => namesState(other.name));
  const hover = states.find((other) => /hover|наведен/i.test(other.name));
  if (states.length === 1 || hover) return { from: node, to: hover || states[0] };
  return { candidates: same };
}

/**
 * Выбрать пару вариантов. from/to — имя варианта, значение свойства («Hover») или «State=Hover».
 * По умолчанию: from — вариант экземпляра или «Default», to — вариант, отличающийся от from
 * одним свойством со значением-состоянием (Hover прежде прочих).
 *
 * Нет такого соседа — не ошибка, а { from, all }: базовый вариант против каждого из остальных.
 * Набор из четырёх вариантов без явного Hover отвечал «передайте to», и агент перебирал их сам.
 */
export function pickPair(variants, { from, to, current } = {}) {
  const byQuery = (query) => variants.find((variant) => matches(variant, query));
  const base =
    (from && byQuery(from)) ||
    (current && variants.find((variant) => variant.id === current)) ||
    variants.find((variant) => Object.values(variantProps(variant.name)).some((value) => DEFAULT_WORDS.test(value))) ||
    variants[0];
  if (from && !byQuery(from)) return { error: `Вариант «${from}» не найден` };
  if (to) {
    const target = byQuery(to);
    return target ? { from: base, to: target } : { error: `Вариант «${to}» не найден` };
  }
  const props = variantProps(base?.name);
  const siblings = variants.filter((variant) => {
    if (variant === base) return false;
    const other = variantProps(variant.name);
    const differ = Object.keys({ ...props, ...other }).filter((key) => props[key] !== other[key]);
    return differ.length === 1 && isStateValue(other[differ[0]] || '');
  });
  const hover = siblings.find((variant) => /hover|наведен/i.test(variant.name)) || siblings[0];
  return hover ? { from: base, to: hover } : { from: base, all: variants.filter((variant) => variant !== base) };
}

/* Подпись узла: имя, у текста — сам текст; у контейнера — первый текст внутри. */
function labelOf(snapshot, node) {
  if (node.text?.chars) return `${node.name} «${node.text.chars.slice(0, 30)}»`;
  const stack = [...(node.children || [])];
  while (stack.length) {
    const child = snapshot.nodes[stack.shift()];
    if (!child) continue;
    if (child.text?.chars) return `${node.name} «${child.text.chars.slice(0, 30)}»`;
    stack.push(...(child.children || []));
  }
  return node.name;
}

/* Первый текст узла — по нему потомок варианта находится на странице. */
function textOf(snapshot, node) {
  const match = /«(.+)»$/.exec(labelOf(snapshot, node));
  return match ? match[1] : null;
}

/** Плоская карта поддерева: путь имён → узел. */
function indexTree(snapshot, rootId) {
  const out = new Map();
  const visit = (id, path) => {
    const node = snapshot.nodes[id];
    if (!node) return;
    out.set(path, node);
    const seen = new Map();
    for (const childId of node.children || []) {
      const child = snapshot.nodes[childId];
      if (!child) continue;
      const n = seen.get(child.name) || 0;
      seen.set(child.name, n + 1);
      visit(childId, `${path}/${child.name}${n ? `#${n + 1}` : ''}`);
    }
  };
  visit(rootId, '');
  return out;
}

const paintText = (list, box) =>
  (list || [])
    .map((paint) => {
      if (paint.kind === 'solid') return colorCss(paint.color);
      if (paint.kind === 'image') return `image${paint.opacity ? ` op${paint.opacity}` : ''}`;
      return `${paint.kind}(${(paint.stops || []).map((stop) => colorCss(stop.color)).join(', ')})`;
    })
    .join(' + ') || 'нет';

const effectText = (list) =>
  (list || [])
    .map((e) => (e.type === 'drop' || e.type === 'inner' ? `${e.type} ${e.x} ${e.y} ${e.blur} ${e.spread} ${colorCss(e.color)}` : `${e.type} blur ${e.blur}`))
    .join('; ') || 'нет';

/* Свойства узла для сравнения и категория, по которой они сверяются со страницей. */
function facets(node, root) {
  const isText = node.type === 'TEXT';
  return {
    visible: { value: node.visible === false ? 'скрыт' : 'виден', category: 'visible' },
    fills: { value: paintText(node.fills, node.box), category: isText ? 'textColor' : 'fill' },
    strokes: { value: node.strokes?.length ? `${paintText(node.strokes)} ${node.stroke?.weight ?? ''}`.trim() : 'нет', category: 'stroke' },
    radius: { value: String(Array.isArray(node.radius) ? node.radius.join(' ') : node.radius ?? 0), category: 'radius' },
    effects: { value: effectText(node.effects), category: 'effects' },
    opacity: { value: String(node.opacity ?? 1), category: 'opacity' },
    ...(isText
      ? {
          text: { value: node.text?.chars ?? '', category: 'content' },
          font: { value: `${node.text?.style?.size ?? ''}/${node.text?.style?.weight ?? ''}`, category: 'font' },
        }
      : {}),
    size: { value: node.box ? `${round(node.box.w)}×${round(node.box.h)}` : '', category: 'geometry' },
    position: {
      value: node.box && root.box ? `${round(node.box.x - root.box.x)},${round(node.box.y - root.box.y)}` : '',
      category: 'geometry',
    },
  };
}

/**
 * Разница двух вариантов: [{ node, path, prop, from, to, category }] плюс узлы, которые есть
 * только в одном из них.
 */
export function diffVariants(snapshotA, rootA, snapshotB, rootB) {
  const a = indexTree(snapshotA, rootA);
  const b = indexTree(snapshotB, rootB);
  const rootNodeA = snapshotA.nodes[rootA];
  const rootNodeB = snapshotB.nodes[rootB];
  const changes = [];
  for (const [path, nodeA] of a) {
    const nodeB = b.get(path);
    if (!nodeB) continue;
    const fa = facets(nodeA, rootNodeA);
    const fb = facets(nodeB, rootNodeB);
    for (const [prop, { value, category }] of Object.entries(fa)) {
      if (!fb[prop] || fb[prop].value === value) continue;
      changes.push({
        node: path ? labelOf(snapshotB, nodeB) : `${labelOf(snapshotB, nodeB)} (корень)`,
        path: path || '/',
        prop,
        from: value,
        to: fb[prop].value,
        category,
        text: textOf(snapshotB, nodeB),
      });
    }
  }
  const onlyFrom = [...a.keys()].filter((path) => !b.has(path)).slice(0, 20);
  const onlyTo = [...b.keys()].filter((path) => !a.has(path)).slice(0, 20);
  return { changes, onlyFrom, onlyTo };
}

/* Какие CSS-свойства страницы отвечают категории разницы макета. */
const CSS_OF = {
  fill: ['background-color', 'background-image', 'fill'],
  textColor: ['color', 'fill', 'text-shadow'],
  stroke: ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'stroke', 'box-shadow'],
  radius: ['border-top-left-radius'],
  effects: ['box-shadow', 'text-shadow', 'filter', 'backdrop-filter'],
  opacity: ['opacity'],
  visible: ['opacity', 'transform', 'display', 'visibility'],
  geometry: ['transform'],
  font: [],
  content: [],
};

const norm = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Ховер на странице против разницы вариантов. pageChanges — diffStyles из interaction.js:
 * [{ node: 'button.btn «Детали миссии»', prop, from, to }].
 *
 * Потомок макета ищется на странице по своему тексту: кнопка «Детали миссии» — это узел
 * страницы с тем же текстом. Без текста — любой узел с подходящим свойством.
 */
export function compareHover(design, pageChanges) {
  const matched = [];
  const missingOnPage = [];
  const used = new Set();
  for (const change of design.changes) {
    const props = CSS_OF[change.category] || [];
    if (!props.length) continue;
    const text = norm(change.text);
    const candidates = pageChanges.filter((page) => props.includes(page.prop));
    const hit =
      (text && candidates.find((page) => norm(page.node).includes(`«${text}`))) ||
      (!text || change.path === '/' ? candidates[0] : null);
    if (hit) {
      used.add(hit);
      matched.push({ design: `${change.node}: ${change.prop} ${change.from} → ${change.to}`, page: `${hit.node}: ${hit.prop} ${hit.from} → ${hit.to}` });
    } else {
      missingOnPage.push({ node: change.node, prop: change.prop, from: change.from, to: change.to });
    }
  }
  const designCategories = new Set(design.changes.flatMap((change) => CSS_OF[change.category] || []));
  const extraOnPage = pageChanges.filter((page) => !used.has(page) && !designCategories.has(page.prop)).slice(0, 10);
  return { matched, missingOnPage, extraOnPage };
}
