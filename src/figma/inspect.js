/**
 * Чтение снимка: дерево слоёв и компактные стили.
 *
 * Замена get_metadata и get_design_context официального MCP, и оба недостатка тех ответов
 * здесь исправлены прицельно. Ответ design_context повторял разметку на каждый пункт списка —
 * для открытой карточки это сотни строк; здесь подряд идущие соседи одинаковой формы
 * сворачиваются в одну строку с их текстами. И порядок детей берётся не из слоёв, а из потока
 * auto-layout или из положения на холсте: слои в макетах перепутаны чаще, чем нет.
 */
import { colorCss, cssText, nodeCss, paintNotes, paintSummary, round } from './css.js';
import { childNodes, strip } from './snapshot.js';

const isVisible = (node) => node.visible !== false;

const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Обрезка текста узла со счётчиком: сколько текстов ушло с многоточием, ответ говорит прямо. */
const clipText = (node, max, stats) => {
  const chars = node.text?.chars ?? '';
  if (stats && String(chars).replace(/\s+/g, ' ').trim().length > max) stats.clippedTexts = (stats.clippedTexts || 0) + 1;
  return clip(chars, max);
};

/**
 * Дети в порядке чтения.
 *
 * У auto-layout порядок массива и есть порядок потока, абсолютные дети уходят в конец. У
 * обычного фрейма — сверху вниз, в пределах строки слева направо; допуск в 4px нужен потому, что
 * «одна строка» в макете редко выровнена до пикселя.
 */
export function orderedChildren(snapshot, node, { hidden = false } = {}) {
  const kids = childNodes(snapshot, node).filter((kid) => hidden || isVisible(kid));
  if (node.layout) {
    return [...kids.filter((kid) => !kid.item?.absolute), ...kids.filter((kid) => kid.item?.absolute)];
  }
  return [...kids].sort((a, b) => {
    const dy = (a.box?.y ?? 0) - (b.box?.y ?? 0);
    if (Math.abs(dy) > 4) return dy;
    return (a.box?.x ?? 0) - (b.box?.x ?? 0);
  });
}

/** Форма узла без текстов: по ней узнаются пункты одного списка. */
export function shapeSignature(snapshot, node, depth = 3) {
  const own = [
    node.type,
    Math.round(node.box?.w ?? 0),
    Math.round(node.box?.h ?? 0),
    node.layout?.mode ?? '',
    node.component?.id ?? '',
  ].join('|');
  if (!depth || !node.children) return own;
  const kids = childNodes(snapshot, node)
    .filter(isVisible)
    .map((kid) => shapeSignature(snapshot, kid, depth - 1));
  return `${own}(${kids.join(',')})`;
}

export function firstText(snapshot, node) {
  if (node.type === 'TEXT') return node.text?.chars ?? '';
  for (const kid of childNodes(snapshot, node)) {
    if (!isVisible(kid)) continue;
    const found = firstText(snapshot, kid);
    if (found) return found;
  }
  return '';
}

function describe(node, origin, stats) {
  let line = `${node.id} ${node.type} ${JSON.stringify(node.name ?? '')}`;
  if (node.box) {
    line += ` ${round(node.box.x - origin.x)},${round(node.box.y - origin.y)} ${round(node.box.w)}x${round(node.box.h)}`;
  }

  const flags = [];
  const layout = node.layout;
  if (layout) {
    const bits = [layout.mode === 'grid' && layout.grid?.columns ? `grid ${layout.grid.columns}col` : layout.mode];
    if (layout.gap && layout.main !== 'SPACE_BETWEEN') bits.push(`gap${layout.gap}`);
    if (layout.padding?.some(Boolean)) bits.push(`pad${layout.padding.join('/')}`);
    if (layout.main && layout.main !== 'MIN') bits.push(`main:${layout.main.toLowerCase()}`);
    if (layout.cross && layout.cross !== 'MIN') bits.push(`cross:${layout.cross.toLowerCase()}`);
    if (layout.wrap) bits.push('wrap');
    flags.push(bits.join(' '));
  }
  const item = node.item;
  if (item?.absolute) flags.push('abs');
  if (item?.sizingH && item.sizingH !== 'FIXED') flags.push(`w:${item.sizingH.toLowerCase()}`);
  if (item?.sizingV && item.sizingV !== 'FIXED') flags.push(`h:${item.sizingV.toLowerCase()}`);
  if (node.visible === false) flags.push('hidden');
  if (node.clips) flags.push('clip');
  if (node.fills?.some((paint) => paint.kind === 'image')) flags.push('img');
  if (node.interactions) flags.push(`→${node.interactions.length}`);
  if (node.overflow) flags.push(`scroll:${node.overflow.toLowerCase()}`);
  if (node.scrollBehavior) flags.push(node.scrollBehavior.toLowerCase());
  if (flags.length) line += ` [${flags.join(', ')}]`;

  if (node.component && !node.component.definition) {
    const title = [node.component.set, node.component.name].filter(Boolean).join(' / ') || node.component.id;
    const props = node.component.props
      ? ` {${Object.entries(node.component.props)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}}`
      : '';
    line += ` <${title}${props}>`;
  }
  if (node.type === 'TEXT') {
    const style = node.text?.style || {};
    const font = [style.family, style.size ? `${style.size}/${style.weight ?? ''}` : null].filter(Boolean).join(' ');
    line += ` «${clipText(node, 60, stats)}»${font ? ` ${font}` : ''}`;
  }
  const paint = paintSummary(node);
  if (paint) line += ` {${paint}}`;
  return line;
}

