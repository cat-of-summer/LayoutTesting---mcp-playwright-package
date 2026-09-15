/**
 * Выгрузка из макета: рендеры, SVG и растровые заливки.
 *
 * Три вещи, которые в прошлый раз делались руками:
 *
 *   - ссылки на ассеты жили семь дней, и всё приходилось скачивать сразу. Здесь файл сразу
 *     ложится в артефакты и в кэш по версии макета;
 *   - полностраничный рендер мобильного кадра 380×3782 пришёл шириной 91 px. Здесь масштаб
 *     подбирается под читаемую ширину, а высокий кадр режется на части;
 *   - иллюстрацию приходилось вырезать ImageMagick по процентам из CSS. Здесь заливка
 *     кадрируется по imageTransform так же, как в макете.
 *
 * Канал тот же, что у снимка: редактор, если в него есть вход (лимита нет), иначе REST. Отказ
 * редактора не роняет выгрузку, а переводит её в REST с пометкой editorFallback.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DIRS } from '../constants.js';
import { artifactRef, newRunId, runDir, slug } from '../artifacts.js';
import { round } from './css.js';
import { getRestClient } from './rest.js';
import { addRequests, childNodes, ensureNodes, safeId, strip, walk } from './snapshot.js';
import { groupRefs, refOf } from './url.js';

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

async function writeFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

/** Масштаб, при котором кадр читается: около тысячи точек по ширине, но не мельче исходника. */
export function autoScale(width) {
  if (!width || width >= 1000) return 1;
  return Math.min(4, Math.ceil((1000 / width) * 2) / 2);
}

/**
 * Высокий кадр → части.
 *
 * Картинка в 380×3782, ужатая под окно просмотра, нечитаема целиком. Части по полторы ширины с
 * перекрытием дают кадр, где виден и шрифт, и стык соседних блоков.
 */
export async function sliceTiles(file, dir, base, { ratio = 2.2, tileRatio = 1.4, overlap = 40 } = {}) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height || height <= width * ratio) return null;
  const tileHeight = Math.round(width * tileRatio);
  const tiles = [];
  for (let top = 0, index = 1; top < height; index += 1) {
    const h = Math.min(tileHeight, height - top);
    const out = path.join(dir, `${base}.part-${String(index).padStart(2, '0')}.png`);
    await sharp(file).extract({ left: 0, top, width, height: h }).png().toFile(out);
    tiles.push({ index, top, height: h, out });
    if (top + h >= height) break;
    top += h - overlap;
  }
  return tiles;
}

/**
 * Части по дочерним фреймам верхнего уровня: одна часть — одна секция макета.
 *
 * Резка по полторы ширины отдаёт 25 кусков на длинный мобильный кадр, и стык секции попадает
 * посередине куска. Агент прочитал шесть и додумал остальное. Часть, совпадающая с секцией и
 * подписанная её узлом, читается как оглавление: видно, что это за блок и где он в дереве.
 */
export async function sliceByChildren(file, dir, base, snapshot, node, scale) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height || !node?.box) return null;
  const kids = childNodes(snapshot, node)
    .filter((kid) => kid.visible !== false && kid.box && kid.box.h >= 8)
    .sort((a, b) => a.box.y - b.box.y);
  if (!kids.length) return null;
  const tiles = [];
  for (const [index, kid] of kids.entries()) {
    const top = Math.max(0, Math.min(height - 1, Math.round((kid.box.y - node.box.y) * scale)));
    const h = Math.min(height - top, Math.max(1, Math.round(kid.box.h * scale)));
    if (h <= 0) continue;
    const out = path.join(dir, `${base}.part-${String(index + 1).padStart(2, '0')}.png`);
    await sharp(file).extract({ left: 0, top, width, height: h }).png().toFile(out);
    tiles.push({ index: index + 1, top, height: h, out, node: kid.id, name: kid.name });
  }
  return tiles.length ? tiles : null;
}

/**
 * Попробовать редактор, при отказе — REST.
 *
 * viaEditor получает управление первым и возвращает true, если справился. Ошибка редактора
 * записывается в state.fallback и не мешает REST; если REST недоступен, она поднимается как есть.
 */
