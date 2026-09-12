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
import { clip, contains, deltaE, parseColor, SAME_COLOR, visibleNodes } from './analyze/common.js';
import { exportRender } from './export.js';

const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Что видно на странице: тексты с их геометрией и типографикой, картинки с адресами. */
function probePage(rootSelector) {
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
    const box = { x: rect.x - origin.x, y: rect.y - origin.y, w: rect.width, h: rect.height };

    const own = Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3 && node.nodeValue.trim())
      .map((node) => node.nodeValue.trim())
      .join(' ');
    if (own) {
      items.push({
        kind: 'text',
        text: own,
        selector: cssPath(el),
        box,
        style: {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          color: style.color,
          textTransform: style.textTransform,
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
      if (!transparent || borders.some(Boolean) || radius.some((value) => parseFloat(value) > 0)) {
        items.push({
          kind: 'box',
          selector: cssPath(el),
          box,
          paint: {
            background: transparent ? null : style.backgroundColor,
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

export function designItems(snapshot, rootId) {
  const root = snapshot.nodes[rootId];
  const origin = root.box || { x: 0, y: 0 };
  const items = [];
  for (const { node } of visibleNodes(snapshot, rootId)) {
    if (!node.box) continue;
    const box = { x: node.box.x - origin.x, y: node.box.y - origin.y, w: node.box.w, h: node.box.h };
    if (node.type === 'TEXT' && node.text?.chars?.trim()) {
      const style = node.text.style || {};
      items.push({
        kind: 'text',
        id: node.id,
        text: node.text.chars,
        box,
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
  return { size: { w: root.box?.w, h: root.box?.h }, items };
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
      unmatched.push({ node: item.id, name: clip(item.name || '', 30), size: `${round(item.box.w)}x${round(item.box.h)}` });
      continue;
    }
    matched += 1;
    if (Object.keys(diffs).length) {
      findings.push({ node: item.id, name: clip(item.name || '', 30), selector: hit.box.selector, diffs });
    }
  }

  findings.sort((a, b) => Object.keys(b.diffs).length - Object.keys(a.diffs).length);
  return { boxes: matched + unmatched.length, matched, findings, unmatched };
}

const byReadingOrder = (a, b) => a.box.y - b.box.y || a.box.x - b.box.x;

/** Сопоставление по тексту с учётом повторов — как между брейкпоинтами. */
function pairTexts(design, page) {
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

export function compareGeometry(design, page, { tolerance = 2 } = {}) {
  const { pairs, onlyDesign, onlyPage } = pairTexts(design.items, page.items);
  const findings = [];

  for (const pair of pairs) {
    const shift = {
      x: round(pair.page.box.x - pair.design.box.x),
      y: round(pair.page.box.y - pair.design.box.y),
      w: round(pair.page.box.w - pair.design.box.w),
      h: round(pair.page.box.h - pair.design.box.h),
    };
    const styles = styleDiff(pair.design, pair.page);
    const worst = Math.max(Math.abs(shift.x), Math.abs(shift.y), Math.abs(shift.w));
    if (worst <= tolerance && !Object.keys(styles).length) continue;
    findings.push({
      text: clip(pair.design.text, 40),
      node: pair.design.id,
      selector: pair.page.selector,
      ...(worst > tolerance ? { shift: Object.fromEntries(Object.entries(shift).filter(([, value]) => Math.abs(value) > tolerance)) } : {}),
      ...(Object.keys(styles).length ? { styles } : {}),
      severity: worst + Object.keys(styles).length * 4,
    });
  }

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
  const swallowed = new Set();
  for (const [bucket, list] of shifted) {
    if (list.length < 3) continue;
    grouped.push({
      shiftedBlock: `${list.length} элементов смещены по вертикали примерно на ${bucket}px`,
      hint: 'Обычно это разная высота блока выше, а не ошибка в каждом элементе: сначала сверьте её.',
      sample: list.slice(0, 3).map((finding) => ({ text: finding.text, node: finding.node, selector: finding.selector })),
      severity: Math.abs(bucket),
    });
    /* У самих элементов остаётся только их собственное расхождение: общий сдвиг уже назван. */
    for (const finding of list) {
      delete finding.shift.y;
      finding.blockShift = bucket;
      if (!Object.keys(finding.shift).length && !finding.styles) swallowed.add(finding);
      else finding.severity -= Math.abs(bucket);
    }
  }

  const rest = findings.filter((finding) => !swallowed.has(finding));
  const all = [...grouped, ...rest].sort((a, b) => b.severity - a.severity);
  return {
    matched: pairs.length,
    findings: all,
    onlyDesign: onlyDesign.slice(0, 15).map((item) => ({ node: item.id, text: clip(item.text, 40) })),
    onlyPage: onlyPage.slice(0, 15).map((item) => ({ selector: item.selector, text: clip(item.text, 40) })),
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
  tolerance = 2,
  threshold = 0.1,
  limit = 30,
  client,
  editor,
}) {
  const runId = newRunId('figma-compare');
  const dir = await runDir(runId);
  const name = slug(snapshot.nodes[rootId].name || 'frame') || 'frame';

  const design = designItems(snapshot, rootId);
  const out = { runId, ref: figmaRef, frame: design.size };

  if (mode !== 'pixel') {
    const probed = await page.evaluate(probePage, selector);
    if (probed.error) throw new Error(probed.error);
    const semantic = compareGeometry(design, probed, { tolerance });
    out.page = probed.origin;
    out.semantic = {
      matched: semantic.matched,
      found: semantic.findings.length,
      findings: semantic.findings.slice(0, limit).map(({ severity, ...rest }) => rest),
      ...(semantic.findings.length > limit ? { note: truncatedNote(semantic.findings.length, limit) } : {}),
      onlyDesign: semantic.onlyDesign,
      onlyPage: semantic.onlyPage,
    };
    const paint = comparePaint(design, probed, { tolerance });
    out.paint = {
      boxes: paint.boxes,
      matched: paint.matched,
      found: paint.findings.length,
      findings: paint.findings.slice(0, limit),
      ...(paint.findings.length > limit ? { note: truncatedNote(paint.findings.length, limit) } : {}),
      ...(paint.unmatched.length
        ? {
            unmatched: paint.unmatched.length,
            unmatchedSample: paint.unmatched.slice(0, 10),
            unmatchedNote:
              'Эти узлы с краской не нашлись на странице по месту. Псевдоэлементы и SVG здесь не видны — их сверяйте computed_styles с pseudo; остальное может просто отсутствовать в вёрстке.',
          }
        : {}),
    };
    if (Math.abs((design.size.w ?? 0) - (probed.origin.w ?? 0)) > 2) {
      out.widthNote = `Ширина кадра ${round(design.size.w)}px, а сравниваемого блока на странице ${round(probed.origin.w)}px: смещения по x читайте с поправкой на это.`;
    }
    if (Math.abs((design.size.h ?? 0) - (probed.origin.h ?? 0)) > 8) {
      out.heightNote = `Высота кадра ${round(design.size.h)}px, страницы ${round(probed.origin.h)}px — разница ${round((probed.origin.h ?? 0) - (design.size.h ?? 0))}px. Пока она не сойдётся, всё, что ниже расхождения, будет смещено целиком.`;
    }
  }

  if (mode !== 'semantic') {
    out.pixel = await comparePixels({ figmaRef, page, selector, dir, name, threshold, client, editor });
  }

  return out;
}
