/**
 * Кластеры UI-элементов: что здесь один компонент, а что — случайно похожие блоки.
 *
 * Задача не «найти кнопки», а не наплодить их. В макете одна и та же кнопка встречается десятком
 * инстансов и ещё парой отклеенных копий, у которых радиус на пиксель другой, а цвет — на полтона.
 * Свёрстанные по отдельности, они превращаются в десяток классов, которые потом правят по одному.
 *
 * Поэтому:
 *   - инстансы одного компонента Figma — заведомо один блок, модификаторы берутся из свойств варианта;
 *   - остальное группируется по сигнатуре: роль плюс состав содержимого (какие тексты и иконки
 *     внутри), без цветов и размеров — они становятся осями модификаторов, а не разными блоками;
 *   - значения, различающиеся неразличимо — пара пикселей, полтона цвета, — попадают в drift: это не
 *     вариант, а расхождение в макете, и его лучше свести к одному значению;
 *   - если передан проект, к каждому кластеру ищется уже свёрстанное правило с тем же набором
 *     свойств: чаще всего блок в проекте уже есть.
 */
import { colorCss, nodeCss, round } from '../css.js';
import { childNodes } from '../snapshot.js';
import { shapeSignature } from '../inspect.js';
import { bemName, clip, deltaE, isVisible, meaningfulName, SAME_COLOR, visibleNodes } from './common.js';
import { containerRole, isIconLike } from './structure.js';
import { matchRules } from '../project.js';

const CONTAINERS = new Set(['FRAME', 'INSTANCE', 'COMPONENT']);
const painted = (node) => Boolean(node.fills?.length || node.strokes?.length || node.effects?.length);

function firstTextNode(snapshot, node) {
  if (node.type === 'TEXT') return node;
  for (const kid of childNodes(snapshot, node)) {
    if (!isVisible(kid)) continue;
    const found = firstTextNode(snapshot, kid);
    if (found) return found;
  }
  return null;
}

/** Из чего блок состоит: тексты своими кеглями, иконки и картинки по порядку. Цвета не в счёт. */
function contentKinds(snapshot, node, depth = 3, out = []) {
  for (const kid of childNodes(snapshot, node)) {
    if (!isVisible(kid) || out.length > 12) continue;
    if (kid.type === 'TEXT') {
      const style = kid.text?.style || {};
      out.push(`text:${round(style.size ?? 0)}/${style.weight ?? ''}`);
    } else if (isIconLike(snapshot, kid)) {
      out.push('icon');
    } else if (kid.fills?.some((paint) => paint.kind === 'image')) {
      out.push('image');
    } else if (depth > 0 && kid.children?.length) {
      contentKinds(snapshot, kid, depth - 1, out);
    }
  }
  return out;
}

function styleOf(snapshot, node) {
  const decls = new Map(nodeCss(node, { children: childNodes(snapshot, node) }));
  const text = firstTextNode(snapshot, node);
  const style = text?.text?.style;
  return {
    bg: decls.get('background') ?? 'none',
    radius: decls.get('border-radius') ?? '0',
    padding: decls.get('padding') ?? '0',
    gap: decls.get('gap') ?? '0',
    border: decls.get('border') ?? 'none',
    shadow: decls.get('box-shadow') ?? 'none',
    height: node.box ? `${round(node.box.h)}px` : '?',
    color: text?.fills?.[0]?.kind === 'solid' ? colorCss(text.fills[0].color) : 'none',
    font: style?.size ? `${round(style.size)}/${style.weight ?? ''}` : 'none',
  };
}

/* Ширина в оси не входит: у блока в потоке её задаёт родитель, и вариантом она не бывает. */
const AXES = ['bg', 'color', 'radius', 'padding', 'gap', 'border', 'shadow', 'height', 'font'];