async function withChannels({ editor, client, state }, viaEditor, viaRest) {
  if (editor && (await editor.usable())) {
    try {
      await viaEditor();
      state.channel = 'editor';
      return;
    } catch (err) {
      if (!(await client.usable?.()) && client.usable) throw err;
      state.fallback = err.message;
    }
  }
  await viaRest();
  state.channel = 'rest';
}

export async function exportRender(refs, { client = getRestClient(), cacheDir = DIRS.figma, editor = null, scale, clip, parts = 'auto' } = {}) {
  const runId = newRunId('figma-render');
  const dir = await runDir(runId);
  const requests = { tier1: 0 };
  const state = {};
  const renders = [];

  for (const group of groupRefs(refs)) {
    if (!group.nodeIds.length) throw new Error('Для render нужны узлы: ссылка с node-id или запись ключ:id.');
    const { found, requests: spent } = await ensureNodes(group.fileKey, group.nodeIds, { client, cacheDir, editor });
    addRequests(requests, spent);

    const plan = group.nodeIds.map((id) => {
      const { snapshot, node } = found.get(id);
      const s = scale ?? autoScale(clip?.width ?? node.box?.w);
      return {
        id,
        node,
        snapshot,
        scale: s,
        cached: path.join(cacheDir, group.fileKey, snapshot.version, 'renders', `${safeId(id)}@${s}x.png`),
      };
    });

    const missing = [];
    for (const item of plan) if (!(await exists(item.cached))) missing.push(item);

    if (missing.length) {
      await withChannels(
        { editor, client, state },
        async () => {
          const res = await editor.render(
            group.fileKey,
            missing.map((item) => ({ id: item.id, scale: item.scale, format: 'png' })),
          );
          for (const item of missing) {
            if (res[item.id]?.base64) await writeFile(item.cached, Buffer.from(res[item.id].base64, 'base64'));
            else {
              item.error = `Редактор не отрисовал узел: ${res[item.id]?.error || 'нет ответа'}.`;
              item.hint = hiddenHint(item.snapshot, item.id);
            }
          }
        },
        async () => {
          const byScale = new Map();
          for (const item of missing) byScale.set(item.scale, [...(byScale.get(item.scale) || []), item]);
          for (const [s, items] of byScale) {
            const res = await client.images(group.fileKey, items.map((item) => item.id), { format: 'png', scale: s });
            requests.tier1 += 1;
            for (const item of items) {
              const url = res.images?.[item.id];
              if (!url) {
                item.error = res.err || 'Figma не отрисовала узел: он пустой, скрыт или больше 32 мегапикселей.';
                item.hint = hiddenHint(item.snapshot, item.id);
                continue;
              }
              delete item.error;
              delete item.hint;
              await writeFile(item.cached, await client.download(url));
            }
          }
        },
      );
    }

    for (const item of plan) {
      const ref = refOf(group.fileKey, item.id);
      if (item.error) {
        renders.push(strip({ ref, error: item.error, hint: item.hint }));
        continue;
      }
      const base = `${slug(item.node.name) || 'node'}-${safeId(item.id)}@${item.scale}x`;
      const file = path.join(dir, `${base}.png`);
      if (clip) {
        const meta = await sharp(item.cached).metadata();
        const left = Math.max(0, Math.round(clip.x * item.scale));
        const top = Math.max(0, Math.round(clip.y * item.scale));
        const width = Math.min(meta.width - left, Math.round(clip.width * item.scale));
        const height = Math.min(meta.height - top, Math.round(clip.height * item.scale));
        if (width <= 0 || height <= 0) throw new Error(`clip выходит за узел ${item.id} размером ${item.node.box?.w}x${item.node.box?.h}.`);
        await sharp(item.cached).extract({ left, top, width, height }).png().toFile(file);
      } else {
        await fs.copyFile(item.cached, file);
      }
      const meta = await sharp(file).metadata();
      const entry = strip({
        ref,
        name: item.node.name,
        scale: item.scale,
        size: `${meta.width}x${meta.height}`,
        image: artifactRef(file),
        ...(clip ? {} : clipHint(item.snapshot, item.id)),
        ...(clip ? {} : oversizedHint(item.node, meta, item.scale)),
      });
      const tiles =
        parts === 'children' && !clip
          ? await sliceByChildren(file, dir, base, item.snapshot, item.node, item.scale)
          : await sliceTiles(file, dir, base);
      if (tiles) {
        entry.parts = tiles.map((tile) =>
          strip({
            index: tile.index,
            node: tile.node,
            name: tile.name,
            cssTop: round(tile.top / item.scale),
            cssHeight: round(tile.height / item.scale),
            image: artifactRef(tile.out),
          }),
        );
        if (parts === 'children') entry.partsNote = 'Части нарезаны по дочерним фреймам верхнего уровня: node и name у каждой — это узел секции.';
      } else if (parts === 'children') {
        entry.partsNote = 'У узла нет видимых дочерних фреймов, резать по секциям не по чему — отдан один файл.';
      }
      renders.push(entry);
    }
  }
  return strip({ runId, renders, channel: state.channel, editorFallback: state.fallback, requests });
}

