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
import { INSTRUCTIONS } from './tools/instructions.js';
import { checkForUpdate, updateNotice } from './update.js';

import { register as registerSession } from './tools/session.js';
import { register as registerObserve } from './tools/observe.js';
import { register as registerLayout } from './tools/layout.js';
import { register as registerVisual } from './tools/visual.js';
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

/**
 * Какие группы инструментов поднимать.
 *
 * Полный набор — сорок с лишним инструментов, и это около 45 000 символов манифеста, которые
 * агент вычитывает при каждом подключении. Стенду, который держат ради вёрстки, обход сайта и
 * SEO-отчёты в этот счёт попадают зря.
 *
 * Отключение группами, а не по одному, — сознательно: инструменты внутри группы ссылаются друг
 * на друга в описаниях и в instructions, и выборочное отключение оставляло бы советы вида
 * «дальше crawl_query» при отсутствующем crawl_query.
 *
 * Что бы ни отключили, stand_info остаётся: именно он объясняет агенту, какой набор активен и
 * как его расширить. Иначе модель, не нашедшая нужного инструмента, заключит, что стенд сломан.
 */
const TOOL_SETS = {
  all: null,
  core: ['session', 'observe', 'layout', 'visual', 'a11y', 'static', 'composite', 'artifacts'],
  minimal: ['session', 'observe', 'layout', 'composite', 'artifacts'],
};

function selectedGroups() {
  const wanted = String(process.env.LT_TOOLS || 'all').trim().toLowerCase();
  if (wanted === 'all') return { name: 'all', groups: null };
  if (TOOL_SETS[wanted]) return { name: wanted, groups: new Set(TOOL_SETS[wanted]) };
  /* Непонятное значение — не повод молча поднять всё: тогда о опечатке узнают по счёту за
     контекст. Но и падать нельзя: стенд без инструментов бесполезнее стенда с лишними. */
  process.stderr.write(
    `[mcp] LT_TOOLS=${wanted} не распознан, поднимаю всё. Ожидается: ${Object.keys(TOOL_SETS).join(', ')}\n`,
  );
  return { name: 'all', groups: null };
}

let updatePromise = null;

export async function createServer() {
  await ensureDirs();
  /* Профили, сохранённые с persist: true, поднимаются из state/profiles.json — иначе имя,
     которым пользовались вчера, после перезапуска стенда переставало существовать. */
  await loadProfiles();

  /*
   * Проверка обновлений идёт до создания сервера, потому что её результат дописывается в
   * instructions: иначе агент узнает о новой версии, только если сам спросит, а спрашивать ему
   * незачем. Упасть она не может — внутри таймаут и перехват любых отказов, — но и задержать
   * запуск надолго тоже: секунды ожидания недоступного GitHub стоят дешевле, чем стенд,
   * который не поднялся из-за проверки версии.
   */
  updatePromise ??= checkForUpdate(pkg.version).catch(() => null);
  const update = await updatePromise;
  const notice = updateNotice(update);

  /* instructions клиент показывает модели при подключении. Без них агент видит четыре десятка
     описаний без всякой рамки и не понимает, для каких задач сюда идти. */
  const server = new McpServer(
    { name: 'layout-testing', version: pkg.version },
    { instructions: notice ? `${INSTRUCTIONS}\n\n${notice}` : INSTRUCTIONS },
  );

  const set = selectedGroups();
  const on = (group) => !set.groups || set.groups.has(group);

  if (on('session')) registerSession(server);
  if (on('observe')) registerObserve(server);
  if (on('layout')) registerLayout(server);
  if (on('visual')) registerVisual(server);
  if (on('a11y')) registerA11y(server);
  if (on('perf')) registerPerf(server);
  if (on('seo')) registerSeo(server);
  if (on('static')) registerStatic(server);
  if (on('composite')) registerComposite(server);
  if (on('crawl')) registerCrawl(server);
  // Состояние стенда знает про обновление — оно посчитано выше и передаётся сюда, а не
  // перезапрашивается на каждый вызов stand_info. Группа не отключается никогда: без
  // stand_info агенту нечем выяснить, почему остального нет.
  registerArtifacts(server, { update, toolSet: set.name, toolSets: Object.keys(TOOL_SETS) });
  /* help не отключается по той же причине, что и stand_info: он объясняет то, что вынуто из
     описаний, и без него сокращённые описания превратились бы просто в неполные. */
  registerHelp(server);
  /* Ресурсы — второй путь к тому же: инструмент возвращает ссылку, клиент решает, когда её
     раскрыть. Сводку о стенде обе двери берут из одной функции, иначе они разъедутся. */
  /* Промпты не занимают места в манифесте: клиент перечисляет их отдельно и подтягивает тело
     только по выбору человека. Поэтому здесь лежит порядок шагов целиком — то, чему в
     описаниях инструментов места нет. */
  registerPrompts(server);
  registerResources(server, {
    standInfo: () => buildStandInfo({ update, toolSet: set.name, toolSets: Object.keys(TOOL_SETS) }),
  });

  /* Ставится последним: обработчики tools/list и tools/call к этому моменту уже на месте,
     а патч забирает прежние себе и вызывает их сам. */
  installProtocolPatches(server);

  return server;
}
