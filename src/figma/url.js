/**
 * Ссылки на Figma → ключ файла и id узла.
 *
 * Человек вставляет в задачу то, что скопировал из браузера: design, file, proto, ссылку на ветку,
 * с node-id через дефис и с мусором вроде &t=… . REST и Plugin API ждут другого — ключ файла и
 * id через двоеточие. Ошибка здесь дорогая: неверный ключ стоит запроса из минутного лимита и
 * возвращается как 404, по которому не понять, что сломалась именно ссылка.
 */

const KINDS = ['design', 'file', 'proto', 'board', 'slides', 'deck'];

/** 1033:12944, I1062:14566;1062:14546 — последнее id вложенного узла инстанса. */
const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;

export function normalizeNodeId(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  /* В ссылках двоеточие заменено дефисом, а точка с запятой инстанса экранирована. Дефиса в
     самих id не бывает, поэтому замена обратима без оговорок. */
  const value = decodeURIComponent(String(raw)).trim().replace(/-/g, ':');
  if (!NODE_ID.test(value)) {
    throw new Error(`Не похоже на id узла Figma: «${raw}». Ожидается вид 1033:12944 или 1033-12944.`);
  }
  return value;
}

/**
 * Разбор одной ссылки.
 *
 * Помимо ссылок принимается короткая запись «ключ:id» — её возвращают сами инструменты, и
 * агенту удобнее передать её дальше, чем собирать URL обратно.
 */
export function parseFigmaRef(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Пустая ссылка на Figma.');

  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Не разобрать ссылку: «${value}».`);
    }
    if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
      throw new Error(`Это не ссылка на Figma: ${url.hostname}.`);
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.findIndex((part) => KINDS.includes(part));
    if (at === -1 || !parts[at + 1]) {
      throw new Error('В ссылке не найден ключ файла: ожидается figma.com/design/<ключ>/… .');
    }
    /* У ветки свой ключ, и данные ветки отдаются только по нему: ключ основного файла вернёт
       основной файл, а не то, что открыто у человека. */
    const mainKey = parts[at + 1];
    const branch = parts.indexOf('branch', at + 2);
    const fileKey = branch !== -1 && parts[branch + 1] ? parts[branch + 1] : mainKey;
    const node = url.searchParams.get('node-id') ?? url.searchParams.get('starting-point-node-id');
    return {
      fileKey,
      nodeId: normalizeNodeId(node),
      ...(fileKey !== mainKey ? { mainFileKey: mainKey } : {}),
    };
  }

  const short = /^([A-Za-z0-9]{10,64})(?:[:/\s]+(.+))?$/.exec(value);
  if (!short) {
    throw new Error(`Не разобрать «${value}»: нужна ссылка figma.com или запись ключ:id узла.`);
  }
  return { fileKey: short[1], nodeId: normalizeNodeId(short[2]) };
}

/**
 * Несколько ссылок → по одному заданию на файл.
 *
 * Группировка и есть экономия: все узлы одного файла уходят одним запросом /nodes, а не по
 * запросу на ссылку. Ссылка без node-id означает файл целиком.
 */
export function groupRefs(inputs) {
  const byFile = new Map();
  for (const input of [].concat(inputs ?? [])) {
    const ref = parseFigmaRef(input);
    const entry = byFile.get(ref.fileKey) ?? { fileKey: ref.fileKey, nodeIds: [], wholeFile: false };
    if (ref.nodeId) {
      if (!entry.nodeIds.includes(ref.nodeId)) entry.nodeIds.push(ref.nodeId);
    } else {
      entry.wholeFile = true;
    }
    byFile.set(ref.fileKey, entry);
  }
  return [...byFile.values()];
}

/** Обратная сторона: короткая запись для ответов инструментов. */
export const refOf = (fileKey, nodeId) => (nodeId ? `${fileKey}:${nodeId}` : fileKey);
