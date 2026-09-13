/**
 * Инвентарь ассетов кадра: что скачивать, чем и сколько раз.
 *
 * Раньше этот список собирался вручную, обходом figma_structure и figma_inspect, и половина
 * ошибок вёрстки начиналась именно здесь. Иконка не экспортировалась — её дорисовывали руками
 * и промахивались мимо размера и толщины. Фигура с картинкой-заливкой приезжала то плоским
 * прямоугольником (kind: image), то пустым вектором (kind: svg), и понять, что нужен render,
 * можно было только перепробовав всё. Одна и та же картинка скачивалась под четырьмя именами.
 *
 * Разбор идёт по снятому снимку и ни одного запроса в Figma не стоит: тип узла, маска, обрезка
 * и растровая заливка в снимке уже есть. Поэтому инвентарь и живёт рядом со спецификацией
 * блока, а не внутри figma_export: экспорт — это трата лимита, а решать, что тратить, надо
 * до неё, а не после.
 *
 * Главная оговорка, которую ответ обязан нести вслух: kind: render — это догадка. Figma не
 * сообщает «этот узел не выражается в SVG»; признаки выведены из полей снимка и будут ошибаться
 * в обе стороны. Поэтому у каждой такой записи стоит why — чтобы с ней можно было не согласиться.
 */
import { childNodes } from './snapshot.js';
import { isIconLike } from './analyze/structure.js';
import { isVisible, visibleNodes } from './analyze/common.js';
import { isCropped } from './export.js';
import { round } from './css.js';

const VECTORS = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'REGULAR_POLYGON']);

/**
 * Есть ли в матрице кадрирования поворот.
 *
 * Условие то же, по которому cropWindow отказывается считать окно (export.js), — но вызывать
 * её здесь нельзя: она принимает размеры картинки, которых у снимка нет, а на единичных
 * размерах округление даёт ложный отказ. Поэтому проверяем ровно поворот и ничего больше.
 */
const rotatedCrop = (transform) => {
  if (!transform?.[0] || !transform?.[1]) return false;
  const [[, b], [c]] = transform;
  return Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6;
};

const imageFill = (node) => (node.fills || []).find((paint) => paint.kind === 'image') || null;
const hasGradient = (node) => (node.fills || []).some((paint) => paint.kind !== 'solid' && paint.kind !== 'image');
const hasBlur = (node) => (node.effects || []).some((effect) => effect.type === 'blur' || effect.type === 'backdrop');

/** Есть ли растровая заливка где-нибудь внутри — включая сам узел. */
function imageInside(snapshot, node) {
  if (imageFill(node)) return true;
  for (const kid of childNodes(snapshot, node)) {
    if (!isVisible(kid)) continue;
    if (imageInside(snapshot, kid)) return true;
  }
  return false;
}

/**
 * Почему этот узел не возьмёшь ни svg, ни image.
 *
 * Возвращает строку-причину или null. Строка, а не флаг: агент читает её и решает сам, а
 * заодно видит, на чём стенд основывался, когда ошибся.
 */
function renderReason(snapshot, node, vectorish) {
  const fill = imageFill(node);

  if (vectorish && imageInside(snapshot, node)) {
    return 'вектор с картинкой внутри: svg приедет без картинки, image — без фигурного края';
  }
  if (fill && node.isMask) return 'узел-маска с растровой заливкой: обрезку файл не унесёт';
  if (fill && node.rotation) return 'повёрнутая растровая заливка: поворот в CSS-кадрировании не выражается';
  if (fill && isCropped(fill) && rotatedCrop(fill.transform)) {
    return 'кадрирование с поворотом: exportImages отдаст заполнение по cover, а не то, что в макете';
  }
  if (vectorish && hasGradient(node)) return 'градиент в иконке: normalizeSvg его потеряет';
  if (vectorish && hasBlur(node)) return 'размытие в иконке: в svg его нет';
  return null;
}

/**
 * Классификация одного узла.
 *
 * css означает «файла не нужно»: прямоугольник, полоса, круг, градиент — всё это дешевле и
 * точнее воспроизводится стилями, и скачивать их в макете незачем.
 */
function classify(snapshot, node) {
  if (node.type === 'TEXT') return null;
  const vectorish = VECTORS.has(node.type) || isIconLike(snapshot, node);
  const fill = imageFill(node);

  const why = renderReason(snapshot, node, vectorish);
  if (why) return { kind: 'render', why };
  if (fill) return { kind: 'image', fill };
  if (vectorish) return { kind: 'svg' };
  return { kind: 'css' };
}

