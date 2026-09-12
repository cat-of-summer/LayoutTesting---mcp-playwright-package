/**
 * Снимок макета: единая модель узлов и кэш на диске.
 *
 * Весь разбор — структура, компоненты, токены, брейкпоинты — идёт по снимку, а не по Figma.
 * Иначе каждый вопрос к макету стоил бы запроса из лимита, и разбор кончался бы раньше вёрстки.
 *
 * Модель одна для обоих каналов (REST и редактор) и заметно компактнее ответа Figma: из узла
 * уходит всё, что не влияет на вёрстку, цвета приводятся к 0–255, значения по умолчанию
 * выбрасываются. Поля узла:
 *
 *   id, parent, type, name, visible (только false), children[]
 *   box {x,y,w,h} — абсолютные координаты; render — видимые границы, если отличаются
 *   rotation — градусы по часовой стрелке, как в CSS
 *   opacity, blend, clips
 *   layout {mode row|column|grid, gap, crossGap, wrap, padding[t,r,b,l], main, cross, grid}
 *   item {sizingH, sizingV: FIXED|HUG|FILL, absolute, grow, min{w,h}, max{w,h}}
 *   fills[], strokes[] — {kind solid|linear|radial|angular|diamond|image, …}
 *   stroke {weight, weights[t,r,b,l], align, dashes}, radius, effects[]
 *   text {chars, autoResize, truncate, maxLines, style, runs[]}
 *   component {id, name, set, key, props} у инстанса; {definition: true} у самого компонента
 *   vars — привязки к переменным Figma, styles — имена стилей
 *   interactions, scrollBehavior, overflow, annotations, devStatus, vectorHash
 *
 * Кэш: figma/<fileKey>/meta.json и figma/<fileKey>/<version>/<id>.json на каждый снятый корень.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRS } from '../constants.js';
import { round } from './css.js';
import { getRestClient } from './rest.js';
import { groupRefs, parseFigmaRef, refOf } from './url.js';

/** Как часто сверять версию файла. Макет редко меняется посреди разбора, а сверка стоит запроса. */
const META_TTL_MS = 10 * 60 * 1000;

const LAYOUT_MODE = { HORIZONTAL: 'row', VERTICAL: 'column', GRID: 'grid' };
const GRADIENT = {
  GRADIENT_LINEAR: 'linear',
  GRADIENT_RADIAL: 'radial',
  GRADIENT_ANGULAR: 'angular',
  GRADIENT_DIAMOND: 'diamond',
};
const EFFECT = { DROP_SHADOW: 'drop', INNER_SHADOW: 'inner', LAYER_BLUR: 'blur', BACKGROUND_BLUR: 'backdrop' };

export const safeId = (id) => String(id).replace(/:/g, '-').replace(/;/g, '_');

/** Без undefined, null, пустых массивов и пустых объектов: снимок читают, и шум в нём дорог. */
export function strip(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) continue;
    out[key] = value;
  }
  return out;
}

const rgba = (c, opacity = 1) =>
  c
    ? {
        r: Math.round(c.r * 255),
        g: Math.round(c.g * 255),
        b: Math.round(c.b * 255),
        a: round((c.a ?? 1) * opacity, 3),
      }
    : null;

const rect = (r) => (r ? { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) } : undefined);