/**
 * SVG из Figma → файл, который можно положить в спрайт.
 *
 * Одноцветная иконка получает currentColor: цвет в вёрстке задаётся родителем, и захардкоженный
 * #082344 пришлось бы вычищать руками. id внутри файла получают префикс: два SVG с одинаковым
 * paint0_linear на одной странице молча красят друг друга.
 */
export function normalizeSvg(svg, { prefix = 'icon' } = {}) {
  let out = String(svg)
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const referenced = new Set([...out.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)].map((m) => m[1] || m[2]));
  out = out
    .replace(/\s+id="([^"]+)"/g, (full, id) => (referenced.has(id) ? ` id="${prefix}-${id}"` : ''))
    .replace(/url\(#([^)]+)\)/g, (full, id) => `url(#${prefix}-${id})`)
    .replace(/href="#([^"]+)"/g, (full, id) => `href="#${prefix}-${id}"`);

  const colors = new Set(
    [...out.matchAll(/\s(?:fill|stroke)="([^"]+)"/g)]
      .map((m) => m[1].toLowerCase())
      .filter((value) => value !== 'none' && !value.startsWith('url(')),
  );
  const monochrome = colors.size === 1 && referenced.size === 0;
  if (monochrome) {
    const [color] = colors;
    out = out.replace(/(\s(?:fill|stroke)=")([^"]+)(")/g, (full, head, value, tail) =>
      value.toLowerCase() === color ? `${head}currentColor${tail}` : full,
    );
  }
  const width = /<svg[^>]*\swidth="([\d.]+)"/.exec(out);
  const height = /<svg[^>]*\sheight="([\d.]+)"/.exec(out);
  return {
    svg: out,
    monochrome,
    colors: [...colors],
    /* Цвет, который ушёл под currentColor: без него в вёрстке иконка наследует цвет текста и
       становится чёрной. Отдаём его рядом, чтобы color на обёртке брали отсюда, а не «по смыслу». */
    color: monochrome ? [...colors][0] : null,
    width: width ? Number(width[1]) : null,
    height: height ? Number(height[1]) : null,
  };
}

/**
 * Что из узла видно в макете, если предок его обрезает.
 *
 * Рендер делается по узлу и не знает об обрезке родителем: кнопка-вкладка, из которой в макете
 * торчат 45px, отрисовалась целиком, и смещение за край прочли как небрежность и «исправили».
 * Здесь считается пересечение box узла с box каждого предка, у которого clips: true; если
 * пересечение меньше узла — в ответе появляется clipped с видимой частью и стороной обрезки.
 */