/**
 * Ключ дедупликации — по источнику, а не по выданным байтам.
 *
 * figma_export сводит одинаковое по хэшу готового файла и перечисляет находки в refs; здесь
 * сведение идёт раньше экспорта, по тому, что видно в макете. Два способа могут разойтись, и
 * авторитет после выгрузки — у refs. Здесь же важно другое: не заказать одно и то же четырежды.
 */
function dedupKey(node, entry) {
  if (entry.kind === 'image') return { key: entry.fill.ref ? `img:${entry.fill.ref}` : null, by: 'imageRef' };
  if (entry.kind === 'svg') {
    if (node.vectorHash) return { key: `vec:${node.vectorHash}`, by: 'vectorHash' };
    /* Геометрии в снимке нет — например, узел пришёл из редактора без fillGeometry.
       Имя с размером хуже хэша и ошибается на одинаково названных иконках: говорим об этом. */
    const { w = 0, h = 0 } = node.box || {};
    return { key: `name:${node.name}|${round(w)}x${round(h)}`, by: 'byName' };
  }
  return { key: null, by: null };
}

/**
 * Скрытые узлы сюда не попадают намеренно: Figma не рендерит скрытое ни в PNG, ни в SVG, и
 * список «что скачать» с непригодным к скачиванию узлом — это не полнота, а ложный след.
 * Геометрию и краску такого узла отдаёт figma_inspect с hidden: true.
 */
export function assetInventory(snapshot, rootId, { limit = 60 } = {}) {
  const counts = { svg: 0, image: 0, render: 0, css: 0 };
  const groups = new Map();
  const items = [];

  for (const { node } of visibleNodes(snapshot, rootId)) {
    const entry = classify(snapshot, node);
    if (!entry) continue;
    counts[entry.kind] += 1;
    if (entry.kind === 'css') continue;

    const { w = 0, h = 0 } = node.box || {};
    const { key, by } = dedupKey(node, entry);
    const item = {
      id: node.id,
      name: node.name,
      kind: entry.kind,
      size: `${round(w)}x${round(h)}`,
      ...(entry.why ? { why: entry.why } : {}),
      ...(entry.fill?.ref ? { imageRef: entry.fill.ref } : {}),
      ...(entry.fill?.scaleMode ? { scaleMode: entry.fill.scaleMode } : {}),
      ...(by === 'byName' ? { dedup: 'byName' } : {}),
    };
    items.push(item);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.nodes.push(node.id);
    else groups.set(key, { key, kind: entry.kind, name: node.name, nodes: [node.id] });
  }

  const duplicates = [...groups.values()]
    .filter((group) => group.nodes.length > 1)
    .map((group) => ({ kind: group.kind, name: group.name, uses: group.nodes.length, nodes: group.nodes.slice(0, 5) }))
    .sort((a, b) => b.uses - a.uses);

  /*
   * plan — то, ради чего инвентарь и собирается: готовые списки id для figma_export, где дубли
   * уже сведены к одному представителю. Без него агент переносит идентификаторы руками и
   * заказывает одну и ту же картинку столько раз, сколько она встретилась.
   *
   * У render ключа дедупликации нет по существу — рендерится узел целиком, со своим окружением,
   * и два похожих узла одинаковыми файлами не будут. Поэтому там идут все.
   */
  const plan = {};
  const representatives = new Set([...groups.values()].map((group) => group.nodes[0]));
  for (const kind of ['svg', 'image', 'render']) {
    const ids = items
      .filter((item) => item.kind === kind && (kind === 'render' || representatives.has(item.id)))
      .map((item) => item.id);
    if (ids.length) plan[kind] = ids;
  }

  const note = [
    'kind: render — догадка, а не факт: Figma не сообщает, что узел не выражается в svg. У каждой такой записи стоит why — проверьте её, прежде чем тратить запрос.',
    duplicates.length ? 'Дубли сведены по источнику (imageRef, геометрия вектора). После выгрузки авторитет — refs у figma_export: он сводит по содержимому готового файла и может разойтись с этим списком.' : null,
    items.some((item) => item.dedup === 'byName') ? 'У части векторов в снимке нет геометрии, и они сведены по имени с размером: одинаково названные разные иконки такой ключ спутает.' : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    counts,
    ...(duplicates.length ? { duplicates } : {}),
    items: items.slice(0, limit),
    ...(items.length > limit ? { itemsTruncated: `Показано ${limit} из ${items.length}` } : {}),
    ...(Object.keys(plan).length ? { plan } : {}),
    note,
  };
}
