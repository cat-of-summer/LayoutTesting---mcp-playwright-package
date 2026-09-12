/**
 * Один экран на разных ширинах: что здесь один и тот же элемент, а что изменилось.
 *
 * Десктоп и мобильная версия — не два макета, а один в двух состояниях, но в файле у них разные
 * id, разные имена слоёв и разный порядок. Пока элементы не сопоставлены, «мобильная вёрстка»
 * сводится к написанию второй вёрстки, и расхождения вроде «на десктопе select, на мобильной
 * иконка» всплывают уже после сдачи.
 *
 * Сопоставление идёт по содержимому, а не по позиции: текст — по самому тексту, картинка — по
 * хэшу заливки, инстанс — по компоненту, контейнер — по тому, какие сопоставленные элементы в нём
 * лежат. Дальше считаются различия: кегли, отступы, направление раскладки, видимость и порядок
 * чтения. Числа, меняющиеся линейно по ширине, отдаются готовым clamp().
 */
import { nodeCss, round } from '../css.js';
import { childNodes } from '../snapshot.js';
import { clip, isVisible, visibleNodes } from './common.js';

const normText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Свойства, изменение которых меняет вёрстку, а не только пиксели. */
const WATCHED = [
  'display',
  'flex-direction',
  'flex-wrap',
  'gap',
  'padding',
  'width',
  'height',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'align-items',
  'justify-content',
  'border-radius',
  'color',
  'background',
];

function leaves(snapshot, rootId) {
  const items = [];
  for (const { node } of visibleNodes(snapshot, rootId)) {
    if (!node.box || node.id === rootId) continue;
    const image = node.fills?.find((paint) => paint.kind === 'image');
    if (node.type === 'TEXT' && normText(node.text?.chars)) {
      items.push({ node, kind: 'text', key: `t:${normText(node.text.chars)}`, label: clip(node.text.chars, 40) });
    } else if (image) {
      items.push({ node, kind: 'image', key: `i:${image.ref}`, label: node.name });
    } else if (node.type === 'INSTANCE') {
      const component = node.component?.set || node.component?.name || node.component?.id;
      items.push({ node, kind: 'instance', key: `c:${component}`, label: component });
    } else if (node.vectorHash) {
      items.push({ node, kind: 'vector', key: `v:${node.vectorHash}`, label: node.name });
    }
  }
  return items;
}

const byY = (a, b) => (a.node.box.y - b.node.box.y) || (a.node.box.x - b.node.box.x);

/**
 * Сопоставление с учётом повторов: пять карточек «Терапевт» на десктопе и шесть на мобильной
 * связываются по порядку сверху вниз, а лишняя честно остаётся несопоставленной.
 */
function pairUp(base, other) {
  const group = (items) => {
    const map = new Map();
    for (const item of items) map.set(item.key, [...(map.get(item.key) || []), item]);
    for (const list of map.values()) list.sort(byY);
    return map;
  };
  const left = group(base);
  const right = group(other);
  const matches = [];
  const matchedLeft = new Set();
  const matchedRight = new Set();
  for (const [key, list] of left) {
    const pairs = right.get(key) || [];
    for (let i = 0; i < Math.min(list.length, pairs.length); i += 1) {
      matches.push({ base: list[i], other: pairs[i], kind: list[i].kind });
      matchedLeft.add(list[i].node.id);
      matchedRight.add(pairs[i].node.id);
    }
  }
  return {
    matches,
    onlyBase: base.filter((item) => !matchedLeft.has(item.node.id)),
    onlyOther: other.filter((item) => !matchedRight.has(item.node.id)),
  };
}

