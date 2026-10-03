/**
 * Правки протокольного слоя поверх McpServer.
 *
 * Обе делаются здесь, а не в файлах инструментов, потому что обе про то, что происходит до и
 * после обработчика: McpServer сам разбирает аргументы по zod-схеме и сам собирает список
 * инструментов, а вмешаться нужно с обеих сторон.
 *
 * Приём законный: Protocol.setRequestHandler — обычная запись в Map, и повторная установка
 * переопределяет прежний обработчик. Прежний мы забираем себе и вызываем сами, а не
 * переписываем разбор запросов заново.
 *
 * Здесь же стоит журнал использования (src/usage/): он должен видеть каждый вызов, ресурс и
 * начало сессии, а проходят они все только через эти обработчики.
 */
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getProfile, saveEphemeralProfile } from './browser/profiles.js';
import { usageLog, usageLogged, sessionFields } from './usage/log.js';

/**
 * Строка журнала на каждый вызов: имя, длительность, куча до и после.
 *
 * Стенд падал по нехватке памяти, и в журнале контейнера не было ни одного следа того, какой
 * вызов её съел, — только трасса V8. Значения аргументов не пишутся: там бывают доступы и
 * заголовки. Включён по умолчанию в HTTP-режиме стенда (index.js), LT_CALL_LOG=0 выключает,
 * LT_CALL_LOG=1 включает и в stdio.
 */
const callLogOn = () => process.env.LT_CALL_LOG === '1';
const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1048576);

export async function logged(request, call, write = (line) => process.stderr.write(line), on = callLogOn()) {
  if (!on) return call();
  const name = request?.params?.name ?? '?';
  const keys = Object.keys(request?.params?.arguments ?? {}).join(',');
  const started = Date.now();
  const before = heapMb();
  write(`[call] ${name}(${keys}) начат, куча ${before} МБ\n`);
  let outcome = 'ok';
  try {
    const result = await call();
    if (result?.isError) outcome = 'ошибка';
    return result;
  } catch (err) {
    outcome = `отказ: ${String(err?.message ?? err).slice(0, 120)}`;
    throw err;
  } finally {
    write(`[call] ${name} ${outcome}, ${Date.now() - started} мс, куча ${before} → ${heapMb()} МБ\n`);
  }
}

/**
 * Инструменты, у которых полный набор условий просмотра сменился на короткий.
 * Всё, что уехало из их схемы, перечислено ниже.
 */
const DEMOTED = new Set(['audit', 'web_vitals', 'seo_page', 'page_save', 'storybook_audit']);

const MOVED = new Set([
  'forcedColors',
  'reducedMotion',
  'rtl',
  'zoom',
  'textZoom',
  'pseudoLoc',
  'deviceScaleFactor',
  'locale',
  'timezoneId',
  'freezeTime',
  'throttle',
  'auth',
  'extraHTTPHeaders',
  'hostMap',
  'storageState',
  'serviceWorkers',
]);

/**
 * Совместимость со старыми вызовами.
 *
 * Проблема не в том, что вызов перестанет работать, а в том, КАК он перестанет. Zod по
 * умолчанию отбрасывает неизвестные ключи молча, поэтому audit({url, auth: "user:pass"})
 * после переезда условий вернул бы отчёт про 401 и ни слова о том, что пароль выброшен.
 * Такую ошибку ищут полдня.
 *
 * Поэтому старые ключи не игнорируются: они складываются в одноразовый профиль, вызов
 * продолжает работать как раньше, а в ответ дописывается, что именно переехало и куда.
 * Жёсткий отказ — дело следующей мажорной версии, когда о переезде уже будет известно.
 */
async function foldLegacyConditions(request, extra, next) {
  const name = request?.params?.name;
  const args = request?.params?.arguments;
  if (!DEMOTED.has(name) || !args || typeof args !== 'object') return next(request, extra);

  const moved = {};
  const kept = {};
  for (const [key, value] of Object.entries(args)) {
    if (MOVED.has(key) && value !== undefined && value !== null) moved[key] = value;
    else kept[key] = value;
  }
  if (!Object.keys(moved).length) return next(request, extra);

  /* Если профиль уже назван, старые ключи ложатся поверх него: явное сильнее сохранённого. */
  const base = kept.profile ? getProfile(kept.profile) || {} : {};
  const profile = saveEphemeralProfile({ ...base, ...moved });
  const patched = {
    ...request,
    params: { ...request.params, arguments: { ...kept, profile } },
  };

  const result = await next(patched, extra);
  return appendNote(
    result,
    `Условия просмотра ${Object.keys(moved).join(', ')} больше не объявлены у ${name}: они ` +
      'задаются в browser_open и закрепляются профилем через browser_profile. Этот вызов ' +
      'выполнен как прежде, но в следующей мажорной версии такие параметры станут ошибкой.',
  );
}

/** Старые ключи в вызове — для журнала использования: так видно, что агенты ещё ходят по-старому. */
function legacyKeysOf(request) {
  const args = request?.params?.arguments;
  if (!DEMOTED.has(request?.params?.name) || !args || typeof args !== 'object') return [];
  return Object.keys(args).filter((key) => MOVED.has(key) && args[key] !== undefined && args[key] !== null);
}

function appendNote(result, note) {
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: [...result.content, { type: 'text', text: note }] };
}

/**
 * Чистка схем в списке инструментов.
 *
 * $schema — постоянная строка в пятьдесят символов, одинаковая у всех инструментов и не
 * несущая модели ничего: сорок с лишним копий одного и того же URL. Пустые properties и
 * required у инструментов без аргументов — тоже шум.
 *
 * additionalProperties: false при этом остаётся намеренно. Он весит меньше и работает на нас:
 * это он говорит модели, что придумывать параметры нельзя.
 */