function aliases(bound) {
  if (!bound || typeof bound !== 'object') return undefined;
  const out = {};
  for (const [field, value] of Object.entries(bound)) {
    if (Array.isArray(value)) {
      const ids = value.map((v) => v?.id).filter(Boolean);
      if (ids.length) out[field] = ids;
    } else if (value?.id) {
      out[field] = value.id;
    } else if (value && typeof value === 'object') {
      const nested = aliases(value);
      if (nested) out[field] = nested;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizePaint(paint) {
  if (!paint || paint.visible === false) return null;
  const opacity = paint.opacity ?? 1;
  const vars = aliases(paint.boundVariables);
  const extra = vars ? { vars } : {};
  if (paint.type === 'SOLID') return { kind: 'solid', color: rgba(paint.color, opacity), ...extra };
  if (GRADIENT[paint.type]) {
    return {
      kind: GRADIENT[paint.type],
      handles: (paint.gradientHandlePositions || []).map(({ x, y }) => ({ x: round(x, 4), y: round(y, 4) })),
      stops: (paint.gradientStops || []).map((s) => ({ color: rgba(s.color, opacity), pos: round(s.position, 4) })),
      ...extra,
    };
  }
  if (paint.type === 'IMAGE') {
    return strip({
      kind: 'image',
      ref: paint.imageRef,
      scaleMode: paint.scaleMode,
      transform: paint.imageTransform,
      opacity: opacity < 1 ? round(opacity, 3) : undefined,
      ...extra,
    });
  }
  return null;
}

const paints = (list) => {
  const out = (list || []).map(normalizePaint).filter(Boolean);
  return out.length ? out : undefined;
};

function normalizeEffect(effect) {
  if (!effect || effect.visible === false) return null;
  const type = EFFECT[effect.type];
  if (!type) return null;
  const out = { type, blur: round(effect.radius ?? 0) };
  if (type === 'drop' || type === 'inner') {
    Object.assign(out, {
      x: round(effect.offset?.x ?? 0),
      y: round(effect.offset?.y ?? 0),
      spread: round(effect.spread ?? 0),
      color: rgba(effect.color),
    });
  }
  return out;
}

export function normalizeTypeStyle(s, { partial = false } = {}) {
  if (!s) return undefined;
  let lineHeight;
  if (s.lineHeightUnit === 'PIXELS' && s.lineHeightPx != null) {
    lineHeight = { unit: 'px', value: round(s.lineHeightPx) };
  } else if (s.lineHeightUnit === 'FONT_SIZE_%' && s.lineHeightPercentFontSize != null) {
    lineHeight = { unit: '%', value: round(s.lineHeightPercentFontSize) };
  } else if (s.lineHeightUnit === 'INTRINSIC_%' || (!partial && s.lineHeightPx != null)) {
    lineHeight = strip({ unit: 'auto', px: s.lineHeightPx ? round(s.lineHeightPx) : undefined });
  }
  return strip({
    family: s.fontFamily,
    weight: s.fontWeight,
    size: s.fontSize,
    italic: s.italic || undefined,
    lineHeight,
    letterSpacing: s.letterSpacing ? round(s.letterSpacing) : undefined,
    case: s.textCase && s.textCase !== 'ORIGINAL' ? s.textCase : undefined,
    decoration: s.textDecoration && s.textDecoration !== 'NONE' ? s.textDecoration : undefined,
    align: s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT' ? s.textAlignHorizontal : undefined,
    alignV: s.textAlignVertical && s.textAlignVertical !== 'TOP' ? s.textAlignVertical : undefined,
    paragraphSpacing: s.paragraphSpacing || undefined,
    autoResize: partial ? undefined : s.textAutoResize,
    truncate: s.textTruncation === 'ENDING' || undefined,
    maxLines: s.maxLines || undefined,
    vars: aliases(s.boundVariables),
  });
}

function textOf(raw) {
  const chars = raw.characters ?? '';
  const { autoResize, truncate, maxLines, ...style } = normalizeTypeStyle(raw.style) || {};
  const out = strip({ chars, autoResize: raw.textAutoResize ?? autoResize, truncate, maxLines, style });

  /* Смешанное оформление внутри строки: жирное слово, ссылка другим цветом. Без него «один
     текст» из макета превращается в один span, и акцент теряется. */
  const overrides = raw.characterStyleOverrides;
  const table = raw.styleOverrideTable;
  if (overrides?.length && table) {
    const runs = [];
    let current = null;
    for (let i = 0; i < chars.length; i += 1) {
      const id = overrides[i] ?? 0;
      if (!current || current.id !== id) {
        current = { id, start: i, end: i + 1 };
        runs.push(current);
      } else {
        current.end = i + 1;
      }
    }
    const styled = runs
      .filter((run) => run.id && table[run.id])
      .slice(0, 50)
      .map((run) =>
        strip({
          start: run.start,
          end: run.end,
          text: chars.slice(run.start, run.end),
          style: normalizeTypeStyle(table[run.id], { partial: true }),
          fills: paints(table[run.id].fills),
        }),
      );
    if (styled.length) out.runs = styled;
  }
  return out;
}

function layoutOf(raw) {
  const mode = LAYOUT_MODE[raw.layoutMode];
  if (!mode) return undefined;
  return strip({
    mode,
    gap: round(raw.itemSpacing || 0),
    crossGap: raw.counterAxisSpacing != null ? round(raw.counterAxisSpacing) : undefined,
    wrap: raw.layoutWrap === 'WRAP' || undefined,
    padding: [raw.paddingTop, raw.paddingRight, raw.paddingBottom, raw.paddingLeft].map((v) => round(v || 0)),
    main: raw.primaryAxisAlignItems || 'MIN',
    cross: raw.counterAxisAlignItems || 'MIN',
    grid:
      mode === 'grid'
        ? strip({
            columns: raw.gridColumnCount,
            rows: raw.gridRowCount,
            columnGap: raw.gridColumnGap,
            rowGap: raw.gridRowGap,
          })
        : undefined,
    reverseZ: raw.itemReverseZIndex || undefined,
  });
}

function itemOf(raw) {
  return strip({
    sizingH: raw.layoutSizingHorizontal,
    sizingV: raw.layoutSizingVertical,
    absolute: raw.layoutPositioning === 'ABSOLUTE' || undefined,
    grow: raw.layoutGrow || undefined,
    min: strip({ w: raw.minWidth, h: raw.minHeight }),
    max: strip({ w: raw.maxWidth, h: raw.maxHeight }),
  });
}

function strokeOf(raw) {
  if (!raw.strokes?.some((paint) => paint.visible !== false)) return undefined;
  const w = raw.individualStrokeWeights;
  return strip({
    weight: raw.strokeWeight,
    weights: w ? [w.top, w.right, w.bottom, w.left] : undefined,
    align: raw.strokeAlign,
    dashes: raw.strokeDashes,
  });
}

function radiusOf(raw) {
  const radii = raw.rectangleCornerRadii;
  if (radii?.length === 4) {
    return radii.every((r) => r === radii[0]) ? radii[0] || undefined : radii.map((r) => round(r));
  }
  return raw.cornerRadius || undefined;
}

/**
 * Поворот из матрицы.
 *
 * Отдельного поля rotation у REST-узлов нет — угол есть только в relativeTransform, а он
 * приходит лишь с geometry=paths. Экранные координаты растут вниз, поэтому atan2 здесь сразу
 * даёт угол по часовой стрелке, как у CSS rotate().
 */
function rotationOf(raw) {
  const m = raw.relativeTransform;
  if (!m?.[0] || !m?.[1]) return undefined;
  const deg = round((Math.atan2(m[1][0], m[0][0]) * 180) / Math.PI);
  return Math.abs(deg) >= 0.5 ? deg : undefined;
}

function componentOf(raw, context) {
  if (raw.type === 'INSTANCE') {
    const meta = context.components?.[raw.componentId];
    const set = meta?.componentSetId ? context.componentSets?.[meta.componentSetId] : null;
    const props = {};
    for (const [name, prop] of Object.entries(raw.componentProperties || {})) {
      props[name.replace(/#[^#]*$/, '')] = prop?.value ?? prop;
    }
    return strip({ id: raw.componentId, name: meta?.name, set: set?.name, key: meta?.key, props });
  }
  if (raw.type === 'COMPONENT' || raw.type === 'COMPONENT_SET') return { definition: true };
  return undefined;
}

function stylesOf(raw, context) {
  if (!raw.styles) return undefined;
  const out = {};
  for (const [kind, id] of Object.entries(raw.styles)) out[kind] = context.styles?.[id]?.name ?? id;
  return out;
}

function vectorHash(raw) {
  const geometry = raw.fillGeometry?.length ? raw.fillGeometry : raw.strokeGeometry;
  if (!geometry?.length) return undefined;
  return crypto.createHash('sha1').update(JSON.stringify(geometry.map((g) => g.path))).digest('hex').slice(0, 12);
}

/**
 * Дерево REST → плоская карта узлов.
 *
 * context — то, что /nodes отдаёт рядом с document: components, componentSets, styles. Без них
 * инстанс знает только id главного компонента, а не его имя и набор вариантов.
 */
export function normalizeRestTree(document, context = {}) {
  const nodes = {};
  const visit = (raw, parent) => {
    const node = strip({
      id: raw.id,
      parent,
      type: raw.type,
      name: raw.name,
      visible: raw.visible === false ? false : undefined,
      box: rect(raw.absoluteBoundingBox),
      render:
        raw.absoluteRenderBounds &&
        JSON.stringify(rect(raw.absoluteRenderBounds)) !== JSON.stringify(rect(raw.absoluteBoundingBox))
          ? rect(raw.absoluteRenderBounds)
          : undefined,
      rotation: rotationOf(raw),
      opacity: raw.opacity != null && raw.opacity < 1 ? round(raw.opacity, 3) : undefined,
      blend: raw.blendMode && !['PASS_THROUGH', 'NORMAL'].includes(raw.blendMode) ? raw.blendMode : undefined,
      clips: raw.clipsContent || undefined,
      isMask: raw.isMask || undefined,
      layout: layoutOf(raw),
      item: itemOf(raw),
      constraints: raw.constraints,
      fills: paints(raw.fills),
      strokes: paints(raw.strokes),
      stroke: strokeOf(raw),
      radius: radiusOf(raw),
      effects: (raw.effects || []).map(normalizeEffect).filter(Boolean),
      text: raw.type === 'TEXT' ? textOf(raw) : undefined,
      component: componentOf(raw, context),
      vars: aliases(raw.boundVariables),
      styles: stylesOf(raw, context),
      interactions: raw.interactions?.length ? raw.interactions : undefined,
      scrollBehavior: raw.scrollBehavior && raw.scrollBehavior !== 'SCROLLS' ? raw.scrollBehavior : undefined,
      overlay: raw.overlayPositionType
        ? strip({
            position: raw.overlayPositionType,
            background: raw.overlayBackground?.type,
            interaction: raw.overlayBackgroundInteraction,
          })
        : undefined,
      overflow: raw.overflowDirection && raw.overflowDirection !== 'NONE' ? raw.overflowDirection : undefined,
      annotations: raw.annotations,
      devStatus: raw.devStatus?.type,
      vectorHash: vectorHash(raw),
    });
    nodes[raw.id] = node;
    if (raw.children?.length) {
      node.children = [];
      for (const child of raw.children) {
        visit(child, raw.id);
        node.children.push(child.id);
      }
    }
  };
  visit(document, null);
  return nodes;
}

export const childNodes = (snapshot, node) => (node.children || []).map((id) => snapshot.nodes[id]).filter(Boolean);

/** Обход поддерева. fn вернул false — вглубь этого узла не идём. */
export function walk(snapshot, rootId, fn) {
  const stack = [rootId];
  while (stack.length) {
    const node = snapshot.nodes[stack.pop()];
    if (!node) continue;
    if (fn(node) === false) continue;
    for (const id of [...(node.children || [])].reverse()) stack.push(id);
  }
}

export function guessBreakpoint(width) {
  if (!width) return undefined;
  if (width < 600) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

export function summarize(snapshot) {
  const root = snapshot.nodes[snapshot.root];
  const counts = { nodes: 0, texts: 0, instances: 0, images: 0, interactions: 0, hidden: 0 };
  for (const node of Object.values(snapshot.nodes)) {
    counts.nodes += 1;
    if (node.type === 'TEXT') counts.texts += 1;
    if (node.type === 'INSTANCE') counts.instances += 1;
    if (node.fills?.some((paint) => paint.kind === 'image')) counts.images += 1;
    if (node.interactions) counts.interactions += 1;
    if (node.visible === false) counts.hidden += 1;
  }
  return strip({
    ref: refOf(snapshot.fileKey, root.id),
    name: root.name,
    type: root.type,
    size: root.box ? `${round(root.box.w)}x${round(root.box.h)}` : undefined,
    breakpoint: guessBreakpoint(root.box?.w),
    channel: snapshot.channel,
    counts,
    variables: snapshot.variables ? Object.keys(snapshot.variables).length : undefined,
  });
}

export function addRequests(total, part) {
  for (const [key, value] of Object.entries(part || {})) total[key] = (total[key] || 0) + value;
  return total;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data), 'utf8');
}

const metaPath = (cacheDir, fileKey) => path.join(cacheDir, fileKey, 'meta.json');

export function readMeta(fileKey, { cacheDir = DIRS.figma } = {}) {
  return readJson(metaPath(cacheDir, fileKey));
}

/**
 * Узел ищется не только среди снятых корней, но и внутри них: карточка внутри снятого экрана
 * уже есть в снимке, и снимать её отдельно — лишний запрос.
 */
export async function findNode(fileKey, nodeId, { cacheDir = DIRS.figma } = {}) {
  const meta = await readMeta(fileKey, { cacheDir });
  if (!meta?.roots || !meta.version) return null;
  const roots = Object.keys(meta.roots);
  const order = meta.roots[nodeId] ? [nodeId, ...roots.filter((id) => id !== nodeId)] : roots;
  for (const rootId of order) {
    const entry = meta.roots[rootId];
    if (entry.version !== meta.version) continue;
    const snapshot = await readJson(path.join(cacheDir, fileKey, entry.file));
    if (snapshot?.nodes?.[nodeId]) return { snapshot, node: snapshot.nodes[nodeId], fileKey };
  }
  return null;
}

export async function loadSnapshot(fileKey, rootId, { cacheDir = DIRS.figma } = {}) {
  const meta = await readMeta(fileKey, { cacheDir });
  const entry = meta?.roots?.[rootId];
  return entry ? readJson(path.join(cacheDir, fileKey, entry.file)) : null;
}

/**
 * Версия снимка, снятого редактором без токена REST: узнать настоящую версию файла неоткуда.
 * Такой снимок считается устаревшим по сроку, а не по версии — перснятие через редактор бесплатно.
 */
const localVersion = (ms) => `local-${new Date(ms).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
const isLocal = (version) => String(version || '').startsWith('local-');

/** Что редактор принёс сверх REST: CSS от Figma, анимации и значения переменных. */
function attachExtras(snapshot, extras) {
  for (const [id, css] of Object.entries(extras.css || {})) if (snapshot.nodes[id]) snapshot.nodes[id].css = css;
  for (const [id, motion] of Object.entries(extras.motion || {})) if (snapshot.nodes[id]) snapshot.nodes[id].motion = motion;
  const variables = {};
  const add = (id) => {
    if (variables[id] || !extras.variables?.[id]) return;
    variables[id] = extras.variables[id];
    for (const value of Object.values(extras.variables[id].modes || {})) {
      if (value?.type === 'VARIABLE_ALIAS') add(value.id);
    }
  };
  for (const id of new Set(JSON.stringify(snapshot.nodes).match(/VariableID:[^"\\]+/g) || [])) add(id);
  if (Object.keys(variables).length) snapshot.variables = variables;
  if (typeof extras.motionSupported === 'string') snapshot.motionUnsupported = extras.motionSupported;
}

async function syncFile({ fileKey, nodeIds, wholeFile }, ctx) {
  const { refresh, client, cacheDir, now, spent, editor, channel, css } = ctx;
  const meta = (await readMeta(fileKey, { cacheDir })) || { fileKey, roots: {} };
  meta.roots ||= {};
  const out = { fileKey };
  const stamp = () => new Date(now()).toISOString();
  const noteVersion = (version) => {
    if (!version) return;
    const next = String(version);
    if (meta.version && meta.version !== next && !isLocal(meta.version) && !isLocal(next)) {
      out.changed = { from: meta.version, to: next };
    }
    meta.version = next;
  };

  /*
   * Выбор канала. auto берёт редактор, когда в него есть вход: у него нет лимита. REST остаётся
   * запасным путём и единственным источником версии файла. Явный канал не подменяется молча:
   * «снимал редактором» и «снимал REST» различаются тем, что попало в снимок.
   */
  const tokenOk = client.usable ? await client.usable() : true;
  const restOk = channel !== 'editor' && tokenOk;
  const editorOk = channel !== 'rest' && Boolean(editor) && (await editor.usable());
  if (channel === 'editor' && !editorOk) {
    throw new Error('Канал редактора недоступен: figma_status покажет причину и что с ней делать.');
  }
  if (!restOk && !editorOk) {
    throw new Error(
      'Figma недоступна: нет ни токена REST (FIGMA_TOKEN), ни входа в редактор (FIGMA_EMAIL и FIGMA_PASSWORD или сохранённое состояние). Подробности — figma_status.',
    );
  }
  const wantCss = css && editorOk;
  if (css && !editorOk) out.cssUnavailable = 'CSS от самой Figma даёт только канал редактора, а он сейчас недоступен.';

  const fresh = meta.checkedAt && now() - Date.parse(meta.checkedAt) < META_TTL_MS;
  if ((refresh || !fresh) && nodeIds.some((id) => meta.roots[id]) && !wholeFile) {
    if (tokenOk) {
      const res = await client.fileMeta(fileKey);
      spent.tier3 += 1;
      const file = res.file || res;
      noteVersion(file.version);
      meta.name = file.name ?? meta.name;
      meta.lastModified = file.last_touched_at ?? meta.lastModified;
    } else {
      meta.version = localVersion(now());
    }
    meta.checkedAt = stamp();
  }

  if (wholeFile) {
    /* Файл целиком обычно огромен, а человеку нужен список кадров, чтобы выбрать. Глубина 2 —
       это страницы и их кадры верхнего уровня. */
    let pages;
    if (restOk) {
      const res = await client.file(fileKey, { depth: 2 });
      spent.tier1 += 1;
      noteVersion(res.version);
      meta.name = res.name ?? meta.name;
      meta.lastModified = res.lastModified ?? meta.lastModified;
      pages = (res.document?.children || []).map((page) => ({
        id: page.id,
        name: page.name,
        frames: (page.children || [])
          .filter((frame) => frame.visible !== false)
          .map((frame) => ({
            id: frame.id,
            name: frame.name,
            type: frame.type,
            w: frame.absoluteBoundingBox?.width,
            h: frame.absoluteBoundingBox?.height,
          })),
      }));
    } else {
      pages = await editor.pages(fileKey);
      out.channel = 'editor';
    }
    meta.checkedAt = stamp();
    out.pages = pages.map((page) =>
      strip({
        id: page.id,
        name: page.name,
        frames: page.frames.slice(0, 100).map((frame) =>
          strip({
            ref: refOf(fileKey, frame.id),
            name: frame.name,
            type: frame.type,
            size: frame.w ? `${round(frame.w)}x${round(frame.h)}` : undefined,
            breakpoint: guessBreakpoint(frame.w),
          }),
        ),
        more: page.frames.length > 100 ? page.frames.length - 100 : undefined,
      }),
    );
  }

  const missing = nodeIds.filter((id) => wantCss || !meta.version || meta.roots[id]?.version !== meta.version);
  const hits = nodeIds.filter((id) => !missing.includes(id));
  const notFound = [];

  if (missing.length) {
    let fetched = null;
    if (editorOk) {
      try {
        const dump = await editor.dump(fileKey, missing, { css: wantCss });
        let version = meta.version && !isLocal(meta.version) && fresh ? meta.version : null;
        if (!version && tokenOk) {
          try {
            const res = await client.fileMeta(fileKey);
            spent.tier3 += 1;
            const file = res.file || res;
            version = file.version ? String(file.version) : null;
            meta.name = file.name ?? meta.name;
            meta.lastModified = file.last_touched_at ?? meta.lastModified;
          } catch {
            version = null;
          }
        }
        fetched = { channel: 'editor', version: version || localVersion(now()), entries: dump.nodes || {}, extras: dump };
      } catch (err) {
        if (channel === 'editor' || !restOk) throw err;
        out.editorFallback = err.message;
      }
    }
    if (!fetched) {
      const res = await client.fileNodes(fileKey, missing);
      spent.tier1 += 1;
      meta.name = res.name ?? meta.name;
      meta.lastModified = res.lastModified ?? meta.lastModified;
      meta.editorType = res.editorType ?? meta.editorType;
      fetched = { channel: 'rest', version: res.version, entries: res.nodes || {} };
    }
    noteVersion(fetched.version);
    meta.checkedAt = stamp();
    out.channel = fetched.channel;

    for (const id of missing) {
      const entry = fetched.entries[id];
      if (!entry?.document) {
        notFound.push(id);
        continue;
      }
      const snapshot = {
        fileKey,
        root: id,
        version: meta.version,
        fetchedAt: meta.checkedAt,
        channel: fetched.channel,
        nodes: normalizeRestTree(entry.document, entry),
      };
      if (fetched.extras) attachExtras(snapshot, fetched.extras);
      const rel = `${meta.version}/${safeId(id)}.json`;
      await writeJson(path.join(cacheDir, fileKey, rel), snapshot);
      meta.roots[id] = { version: meta.version, file: rel, fetchedAt: meta.checkedAt, channel: fetched.channel };
    }
  }

  await writeJson(metaPath(cacheDir, fileKey), meta);

  Object.assign(out, strip({ name: meta.name, version: meta.version, lastModified: meta.lastModified }));
  if (nodeIds.length) {
    out.cache = { hit: hits, fetched: missing.filter((id) => !notFound.includes(id)) };
    out.frames = [];
    for (const id of nodeIds) {
      if (notFound.includes(id)) continue;
      const snapshot = await loadSnapshot(fileKey, id, { cacheDir });
      if (snapshot) out.frames.push(summarize(snapshot));
    }
  }
  if (notFound.length) out.notFound = notFound;
  return out;
}

/**
 * Снять узлы в снимок.
 *
 * Все узлы одного файла — одним запросом /nodes, уже снятые берутся из кэша. Версия файла
 * сверяется не чаще раза в десять минут отдельным запросом tier 3: он стоит впятеро дешевле
 * по лимиту, чем повторное снятие узлов.
 */
export async function syncFigma(
  refs,
  {
    refresh = false,
    client = getRestClient(),
    cacheDir = DIRS.figma,
    now = () => Date.now(),
    editor = null,
    channel = 'auto',
    css = false,
  } = {},
) {
  const spent = { tier1: 0, tier2: 0, tier3: 0 };
  const files = [];
  for (const group of groupRefs(refs)) {
    files.push(await syncFile(group, { refresh, client, cacheDir, now, spent, editor, channel, css }));
  }
  return { files, requests: spent };
}

/** Узлы одного файла из кэша, недостающие — одним снятием. */
export async function ensureNodes(fileKey, nodeIds, { client = getRestClient(), cacheDir = DIRS.figma, editor = null } = {}) {
  const found = new Map();
  const missing = [];
  for (const id of nodeIds) {
    const hit = await findNode(fileKey, id, { cacheDir });
    if (hit) found.set(id, hit);
    else missing.push(id);
  }
  let requests = null;
  if (missing.length) {
    ({ requests } = await syncFigma(
      missing.map((id) => refOf(fileKey, id)),
      { client, cacheDir, editor },
    ));
    for (const id of missing) {
      const hit = await findNode(fileKey, id, { cacheDir });
      if (!hit) throw new Error(`Узел ${id} не найден в файле ${fileKey}: неверный id, либо узел удалён из макета.`);
      found.set(id, hit);
    }
  }
  return { found, requests };
}

export async function ensureNode(input, options = {}) {
  const { fileKey, nodeId } = parseFigmaRef(input);
  if (!nodeId) throw new Error('Нужен узел, а не файл целиком: ссылка с node-id или запись ключ:id.');
  const { found, requests } = await ensureNodes(fileKey, [nodeId], options);
  return { ...found.get(nodeId), fileKey, nodeId, requests };
}
