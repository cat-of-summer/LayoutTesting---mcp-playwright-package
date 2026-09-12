/**
 * Сборка MCP-сервера.
 *
 * Сами инструменты живут в tools/ по группам: сорок с лишним регистраций в одном файле
 * перестают читаться, а группы совпадают с тем, как их ищет человек — «что-то про снимки»,
 * «что-то про доступность». Здесь остаётся только порядок сборки.
 *
 * Порядок регистрации задаёт и порядок, в котором инструменты видит агент. Сначала то, с чего
 * начинают разбор, дальше — специализированное.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ensureDirs } from './artifacts.js';
import { loadProfiles } from './browser/profiles.js';
import { installProtocolPatches } from './protocol.js';
import { pkg } from './tools/shared.js';
import { buildInstructions } from './tools/instructions.js';
import { resolveSelection } from './tools/groups.js';
import { checkForUpdate, updateNotice } from './update.js';
import { checkFigmaApi, figmaApiNotice } from './figma/api-check.js';

import { register as registerSession } from './tools/session.js';
import { register as registerObserve } from './tools/observe.js';
import { register as registerLayout } from './tools/layout.js';
import { register as registerVisual } from './tools/visual.js';
import { register as registerFigma } from './tools/figma.js';
import { register as registerA11y } from './tools/a11y.js';
import { register as registerPerf } from './tools/perf.js';
import { register as registerSeo } from './tools/seo.js';
import { register as registerStatic } from './tools/static.js';
import { register as registerComposite } from './tools/composite.js';
import { register as registerCrawl } from './tools/crawl.js';
import { register as registerArtifacts } from './tools/artifacts.js';
import { register as registerHelp } from './tools/help.js';
import { register as registerResources } from './tools/resources.js';
import { register as registerPrompts } from './tools/prompts.js';
import { buildStandInfo } from './tools/artifacts.js';

/*
 * Проверка обновлений — один раз на процесс, а не на каждое подключение.
 *
 * createServer вызывается для каждого клиента HTTP-транспорта (см. index.js), и вместе с ним
 * повторялась проверка. Кэш на диске живёт шесть часов, но при пустом кэше и закрытом наружу
 * контуре каждый новый клиент платил четыре секунды таймаута прямо на подключении.
 */
let updatePromise = null;
let figmaApiPromise = null;

/**
 * Сборка сервера под одну выборку групп.
 *
 * Какую поверхность поднимать, решает не стенд, а тот, кто подключается: выборка приходит из
 * адреса подключения — /mcp отдаёт всё, /mcp/seo+crawl названное плюс то, без чего оно не
 * работает. Одна поднятая копия обслуживает всех, и смена набора не требует перезапуска.
 *
 * Отключение группами, а не по одному, — сознательно: инструменты внутри группы ссылаются друг
 * на друга в описаниях и в instructions, и выборочное отключение оставляло бы советы вида
 * «дальше crawl_query» при отсутствующем crawl_query.
 *
 * Что бы ни выбрали, stand_info и help остаются: первый объясняет агенту, какой набор активен и
 * как получить остальное, второй — то, что вынуто из описаний. Иначе модель, не нашедшая нужного
 * инструмента, заключит, что стенд сломан.
 */