export function clipHint(snapshot, id) {
  const node = snapshot?.nodes?.[id];
  if (!node?.box) return {};
  let visible = { ...node.box };
  let by = null;
  for (let current = snapshot.nodes[node.parent]; current; current = snapshot.nodes[current.parent]) {
    if (!current.clips || !current.box) continue;
    const left = Math.max(visible.x, current.box.x);
    const top = Math.max(visible.y, current.box.y);
    const right = Math.min(visible.x + visible.w, current.box.x + current.box.w);
    const bottom = Math.min(visible.y + visible.h, current.box.y + current.box.h);
    const next = { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
    if (next.w < visible.w - 0.5 || next.h < visible.h - 0.5) {
      by = by || { id: current.id, name: current.name };
      visible = next;
    }
  }
  if (!by) return {};
  const sides = [];
  if (visible.x > node.box.x + 0.5) sides.push('left');
  if (visible.x + visible.w < node.box.x + node.box.w - 0.5) sides.push('right');
  if (visible.y > node.box.y + 0.5) sides.push('top');
  if (visible.y + visible.h < node.box.y + node.box.h - 0.5) sides.push('bottom');
  const hidden = visible.w <= 0 || visible.h <= 0;
  return {
    clipped: {
      by: by.id,
      byName: by.name,
      visible: hidden ? 'ничего' : `${round(visible.w)}x${round(visible.h)} из ${round(node.box.w)}x${round(node.box.h)}`,
      sides,
      offset: { x: round(visible.x - node.box.x), y: round(visible.y - node.box.y) },
      note: hidden
        ? 'В макете узел целиком за краем родителя с clip: рендер сделан без обрезки и показывает то, чего на холсте не видно.'
        : 'В макете виден не весь узел: родитель обрезает его (clipsContent), а рендер сделан без обрезки. Смещение за край — задумка (вкладка, выезжающий элемент), пока узел не доказал обратное.',
    },
  };
}

/**
 * Рендер выше или шире рамки узла — содержимое выходит за кадр.
 *
 * Мобильный кадр 380×6376 отрисовался высотой 12141: у кадра выключен clipsContent, и дети
 * лежат ниже его рамки. Без пометки это читается как «кадр такой и есть», а в вёрстке
 * выясняется, что половина секций в макете стоит за пределами страницы.
 */
export function oversizedHint(node, meta, scale) {
  if (!node?.box || !meta?.width || !meta?.height || !scale) return {};
  const w = meta.width / scale;
  const h = meta.height / scale;
  if (w <= node.box.w * 1.02 && h <= node.box.h * 1.02) return {};
  return {
    oversized: {
      frame: `${round(node.box.w)}x${round(node.box.h)}`,
      rendered: `${round(w)}x${round(h)}`,
      note: 'Рендер больше рамки узла: содержимое выходит за кадр (clipsContent выключен). Координаты в figma_inspect по-прежнему от рамки; то, что ниже или правее неё, в макете лежит за пределами кадра.',
    },
  };
}

/**
 * Почему узел не выгрузился, если причина видна по снимку.
 *
 * Общее «пустой или скрыт» оставляло агента дорисовывать иконку на глаз — и с размерами из
 * головы. Скрытое Figma не рендерит ни в SVG, ни в PNG, но геометрия скрытого узла в снимке есть.
 */
export function hiddenHint(snapshot, id) {
  const node = snapshot?.nodes?.[id];
  if (!node) return undefined;
  let hidden = null;
  for (let current = node; current; current = snapshot.nodes[current.parent]) {
    if (current.visible === false) {
      hidden = current;
      break;
    }
  }
  const size = node.box ? `${round(node.box.w)}x${round(node.box.h)}` : null;
  if (hidden) {
    const who = hidden === node ? 'Узел скрыт в макете' : `Скрыт предок ${hidden.id} «${hidden.name ?? ''}»`;
    return `${who}: Figma скрытое не рендерит. Размеры${size ? ` (${size})` : ''}, обводку и заливку возьмите из figma_inspect с hidden: true — рисовать иконку на глаз не нужно.`;
  }
  const kids = node.children?.map((kid) => snapshot.nodes[kid]).filter(Boolean) || [];
  if (kids.length && kids.every((kid) => kid.visible === false)) {
    return `Все дети узла скрыты — рисовать нечего. Их геометрию и краску покажет figma_inspect с hidden: true${size ? `; размер узла ${size}` : ''}.`;
  }
  return undefined;
}

export async function exportSvg(refs, { client = getRestClient(), cacheDir = DIRS.figma, editor = null } = {}) {
  const runId = newRunId('figma-svg');
  const dir = await runDir(runId);
  const requests = { tier1: 0 };
  const state = {};
  const byHash = new Map();
  const files = [];
  const failed = [];
  const names = new Set();

  for (const group of groupRefs(refs)) {
    if (!group.nodeIds.length) throw new Error('Для svg нужны узлы: ссылка с node-id или запись ключ:id.');
    const { found, requests: spent } = await ensureNodes(group.fileKey, group.nodeIds, { client, cacheDir, editor });
    addRequests(requests, spent);

    const sources = {};
    await withChannels(
      { editor, client, state },
      async () => {
        const res = await editor.render(group.fileKey, group.nodeIds.map((id) => ({ id, format: 'svg' })));
        for (const id of group.nodeIds) sources[id] = res[id]?.svg ? { svg: res[id].svg } : { error: res[id]?.error };
      },
      async () => {
        const res = await client.images(group.fileKey, group.nodeIds, { format: 'svg' });
        requests.tier1 += 1;
        for (const id of group.nodeIds) {
          const url = res.images?.[id];
          sources[id] = url ? { svg: (await client.download(url)).toString('utf8') } : { error: res.err };
        }
      },
    );

    for (const id of group.nodeIds) {
      const ref = refOf(group.fileKey, id);
      if (!sources[id]?.svg) {
        const { snapshot } = found.get(id);
        failed.push(strip({ ref, error: sources[id]?.error || 'Figma не выгрузила SVG: узел пустой или скрыт.', hint: hiddenHint(snapshot, id) }));
        continue;
      }
      const { node } = found.get(id);
      const name = slug(node.name) || 'icon';
      const clean = normalizeSvg(sources[id].svg, { prefix: name });
      const hash = crypto.createHash('sha1').update(clean.svg).digest('hex');
      const known = byHash.get(hash);
      if (known) {
        known.refs.push(ref);
        continue;
      }
      const fileName = names.has(name) ? `${name}-${safeId(id)}` : name;
      names.add(fileName);
      const file = path.join(dir, `${fileName}.svg`);
      await fs.writeFile(file, clean.svg, 'utf8');
      const entry = strip({
        refs: [ref],
        name: node.name,
        size: clean.width ? `${clean.width}x${clean.height}` : undefined,
        monochrome: clean.monochrome,
        color: clean.color || undefined,
        colors: clean.monochrome ? undefined : clean.colors,
        file: artifactRef(file),
      });
      byHash.set(hash, entry);
      files.push(entry);
    }
  }
  const monochrome = files.filter((entry) => entry.monochrome).length;
  return strip({
    runId,
    files,
    failed,
    channel: state.channel,
    editorFallback: state.fallback,
    requests,
    /* Самое частое, что теряют после экспорта: currentColor без color на обёртке = чёрная иконка. */
    note: monochrome
      ? `${monochrome} иконок одноцветные и приходят с currentColor: у каждой задайте color на обёртке в CSS — значение в поле color записи. Без него иконка наследует цвет текста.`
      : undefined,
  });
}

/**
 * Видимое окно картинки при scaleMode CROP.
 *
 * imageTransform — это доли исходника, попавшие в рамку: [[ширина, 0, левый край], [0, высота,
 * верхний край]]. Поворот (ненулевые b и c) CSS-кадрированием не выражается — тогда null.
 */
export function cropWindow(transform, imageWidth, imageHeight) {
  if (!transform?.[0] || !transform?.[1]) return null;
  const [[a, b, tx], [c, d, ty]] = transform;
  if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) return null;
  const left = Math.max(0, Math.round(tx * imageWidth));
  const top = Math.max(0, Math.round(ty * imageHeight));
  const width = Math.min(imageWidth - left, Math.round(a * imageWidth));
  const height = Math.min(imageHeight - top, Math.round(d * imageHeight));
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

/**
 * Кадрирование с imageTransform.
 *
 * В редакторе этот режим зовётся CROP, а в форме REST — STRETCH, и отличить его от настоящего
 * растяжения можно только по наличию матрицы. Прогон на «Земском докторе» это и показал: сердце
 * пришло как STRETCH и без этой проверки резалось по центру, а не как в макете.
 */
export const isCropped = (paint) => paint.scaleMode === 'CROP' || (paint.scaleMode === 'STRETCH' && Boolean(paint.transform));

export async function cropImageFill(input, box, paint, scale) {
  const { width: iw, height: ih } = await sharp(input).metadata();
  const w = Math.max(1, Math.round(box.w * scale));
  const h = Math.max(1, Math.round(box.h * scale));
  let pipeline = sharp(input);
  if (isCropped(paint)) {
    const window = cropWindow(paint.transform, iw, ih);
    pipeline = window ? pipeline.extract(window).resize(w, h, { fit: 'fill' }) : pipeline.resize(w, h, { fit: 'cover' });
  } else if (paint.scaleMode === 'FIT') {
    pipeline = pipeline.resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  } else if (paint.scaleMode === 'STRETCH') {
    pipeline = pipeline.resize(w, h, { fit: 'fill' });
  } else if (paint.scaleMode !== 'TILE') {
    pipeline = pipeline.resize(w, h, { fit: 'cover' });
  }
  return pipeline.webp({ quality: 90 }).toBuffer();
}

export async function exportImages(refs, { client = getRestClient(), cacheDir = DIRS.figma, editor = null, scales = [1, 2] } = {}) {
  const runId = newRunId('figma-images');
  const dir = await runDir(runId);
  const requests = { tier1: 0, tier2: 0 };
  const state = {};
  const images = [];
  const failed = [];
  const withoutImages = [];
  const byHash = new Map();

  for (const group of groupRefs(refs)) {
    if (!group.nodeIds.length) throw new Error('Для image нужны узлы: ссылка с node-id или запись ключ:id.');
    const { found, requests: spent } = await ensureNodes(group.fileKey, group.nodeIds, { client, cacheDir, editor });
    addRequests(requests, spent);

    const targets = [];
    for (const id of group.nodeIds) {
      const { snapshot } = found.get(id);
      const before = targets.length;
      walk(snapshot, id, (node) => {
        if (node.visible === false) return false;
        for (const paint of node.fills || []) if (paint.kind === 'image' && node.box) targets.push({ node, paint });
        return true;
      });
      if (targets.length === before) withoutImages.push(refOf(group.fileKey, id));
    }
    if (!targets.length) continue;

    const original = (ref) => path.join(cacheDir, group.fileKey, 'images', ref);
    const needed = [];
    for (const ref of new Set(targets.map((target) => target.paint.ref))) {
      if (!(await exists(original(ref)))) needed.push(ref);
    }
    const errors = {};
    if (needed.length) {
      await withChannels(
        { editor, client, state },
        async () => {
          const res = await editor.images(group.fileKey, needed);
          for (const ref of needed) {
            if (res[ref]?.base64) await writeFile(original(ref), Buffer.from(res[ref].base64, 'base64'));
            else errors[ref] = res[ref]?.error;
          }
        },
        async () => {
          const fills = await client.imageFills(group.fileKey);
          requests.tier2 += 1;
          const urls = fills.meta?.images ?? fills.images ?? {};
          for (const ref of needed) {
            if (urls[ref]) {
              delete errors[ref];
              await writeFile(original(ref), await client.download(urls[ref]));
            } else {
              errors[ref] = 'Figma не отдала файл заливки.';
            }
          }
        },
      );
    }

    for (const { node, paint } of targets) {
      const ref = refOf(group.fileKey, node.id);
      if (!(await exists(original(paint.ref)))) {
        failed.push({ ref, error: `Нет файла заливки ${paint.ref}: ${errors[paint.ref] || 'не выгрузился'}` });
        continue;
      }
      const source = await sharp(original(paint.ref)).metadata();
      for (const s of scales) {
        const buffer = await cropImageFill(original(paint.ref), node.box, paint, s);
        const hash = crypto.createHash('sha1').update(buffer).digest('hex');
        const known = byHash.get(hash);
        if (known) {
          if (!known.refs.includes(ref)) known.refs.push(ref);
          continue;
        }
        const file = path.join(dir, `${slug(node.name) || 'image'}-${safeId(node.id)}@${s}x.webp`);
        await fs.writeFile(file, buffer);
        const meta = await sharp(buffer).metadata();
        let note;
        if (isCropped(paint) && !cropWindow(paint.transform, source.width, source.height)) {
          note = 'Кадрирование с поворотом не выражается без трансформации: отдано заполнение по cover.';
        } else if (paint.scaleMode === 'TILE') {
          note = 'Плитка: отдан исходник, повтор задаётся в CSS.';
        }
        const entry = strip({
          refs: [ref],
          name: node.name,
          scaleMode: paint.scaleMode,
          scale: s,
          size: `${meta.width}x${meta.height}`,
          source: `${source.width}x${source.height}`,
          bytes: buffer.length,
          note,
          file: artifactRef(file),
        });
        byHash.set(hash, entry);
        images.push(entry);
      }
    }
  }
  return strip({ runId, images, failed, withoutImages, channel: state.channel, editorFallback: state.fallback, requests });
}