/** Контейнеры сопоставляются по составу: доля общих сопоставленных детей. */
function containerPairs(baseSnap, baseRoot, otherSnap, otherRoot, matches) {
  const map = new Map(matches.map((m) => [m.base.node.id, m.other.node.id]));
  const sets = (snapshot, rootId, project) => {
    const out = [];
    for (const { node } of visibleNodes(snapshot, rootId)) {
      if (!node.children?.length) continue;
      const ids = new Set();
      const walk = (current) => {
        for (const kid of childNodes(snapshot, current)) {
          if (!isVisible(kid)) continue;
          const id = project ? map.get(kid.id) : kid.id;
          if (id) ids.add(id);
          walk(kid);
        }
      };
      walk(node);
      if (ids.size) out.push({ node, ids });
    }
    return out;
  };
  const left = sets(baseSnap, baseRoot, true);
  const right = sets(otherSnap, otherRoot, false);
  const pairs = [];
  const taken = new Set();
  for (const item of left.sort((a, b) => b.ids.size - a.ids.size)) {
    let best = null;
    for (const candidate of right) {
      if (taken.has(candidate.node.id)) continue;
      const common = [...item.ids].filter((id) => candidate.ids.has(id)).length;
      if (common < 2) continue;
      const score = common / new Set([...item.ids, ...candidate.ids]).size;
      if (!best || score > best.score) best = { candidate, score };
    }
    if (best && best.score >= 0.5) {
      taken.add(best.candidate.node.id);
      pairs.push({ base: { node: item.node, kind: 'container' }, other: { node: best.candidate.node, kind: 'container' }, kind: 'container', score: round(best.score, 2) });
    }
  }
  return pairs;
}

/**
 * Значение, меняющееся линейно с шириной экрана, — это clamp(), а не два media-правила.
 */
export function fluid(wide, wideWidth, narrow, narrowWidth) {
  const a = parseFloat(wide);
  const b = parseFloat(narrow);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || wideWidth === narrowWidth) return null;
  if (!String(wide).endsWith('px') || !String(narrow).endsWith('px')) return null;
  const slope = (a - b) / (wideWidth - narrowWidth);
  const intercept = b - slope * narrowWidth;
  return `clamp(${round(Math.min(a, b))}px, calc(${round(intercept)}px + ${round(slope * 100, 3)}vw), ${round(Math.max(a, b))}px)`;
}

function diff(basePair, otherPair, widths) {
  const left = new Map(nodeCss(basePair.node, { children: [] }));
  const right = new Map(nodeCss(otherPair.node, { children: [] }));
  const changes = {};
  for (const prop of WATCHED) {
    const a = left.get(prop);
    const b = right.get(prop);
    if ((a ?? null) === (b ?? null)) continue;
    const entry = [a ?? '—', b ?? '—'];
    const clamp = a && b ? fluid(a, widths[0], b, widths[1]) : null;
    changes[prop] = clamp ? { from: entry[0], to: entry[1], fluid: clamp } : { from: entry[0], to: entry[1] };
  }
  return changes;
}

/** Порядок чтения: если сопоставленные элементы идут в разном порядке, одной разметкой не обойтись. */
function orderConflicts(matches) {
  const base = [...matches].sort((a, b) => byY(a.base, b.base));
  const positions = new Map(
    [...matches].sort((a, b) => byY(a.other, b.other)).map((match, index) => [match.base.node.id, index]),
  );
  const conflicts = [];
  for (let i = 0; i < base.length - 1 && conflicts.length < 10; i += 1) {
    for (let j = i + 1; j < base.length; j += 1) {
      if (positions.get(base[i].base.node.id) > positions.get(base[j].base.node.id)) {
        conflicts.push({
          base: [base[i].base.node.id, base[j].base.node.id],
          other: [base[j].other.node.id, base[i].other.node.id],
          what: [clip(base[i].base.label, 30), clip(base[j].base.label, 30)],
        });
        break;
      }
    }
  }
  return conflicts;
}

/** Несопоставленная пара на одном месте — это замена: select фильтра стал иконкой. */
function replacements(onlyBase, onlyOther, widths) {
  const out = [];
  for (const item of onlyBase) {
    const relative = item.node.box.y / Math.max(1, widths[0]);
    const candidate = onlyOther.find((other) => Math.abs(other.node.box.y / Math.max(1, widths[1]) - relative) < 0.05);
    if (candidate) {
      out.push({
        base: item.node.id,
        other: candidate.node.id,
        what: [clip(item.label || item.node.name, 30), clip(candidate.label || candidate.node.name, 30)],
      });
    }
  }
  return out.slice(0, 10);
}