export async function createServer({ selection = resolveSelection('all') } = {}) {
  await ensureDirs();
  /* Профили, сохранённые с persist: true, поднимаются из state/profiles.json — иначе имя,
     которым пользовались вчера, после перезапуска стенда переставало существовать. */
  await loadProfiles();

  const on = (group) => !selection.groups || selection.groups.has(group);

  /*
   * Проверка обновлений идёт до создания сервера, потому что её результат дописывается в
   * instructions: иначе агент узнает о новой версии, только если сам спросит, а спрашивать ему
   * незачем. Упасть она не может — внутри таймаут и перехват любых отказов, — но и задержать
   * запуск надолго тоже: секунды ожидания недоступного GitHub стоят дешевле, чем стенд,
   * который не поднялся из-за проверки версии.
   *
   * Версия Figma API проверяется так же и по той же причине: отставание должно быть видно
   * агенту сразу, а не после отказа Figma. Обе проверки идут параллельно — ни одна не ждёт другую.
   */
  updatePromise ??= checkForUpdate(pkg.version).catch(() => null);
  if (on('figma')) figmaApiPromise ??= checkFigmaApi().catch(() => null);
  const [update, figmaApi] = await Promise.all([updatePromise, on('figma') ? figmaApiPromise : null]);
  const notices = [updateNotice(update), figmaApiNotice(figmaApi)].filter(Boolean);

  /* instructions клиент показывает модели при подключении. Без них агент видит четыре десятка
     описаний без всякой рамки и не понимает, для каких задач сюда идти. Собираются по активным
     группам: на /mcp/seo совет «поехала вёрстка — layout_audit» указывал бы в пустоту.

     Имя сервера различает подключения к одному стенду в панели клиента: layout-testing/seo+crawl
     рядом с layout-testing/figma видно, а два одинаковых «layout-testing» — нет. Префикс
     инструментов от него не зависит: его клиент берёт из имени сервера в своём конфиге. */
  const server = new McpServer(
    {
      name: selection.groups ? `layout-testing/${selection.key}` : 'layout-testing',
      version: pkg.version,
    },
    { instructions: [buildInstructions(selection.groups), ...notices].join('\n\n') },
  );

  if (on('session')) registerSession(server);
  if (on('observe')) registerObserve(server);
  if (on('layout')) registerLayout(server);
  if (on('visual')) registerVisual(server);
  if (on('figma')) registerFigma(server);
  if (on('a11y')) registerA11y(server);
  if (on('perf')) registerPerf(server);
  if (on('seo')) registerSeo(server);
  if (on('static')) registerStatic(server);
  if (on('composite')) registerComposite(server);
  if (on('crawl')) registerCrawl(server);
  // Состояние стенда знает про обновление — оно посчитано выше и передаётся сюда, а не
  // перезапрашивается на каждый вызов stand_info. Группа не отключается никогда: без
  // stand_info агенту нечем выяснить, почему остального нет.
  registerArtifacts(server, { update, selection });
  /* help не отключается по той же причине, что и stand_info: он объясняет то, что вынуто из
     описаний, и без него сокращённые описания превратились бы просто в неполные. Состав
     поднятого он спрашивает лениво, в момент вызова, когда регистрация уже закончена. */
  registerHelp(server, { activeTools: () => activeToolNames(server) });
  /* Ресурсы — второй путь к тому же: инструмент возвращает ссылку, клиент решает, когда её
     раскрыть. Сводку о стенде обе двери берут из одной функции, иначе они разъедутся. */
  /* Промпты не занимают места в манифесте: клиент перечисляет их отдельно и подтягивает тело
     только по выбору человека. Поэтому здесь лежит порядок шагов целиком — то, чему в
     описаниях инструментов места нет. */
  registerPrompts(server, { selection });
  registerResources(server, {
    standInfo: () => buildStandInfo({ update, selection }),
  });

  /* Ставится последним: обработчики tools/list и tools/call к этому моменту уже на месте,
     а патч забирает прежние себе и вызывает их сам. */
  installProtocolPatches(server);

  return server;
}

/**
 * Имена поднятых инструментов.
 *
 * Читается приватное поле SDK — тот же приём и по той же причине, что в protocol.js: спросить
 * сервер о собственном составе изнутри процесса больше негде, а карта регистраций — обычная
 * запись в Map. Поле может исчезнуть в мажорной версии SDK, поэтому его отсутствие не считается
 * ошибкой: help тогда просто перестанет фильтровать список и будет перечислять всё.
 */
function activeToolNames(server) {
  const registered = server?._registeredTools;
  return registered ? new Set(Object.keys(registered)) : null;
}