/**
 * Что инструмент делает со стендом.
 *
 * Клиент по этим подсказкам решает, спрашивать ли подтверждение. Без них он не отличает
 * «посмотреть, какие правила применились» от «удалить прогоны», и либо переспрашивает на
 * каждый вызов, либо не переспрашивает никогда.
 *
 * Таблица держится здесь, а не рассыпана по тринадцати файлам регистраций, ровно затем, чтобы
 * её можно было прочитать целиком: разделение на читающее и меняющее — свойство набора
 * инструментов, а не отдельного инструмента.
 *
 * Читающими считаются те, что ничего не пишут и не меняют состояние. Инструменты, которые
 * складывают артефакты, — screenshot, audit, matrix_run, visual_guide, page_save — сюда
 * намеренно не попали: файл на диске это тоже след, и обещать обратное неверно.
 */
const READ_ONLY = [
  'layout_audit',
  'computed_styles',
  'matched_rules',
  'element_layers',
  'page_snapshot',
  'page_logs',
  'a11y_axe',
  'a11y_pa11y',
  'web_vitals',
  'validate_html',
  'lint_css',
  'seo_page',
  'seo_report',
  'site_files',
  'crawl_pages',
  'crawl_query',
  'artifacts_list',
  'read_artifact',
  'read_project_file',
  'stand_info',
  'browser_sessions',
  'visual_baselines',
  /* figma_inspect может докачать недостающий узел в кэш снимков — это кэш, как у браузера, а не
     след для человека. figma_sync и figma_export сюда не входят: первый затем и зовут, чтобы
     записать снимок, второй кладёт файлы в артефакты. */
  'figma_status',
  'figma_inspect',
  'figma_structure',
  'figma_components',
  'figma_tokens',
  'figma_breakpoints',
  'figma_comments',
  'figma_history',
  'figma_behavior',
];

/** Удаляют то, что не восстановить: прогоны с диска, живую сессию вместе с её контекстом. */
const DESTRUCTIVE = ['artifacts_clean', 'browser_close'];

const ANNOTATIONS = new Map([
  ...READ_ONLY.map((name) => [name, { readOnlyHint: true }]),
  ...DESTRUCTIVE.map((name) => [name, { destructiveHint: true, idempotentHint: false }]),
]);

function slimSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const { $schema, ...rest } = schema;
  if (rest.properties && Object.keys(rest.properties).length === 0) {
    delete rest.properties;
    delete rest.required;
  }
  return rest;
}

/**
 * toolset и standVersion нужны только журналу использования: под каким набором открыта сессия и
 * на какой версии стенда она шла. log подменяется в тестах.
 */
export function installProtocolPatches(mcp, { toolset = null, standVersion = null, log = usageLog } = {}) {
  const server = mcp?.server;
  const handlers = server?._requestHandlers;
  if (!handlers) return { patched: false };

  const ctx = { toolset, standVersion, client: () => server.getClientVersion?.() ?? null };

  const originalList = handlers.get('tools/list');
  const originalCall = handlers.get('tools/call');

  if (originalList) {
    /*
     * Список считается один раз на процесс. McpServer сворачивает zod в JSON Schema на каждый
     * запрос tools/list, а под HTTP-транспортом сервер создаётся на каждого клиента — сорок
     * с лишним конвертаций повторялись при каждом переподключении агента.
     */
    let cached = null;
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      if (!cached) {
        const result = await originalList(request, extra);
        cached = {
          ...result,
          tools: (result.tools || []).map((tool) => {
            const hints = ANNOTATIONS.get(tool.name);
            return {
              ...tool,
              inputSchema: slimSchema(tool.inputSchema),
              ...(hints ? { annotations: { ...tool.annotations, ...hints } } : {}),
            };
          }),
        };
      }
      return cached;
    });
  }

  if (originalCall) {
    server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      usageLogged(ctx, request, extra, () => logged(request, () => foldLegacyConditions(request, extra, originalCall)), {
        log,
        legacyKeys: legacyKeysOf(request),
      }),
    );
  }

  installUsageHooks(server, handlers, ctx, log);

  return { patched: Boolean(originalList && originalCall) };
}

/**
 * Остальные события журнала использования: начало сессии, чтение ресурсов и промптов.
 *
 * Ресурсы и промпты — это регламент и справка. Когда агент уходит их читать посреди работы,
 * значит, описаний инструментов ему не хватило, и в сводке это место должно быть видно.
 */
function installUsageHooks(server, handlers, ctx, log) {
  const originalInit = handlers.get('initialize');
  if (originalInit) {
    server.setRequestHandler(InitializeRequestSchema, async (request, extra) => {
      const result = await originalInit(request, extra);
      log.record({
        event: 'session_open',
        ...sessionFields(ctx, extra),
        client: request?.params?.clientInfo
          ? { name: request.params.clientInfo.name ?? null, version: request.params.clientInfo.version ?? null }
          : null,
        protocolVersion: request?.params?.protocolVersion ?? null,
      });
      return result;
    });
  }

  const watch = (method, schema, event, target) => {
    const original = handlers.get(method);
    if (!original) return;
    server.setRequestHandler(schema, async (request, extra) => {
      const started = Date.now();
      let outcome = 'ok';
      try {
        return await original(request, extra);
      } catch (err) {
        outcome = 'throw';
        throw err;
      } finally {
        log.record({ event, ...sessionFields(ctx, extra), target: target(request), durationMs: Date.now() - started, outcome });
      }
    });
  };
  watch('resources/read', ReadResourceRequestSchema, 'resource', (request) => request?.params?.uri ?? null);
  watch('prompts/get', GetPromptRequestSchema, 'prompt', (request) => request?.params?.name ?? null);
}