const textKeys = (snapshot, rootId) => new Set(leaves(snapshot, rootId).filter((item) => item.kind === 'text').map((item) => item.key));

/**
 * Один ли это экран.
 *
 * Кадры задачи — не всегда один экран: рядом лежат модалки и карточки. Сравнивать страницу с
 * модалкой бессмысленно, и молча этого делать нельзя: получится «высота 3178px на десктопе и 34px
 * на мобильной» с готовым clamp(). Общность считается по текстам: у одного экрана они совпадают.
 */
export function sameScreen(frames, { minOverlap = 0.6 } = {}) {
  const sorted = [...frames].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const [base, ...rest] = sorted;
  if (!base) return { group: [], apart: [] };
  const baseKeys = textKeys(base.snapshot, base.rootId);
  const group = [base];
  const apart = [];
  for (const frame of rest) {
    const keys = textKeys(frame.snapshot, frame.rootId);
    const common = [...keys].filter((key) => baseKeys.has(key)).length;
    const overlap = common / Math.max(1, Math.min(baseKeys.size, keys.size));
    if (overlap >= minOverlap) group.push({ ...frame, overlap: round(overlap, 2) });
    else apart.push({ ref: frame.ref, name: frame.name, width: frame.width, overlap: round(overlap, 2) });
  }
  return { group, apart };
}

export function compareBreakpoints(frames, { limit = 60 } = {}) {
  const sorted = [...frames].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const [base, ...rest] = sorted;
  if (!rest.length) throw new Error('Для сравнения нужны хотя бы два кадра одного экрана разной ширины.');

  const baseLeaves = leaves(base.snapshot, base.rootId);
  const report = [];
  for (const frame of rest) {
    const otherLeaves = leaves(frame.snapshot, frame.rootId);
    const { matches, onlyBase, onlyOther } = pairUp(baseLeaves, otherLeaves);
    const containers = containerPairs(base.snapshot, base.rootId, frame.snapshot, frame.rootId, matches);
    const widths = [base.width ?? 0, frame.width ?? 0];

    const changes = [];
    for (const pair of [...containers, ...matches]) {
      const what = diff(pair.base, pair.other, widths);
      if (!Object.keys(what).length) continue;
      changes.push({
        kind: pair.kind,
        base: pair.base.node.id,
        other: pair.other.node.id,
        label: clip(pair.base.label || pair.base.node.name, 40),
        changes: what,
      });
    }
    changes.sort((a, b) => Object.keys(b.changes).length - Object.keys(a.changes).length);

    report.push({
      frame: frame.ref,
      width: frame.width,
      matched: matches.length,
      containers: containers.length,
      changes: changes.slice(0, limit),
      truncated: changes.length > limit ? changes.length - limit : undefined,
      onlyBase: onlyBase.slice(0, 15).map((item) => ({ id: item.node.id, kind: item.kind, label: clip(item.label || item.node.name, 40) })),
      onlyOther: onlyOther.slice(0, 15).map((item) => ({ id: item.node.id, kind: item.kind, label: clip(item.label || item.node.name, 40) })),
      replaced: replacements(onlyBase, onlyOther, widths),
      order: orderConflicts(matches),
    });
  }

  const { apart } = sameScreen(sorted);
  return {
    base: { frame: base.ref, width: base.width },
    frames: sorted.map((frame) => ({ ref: frame.ref, width: frame.width, name: frame.name })),
    ...(apart.length
      ? {
          apart,
          warning: 'Эти кадры почти не разделяют текстов с базовым — похоже, это другой экран, а не другая ширина того же. Их различия читать как адаптив нельзя.',
        }
      : {}),
    comparisons: report,
    note:
      'Между шириной самого узкого и самого широкого кадра макетов нет: точку перелома проверяйте прогоном layout_stress по ширинам, а не назначайте по числу из макета.',
  };
}
