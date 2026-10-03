/**
 * Журнал использования: что агенты делают со стендом.
 *
 * Не путать с журналом вызовов в stderr (logged в protocol.js). Тот — диагностика падений:
 * имя, длительность, куча, без значений. Этот — материал для улучшения инструментов: аргументы
 * целиком (после маскировки, см. redact.js), текст ошибки, выжимка ответа, клиент и сессия.
 * Из него видно, где агент ошибается в параметрах, что повторяет после ошибки, чего не находит.
 *
 * Пишется только на диск стенда, в state/usage/: каталог — том, переживает обновление, закрыт
 * от инструментов и не раздаётся nginx. По сети не уходит ничего; журнал забирают руками и
 * сводят командой `lt usage`.
 *
 * Переменные читаются в момент записи, а не при импорте: index.js выставляет значение по
 * умолчанию для HTTP-режима уже после того, как модули загружены.
 *   LT_USAGE_LOG=1 — писать, 0 — нет. В HTTP-режиме по умолчанию 1, в stdio — 0.
 *   LT_USAGE_KEEP_DAYS — сколько суток хранить, по умолчанию 30.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DIRS } from '../constants.js';
import { redactArgs, scrubString, MAX_STRING } from './redact.js';

/** Версия формата записи. Поднимать при несовместимой смене полей: отчёт сводит журналы разных версий стенда. */
export const USAGE_FORMAT = 1;

export const USAGE_DIR = path.join(DIRS.state, 'usage');

const FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const usageEnabled = () => process.env.LT_USAGE_LOG === '1';
const keepDays = () => {
  const days = Number(process.env.LT_USAGE_KEEP_DAYS || 30);
  return Number.isFinite(days) && days > 0 ? days : 30;
};

/**
 * Писатель журнала в каталог.
 *
 * Запись синхронная, строкой за раз: строка в пару килобайт на вызов, который сам идёт секунды,
 * — цена незаметная, а порядок строк и целостность при падении процесса получаются бесплатно.
 * Отказ записи (нет места, нет прав) вызов не ломает: одно предупреждение в stderr, и журнал
 * молчит до перезапуска, чтобы не сыпать тем же сообщением на каждый вызов.
 */
export function createUsageLog({
  dir = USAGE_DIR,
  enabled = usageEnabled,
  keep = keepDays,
  now = () => new Date(),
  warn = (line) => process.stderr.write(line),
} = {}) {
  let broken = false;
  let day = null;
  let install = null;

  function installId() {
    if (install) return install;
    const file = path.join(dir, 'install.json');
    try {
      install = JSON.parse(fs.readFileSync(file, 'utf8')).id;
    } catch {
      /* Случайный идентификатор установки: различает пользователей при сведении журналов и
         не несёт ничего о машине и человеке. */
      install = randomUUID();
      fs.writeFileSync(file, `${JSON.stringify({ id: install, createdAt: now().toISOString() }, null, 2)}\n`);
    }
    return install;
  }

  function prune(today) {
    const edge = Date.parse(today) - keep() * DAY_MS;
    for (const name of fs.readdirSync(dir)) {
      const hit = FILE.exec(name);
      if (hit && Date.parse(hit[1]) < edge) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  function record(event) {
    if (broken || !enabled()) return false;
    try {
      const at = now();
      const today = at.toISOString().slice(0, 10);
      if (today !== day) {
        fs.mkdirSync(dir, { recursive: true });
        prune(today);
        day = today;
      }
      const line = {
        v: USAGE_FORMAT,
        ts: at.toISOString(),
        install: installId(),
        ...event,
      };
      fs.appendFileSync(path.join(dir, `usage-${today}.jsonl`), `${JSON.stringify(line)}\n`);
      return true;
    } catch (err) {
      broken = true;
      warn(`[usage] журнал использования отключён до перезапуска: ${err.message}\n`);
      return false;
    }
  }

  return { record, enabled: () => !broken && enabled() };
}

export const usageLog = createUsageLog();

const IMAGE_BYTES = (base64) => Math.floor((String(base64 ?? '').length * 3) / 4);

/** Короткая строка из ответа: подсказки и предупреждения пишутся, но не простынёй. */
const short = (value, limit = 500) => {
  const text = scrubString(String(value));
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/**
 * Выжимка JSON-ответа: форма, а не содержимое.
 *
 * Содержимое ответа — это чужая страница: тексты, адреса, куки из browser_storage. Для разбора
 * удобства хватает формы: какие поля пришли, сколько находок, обрезан ли список, что стенд
 * подсказал агенту. Скаляры верхнего уровня пишутся: там счётчики и статусы.
 */
function shapeOf(data) {
  if (Array.isArray(data)) return { array: data.length };
  if (!data || typeof data !== 'object') return { scalar: typeof data };

  const keys = Object.keys(data);
  const shape = { keys: keys.slice(0, 40) };
  const arrays = {};
  const scalars = {};
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) arrays[key] = value.length;
    else if (typeof value === 'number' || typeof value === 'boolean') scalars[key] = value;
    else if (typeof value === 'string' && value.length <= 200 && key !== 'value') scalars[key] = short(value, 200);
  }
  if (Object.keys(arrays).length) shape.arrays = arrays;
  if (Object.keys(scalars).length) shape.scalars = scalars;
  for (const key of ['hint', 'hints', 'note', 'warnings', 'warning']) {
    if (data[key] === undefined) continue;
    shape[key] = Array.isArray(data[key]) ? data[key].slice(0, 5).map((item) => short(typeof item === 'string' ? item : JSON.stringify(item))) : short(typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]));
  }
  return shape;
}