/**
 * Значение для сравнения, а не для показа.
 *
 * Угол градиента и позиции остановок Figma пересчитывает под пропорции блока: одна и та же золотая
 * кнопка на трёх размерах даёт 33.26deg, 27.48deg и 29.97deg. Сравнивать их как разные заливки —
 * значит развести один компонент на три варианта. Сравниваем цвета, показываем полное значение.
 */
const compareKey = (axis, value) =>
  axis === 'bg' || axis === 'shadow' || axis === 'border'
    ? String(value).replace(/-?[\d.]+(deg|%)/g, '').replace(/\s+/g, ' ').trim()
    : String(value);

function candidates(snapshot, rootId, frameRef) {
  const out = [];
  for (const { node } of visibleNodes(snapshot, rootId)) {
    if (node.id === rootId || !node.box || !CONTAINERS.has(node.type)) continue;
    const inside = contentKinds(snapshot, node);
    if (node.type !== 'INSTANCE') {
      const fits = node.box.w <= 900 && node.box.h <= 500;
      const shaped = node.radius || node.strokes?.length || node.effects?.length;
      if (!fits || !painted(node) || !shaped || !inside.length) continue;
    }
    out.push({
      id: node.id,
      ref: `${frameRef}:${node.id}`,
      frame: frameRef,
      node,
      role: containerRole(snapshot, node, 2) || (isIconLike(snapshot, node) ? 'icon' : 'card'),
      name: meaningfulName(node),
      set: node.component?.set || (node.component && !node.component.definition ? node.component.name : null),
      props: node.component?.props,
      kinds: inside,
      shape: shapeSignature(snapshot, node, 2),
      style: styleOf(snapshot, node),
      text: clip(firstTextNode(snapshot, node)?.text?.chars ?? '', 40),
    });
  }
  return out;
}

/** Имя модификатора: из варианта Figma, если он есть, иначе из того, чем вариант отличается. */
function modifierName(member, differs, index) {
  const fromFigma = Object.values(member.props || {})
    .filter((value) => typeof value === 'string')
    .map((value) => bemName(value))
    .filter((value) => value && !/^default$/i.test(value));
  if (fromFigma.length) return fromFigma.join('-');
  if (differs.bg === 'none' || /rgba\([^)]*,\s*0\)/.test(differs.bg || '')) return 'ghost';
  if (differs.height) return `size-${parseInt(differs.height, 10)}`;
  if (differs.font) return `text-${String(differs.font).replace('/', '-')}`;
  return `variant-${index + 1}`;
}

function parseCssColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    return {
      r: parseInt(hex[1].slice(0, 2), 16),
      g: parseInt(hex[1].slice(2, 4), 16),
      b: parseInt(hex[1].slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value);
  return rgba ? { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] } : null;
}

/** Различие, которого глаз не видит: до двух пикселей или до ΔE 2 по цвету. */
function isDrift(base, other) {
  const pxBase = parseFloat(base);
  const pxOther = parseFloat(other);
  if (String(base).includes('px') && Number.isFinite(pxBase) && Number.isFinite(pxOther)) {
    return pxBase !== pxOther && Math.abs(pxBase - pxOther) <= 2;
  }
  const first = parseCssColor(String(base).split(' ')[0]);
  const second = parseCssColor(String(other).split(' ')[0]);
  if (!first || !second) return false;
  const distance = deltaE(first, second);
  return distance > 0 && distance < SAME_COLOR;
}

const blockOf = (member) => bemName(member.set || member.name || '') || member.role;
/* Кадры одного экрана дают «Вакансия» и «Вакансия mobile» — это один блок, а не два. */
const responsiveKey = (block) => block.replace(/-?(mobile|desktop|tablet|mob|desk)$/i, '') || block;

