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

export async function createServer() {
  await ensureDirs();

  /*
   * Проверка обновлений идёт до создания сервера, потому что её результат дописывается в
   * instructions: иначе агент узнает о новой версии, только если сам спросит, а спрашивать ему
   * незачем. Упасть она не может — внутри таймаут и перехват любых отказов, — но и задержать
   * запуск надолго тоже: секунды ожидания недоступного GitHub стоят дешевле, чем стенд,
   * который не поднялся из-за проверки версии.
   */
  const update = await checkForUpdate(pkg.version).catch(() => null);
  const notice = updateNotice(update);

  /* instructions клиент показывает модели при подключении. Без них агент видит четыре десятка
     описаний без всякой рамки и не понимает, для каких задач сюда идти. */
  const server = new McpServer(
    { name: 'layout-testing', version: pkg.version },
    { instructions: notice ? `${INSTRUCTIONS}\n\n${notice}` : INSTRUCTIONS },
  );

  registerSession(server);
  registerObserve(server);
  registerLayout(server);
  registerVisual(server);
  registerA11y(server);
  registerPerf(server);
  registerSeo(server);
  registerStatic(server);
  registerComposite(server);
  registerCrawl(server);
  // Состояние стенда знает про обновление — оно посчитано выше и передаётся сюда, а не
  // перезапрашивается на каждый вызов stand_info.
  registerArtifacts(server, { update });

  return server;
}
