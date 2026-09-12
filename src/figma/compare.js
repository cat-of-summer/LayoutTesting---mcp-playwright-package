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
import { clip, deltaE, parseColor, SAME_COLOR, visibleNodes } from './analyze/common.js';
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
    for (const child of el.children) walk(child);
  };
  walk(root);
  return { origin: { w: origin.width, h: origin.height }, items };
}

function designItems(snapshot, rootId) {
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
    }
  }
  return { size: { w: root.box?.w, h: root.box?.h }, items };
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
      onlyDesign: semantic.onlyDesign,
      onlyPage: semantic.onlyPage,
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