export function findComponents(frames, { project = null, minCluster = 2 } = {}) {
  const all = [];
  for (const { snapshot, rootId, ref } of frames) all.push(...candidates(snapshot, rootId, ref));

  const clusters = new Map();
  for (const member of all) {
    const key = member.set ? `set:${member.set}` : `${member.role}|${member.kinds.join(',')}`;
    if (!clusters.has(key)) {
      clusters.set(key, { key, role: member.role, source: member.set ? 'component' : 'style', members: [] });
    }
    clusters.get(key).members.push(member);
  }

  const found = [];
  const singles = [];
  for (const cluster of clusters.values()) {
    if (cluster.members.length < minCluster) {
      singles.push(...cluster.members.map((m) => ({ ref: m.ref, role: m.role, block: blockOf(m), text: m.text })));
      continue;
    }

    const byBlock = new Map();
    for (const member of cluster.members) {
      const block = responsiveKey(blockOf(member));
      byBlock.set(block, (byBlock.get(block) || 0) + 1);
    }
    const block = [...byBlock.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const values = {};
    for (const axis of AXES) {
      const counts = new Map();
      for (const member of cluster.members) {
        const key = compareKey(axis, member.style[axis]);
        if (!counts.has(key)) counts.set(key, { key, value: member.style[axis], count: 0, refs: [] });
        const entry = counts.get(key);
        entry.count += 1;
        if (entry.refs.length < 4) entry.refs.push(member.ref);
      }
      values[axis] = [...counts.values()].sort((a, b) => b.count - a.count);
    }

    const axes = AXES.filter((axis) => values[axis].length > 1);
    const base = Object.fromEntries(AXES.map((axis) => [axis, values[axis][0].value]));
    const drift = [];
    for (const axis of axes) {
      for (const other of values[axis].slice(1)) {
        if (isDrift(base[axis], other.value)) {
          drift.push({ prop: axis, base: base[axis], other: other.value, count: other.count, refs: other.refs });
        }
      }
    }

    const groups = new Map();
    for (const member of cluster.members) {
      const signature = axes.map((axis) => `${axis}=${compareKey(axis, member.style[axis])}`).join(';');
      if (!groups.has(signature)) groups.set(signature, []);
      groups.get(signature).push(member);
    }
    const variants = [...groups.values()]
      .sort((a, b) => b.length - a.length)
      .map((members, index) => {
        const differs = Object.fromEntries(
          axes
            .filter((axis) => compareKey(axis, members[0].style[axis]) !== compareKey(axis, base[axis]))
            .map((axis) => [axis, members[0].style[axis]]),
        );
        return {
          modifier: Object.keys(differs).length ? modifierName(members[0], differs, index) : 'base',
          count: members.length,
          ...(Object.keys(differs).length ? { differs } : {}),
          members: members.slice(0, 6).map((m) => m.ref),
          ...(members[0].text ? { text: members[0].text } : {}),
        };
      });

    const frameCounts = {};
    for (const member of cluster.members) frameCounts[member.frame] = (frameCounts[member.frame] || 0) + 1;

    const entry = {
      block,
      role: cluster.role,
      source: cluster.source,
      count: cluster.members.length,
      frames: frameCounts,
      base,
      variants,
      ...(drift.length ? { drift } : {}),
      ...(cluster.members[0].set ? { component: cluster.members[0].set } : {}),
    };
    if (project) {
      const matched = matchRules(project, nodeCss(cluster.members[0].node, { children: [] }));
      if (matched.length) entry.project = matched;
    }
    found.push(entry);
  }

  /* Один блок на двух разрешениях сводится в один: разница ложится на брейкпоинты. */
  const merged = new Map();
  for (const entry of found.sort((a, b) => b.count - a.count)) {
    const key = `${entry.block}|${entry.role}`;
    const first = merged.get(key);
    if (!first) {
      merged.set(key, entry);
      continue;
    }
    first.count += entry.count;
    first.frames = { ...first.frames, ...entry.frames };
    first.variants = [...first.variants, ...entry.variants].slice(0, 12);
    first.responsive = true;
  }

  return { clusters: [...merged.values()], singles: singles.slice(0, 30), counted: all.length };
}
