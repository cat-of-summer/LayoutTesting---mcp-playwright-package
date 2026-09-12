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
 */
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getProfile, saveEphemeralProfile } from './browser/profiles.js';

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

export function installProtocolPatches(mcp) {
  const server = mcp?.server;
  const handlers = server?._requestHandlers;
  if (!handlers) return { patched: false };

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
      foldLegacyConditions(request, extra, originalCall),
    );
  }

  return { patched: Boolean(originalList && originalCall) };
}