export function summarizeResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const summary = { blocks: {}, textBytes: 0 };
  const images = [];
  const notes = [];
  let first = null;

  for (const block of content) {
    summary.blocks[block?.type ?? '?'] = (summary.blocks[block?.type ?? '?'] ?? 0) + 1;
    if (block?.type === 'text') {
      summary.textBytes += Buffer.byteLength(String(block.text ?? ''));
      if (first === null) first = String(block.text ?? '');
      else if (notes.length < 3) notes.push(short(block.text));
    } else if (block?.type === 'image') {
      images.push({ mime: block.mimeType ?? null, bytes: IMAGE_BYTES(block.data) });
    }
  }
  if (images.length) summary.images = images;
  if (notes.length) summary.notes = notes;

  if (first && !result?.isError && /^[[{]/.test(first.trimStart())) {
    try {
      summary.shape = shapeOf(JSON.parse(first));
    } catch {
      /* Ответ обрезан потолком текста — формы нет, есть размер. */
      summary.shape = { unparsed: true };
    }
  }
  return summary;
}

function errorText(result) {
  const block = (result?.content ?? []).find((item) => item?.type === 'text');
  return block ? scrubString(String(block.text ?? '')).slice(0, MAX_STRING) : null;
}

const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1048576);

/**
 * Обёртка вызова инструмента.
 *
 * ctx живёт один на сервер MCP, а сервер под HTTP — один на сессию клиента, поэтому счётчик
 * seq в нём и есть порядковый номер вызова в сессии. Клиент читается в момент вызова: при
 * создании сервера initialize ещё не пришёл.
 */
export async function usageLogged(ctx, request, extra, call, { log = usageLog, legacyKeys = [] } = {}) {
  if (!log.enabled()) return call();
  const tool = request?.params?.name ?? '?';
  const seq = (ctx.seq = (ctx.seq ?? 0) + 1);
  const started = Date.now();
  let result;
  let thrown = null;
  try {
    result = await call();
    return result;
  } catch (err) {
    thrown = err;
    throw err;
  } finally {
    const event = {
      event: 'call',
      ...sessionFields(ctx, extra),
      tool,
      seq,
      requestId: extra?.requestId ?? null,
      args: redactArgs(tool, request?.params?.arguments),
      durationMs: Date.now() - started,
      heapMb: heapMb(),
      outcome: thrown ? 'throw' : result?.isError ? 'error' : 'ok',
    };
    if (legacyKeys.length) event.legacyKeys = legacyKeys;
    if (thrown) event.error = scrubString(String(thrown?.message ?? thrown)).slice(0, MAX_STRING);
    else if (result?.isError) event.error = errorText(result);
    if (result) event.result = summarizeResult(result);
    log.record(event);
  }
}

/**
 * Поля сессии, общие для всех событий одного подключения.
 *
 * Версия стенда приходит из ctx, а не берётся здесь из update.js: тот тянет config.js, а с ним
 * playwright, и тесты протокольного слоя перестали бы обходиться без браузерных зависимостей.
 */
export function sessionFields(ctx, extra) {
  const client = ctx.client?.() ?? null;
  return {
    mcpSession: extra?.sessionId ?? null,
    standVersion: ctx.standVersion ?? 'unknown',
    toolset: ctx.toolset ?? null,
    client: client ? { name: client.name ?? null, version: client.version ?? null } : null,
  };
}