export function outlineLines(snapshot, rootId, { depth = 6, hidden = false, stats = null } = {}) {
  const root = snapshot.nodes[rootId];
  const origin = root.box || { x: 0, y: 0 };
  const lines = [];
  const pad = (level) => '  '.repeat(level);

  const visit = (node, level) => {
    lines.push(`${pad(level)}${describe(node, origin, stats)}`);
    const kids = orderedChildren(snapshot, node, { hidden });
    if (!kids.length) return;
    if (level >= depth) {
      lines.push(`${pad(level + 1)}… ${kids.length} вложенных глубже depth`);
      return;
    }
    for (let i = 0; i < kids.length; ) {
      const signature = shapeSignature(snapshot, kids[i]);
      let j = i + 1;
      while (j < kids.length && shapeSignature(snapshot, kids[j]) === signature) j += 1;
      visit(kids[i], level + 1);
      const same = kids.slice(i + 1, j);
      if (same.length) {
        const listed = same
          .slice(0, 8)
          .map((kid) => {
            const text = clip(firstText(snapshot, kid), 30);
            return text ? `${kid.id} «${text}»` : kid.id;
          })
          .join(', ');
        lines.push(`${pad(level + 1)}×${same.length} как ${kids[i].id}: ${listed}${same.length > 8 ? ', …' : ''}`);
      }
      i = j;
    }
  };

  visit(root, 0);
  return lines;
}

export function cssItems(snapshot, rootId, { depth = 2, hidden = false, stats = null } = {}) {
  const items = [];
  const cssOf = (node, parent) => cssText(nodeCss(node, { parent, children: childNodes(snapshot, node) }));

  const visit = (node, parent, level) => {
    items.push(
      strip({
        id: node.id,
        name: node.name,
        type: node.type,
        level,
        css: cssOf(node, parent),
        text: node.type === 'TEXT' ? clipText(node, 120, stats) : undefined,
        runs: node.text?.runs?.length,
        notes: paintNotes(node),
        component:
          node.component && !node.component.definition
            ? strip({ set: node.component.set, name: node.component.name, props: node.component.props })
            : undefined,
        vars: node.vars,
        styles: node.styles,
        figmaCss: node.css,
        interactions: node.interactions?.length,
      }),
    );
    if (level >= depth) return;

    const seen = new Map();
    for (const kid of orderedChildren(snapshot, node, { hidden })) {
      const signature = `${cssOf(kid, node)}#${shapeSignature(snapshot, kid)}`;
      if (seen.has(signature)) {
        items.push(strip({ id: kid.id, level: level + 1, sameAs: seen.get(signature), text: clip(firstText(snapshot, kid), 60) || undefined }));
        continue;
      }
      seen.set(signature, kid.id);
      visit(kid, node, level + 1);
    }
  };

  const root = snapshot.nodes[rootId];
  visit(root, snapshot.nodes[root.parent] ?? null, 0);
  return items;
}

/**
 * Тексты поддерева целиком, в порядке чтения.
 *
 * Остальные режимы режут строку до 60–120 знаков: дереву нужна форма, а не содержимое. Но
 * контент в вёрстку переносят именно отсюда, и абзац, оборванный многоточием, уезжает на сайт
 * оборванным — выглядит он при этом как законченный.
 */
export function textItems(snapshot, rootId, { hidden = false } = {}) {
  const items = [];
  const visit = (node) => {
    if (node.type === 'TEXT') {
      const style = node.text?.style || {};
      const fill = node.fills?.length === 1 && node.fills[0].kind === 'solid' ? colorCss(node.fills[0].color) : undefined;
      items.push(
        strip({
          id: node.id,
          text: node.text?.chars ?? '',
          font: style.size ? `${round(style.size)}/${style.weight ?? ''}` : undefined,
          color: fill,
          runs: node.text?.runs?.map((run) =>
            strip({
              text: run.text,
              weight: run.style?.weight,
              size: run.style?.size,
              italic: run.style?.italic,
              decoration: run.style?.decoration,
              color: run.fills?.[0]?.kind === 'solid' ? colorCss(run.fills[0].color) : undefined,
            }),
          ),
        }),
      );
      return;
    }
    for (const kid of orderedChildren(snapshot, node, { hidden })) visit(kid);
  };
  visit(snapshot.nodes[rootId]);
  return items;
}

/**
 * Переменные Figma, на которые ссылаются показанные узлы, вместе с цепочкой алиасов.
 *
 * Раньше css-режим отдавал все переменные снимка в каждом ответе — десятки строк на запрос про
 * один текст. Дорогой ответ приучает экономить вызовы, а сэкономленный вызов — это цвет,
 * взятый на глаз.
 */
export function usedVariables(snapshot, ids) {
  const all = snapshot.variables;
  if (!all) return undefined;
  const out = {};
  const add = (id) => {
    if (out[id] || !all[id]) return;
    out[id] = all[id];
    for (const value of Object.values(all[id].modes || {})) {
      if (value?.type === 'VARIABLE_ALIAS') add(value.id);
    }
  };
  for (const id of ids) {
    const node = snapshot.nodes[id];
    if (!node) continue;
    for (const ref of new Set(JSON.stringify(node).match(/VariableID:[^"\\]+/g) || [])) add(ref);
  }
  return Object.keys(out).length ? out : undefined;
}
