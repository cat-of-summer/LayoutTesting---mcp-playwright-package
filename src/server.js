import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

import { CONFIG, DIRS, BROWSERS, VIEWPORTS } from './config.js';
import { artifactRef, ensureDirs, listRuns, newRunId, pruneRuns, publicUrl, siteRef, slug } from './artifacts.js';
import {
  createSession,
  closeSession,
  getSession,
  listSessions,
  gotoAndSettle,
  summarizeFailures,
} from './browser/pool.js';
import { profileKey } from './browser/profile.js';
import { evaluateOnPage } from './browser/evaluate.js';
import { addInjection, clearInjections, listInjections, removeInjection } from './browser/inject.js';
import { addRoute, clearRoutes, listRoutes } from './browser/routes.js';
import { layoutAudit, computedStyles, AUDIT_CATEGORIES } from './checks/layout.js';
import { matchedRules } from './checks/cssom.js';
import { elementLayers } from './checks/layers.js';
import { pageSnapshot } from './checks/snapshot.js';
import { takeScreenshot, compareWithBaseline, inlineImage, listBaselines } from './checks/visual.js';
import { comparePages } from './checks/compare.js';
import { compareLayout } from './checks/compare-dom.js';
import { buildVisualGuide } from './checks/guide.js';
import { runAxe, runPa11y } from './checks/a11y.js';
import { installVitalsCollector, readVitals, runLighthouse } from './checks/perf.js';
import { validateHtmlWithVnu, validateHtmlLocal, lintCss, readLocalFile } from './checks/static.js';
import { auditStorybook } from './checks/storybook.js';
import { runAudit, ALL_CHECKS } from './audit.js';
import { runMatrix, AXES } from './matrix.js';
import { IMAGE_MIME, json, pkg, profileSchema, text } from './tools/shared.js';
import { resolveInArtifacts, resolveInRoot } from './paths.js';
import { seoFromHtml, seoFromPage } from './seo/page.js';
import { savePage } from './mirror/save.js';
import { register as registerCrawl } from './tools/crawl.js';
import { clearStorage, exportState, getStorage, importState, listStates, setStorage } from './browser/storage.js';

export async function createServer() {
  await ensureDirs();
  const server = new McpServer({ name: 'layout-testing', version: pkg.version });

  // ---------- Сессия и навигация ----------

  server.registerTool(
    'browser_open',
    {
      title: 'Открыть браузер',
      description:
        'Создаёт сессию браузера с заданными условиями просмотра и, если передан url, сразу переходит на страницу. Возвращает sessionId для остальных инструментов.',
      inputSchema: { url: z.string().optional(), ...profileSchema },
    },
    async ({ url, ...profile }) => {
      const session = await createSession(profile);
      const result = {
        sessionId: session.id,
        profileKey: session.key,
        profile: session.profile,
        unsupported: session.unsupported,
      };
      if (url) result.navigation = await gotoAndSettle(session, url);
      return json(result);
    },
  );

  server.registerTool(
    'browser_goto',
    {
      title: 'Перейти по адресу',
      description: 'Навигация в существующей сессии со стабилизацией страницы (стоп-анимации, ожидание шрифтов).',
      inputSchema: {
        sessionId: z.string(),
        url: z.string(),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
        save: z
          .boolean()
          .optional()
          .describe('Сохранить страницу в локальное зеркало сразу после перехода — дальше её можно разбирать, не трогая чужой сервер'),
      },
    },
    async ({ sessionId, url, waitUntil, save }) => {
      const session = getSession(sessionId);
      const navigation = await gotoAndSettle(session, url, { waitUntil });
      if (!save) return json(navigation);

      const saved = await savePage(session);
      return json({ navigation, saved: { ...saved, ...siteRef(saved.files.page) } });
    },
  );

  server.registerTool(
    'browser_act',
    {
      title: 'Действие на странице',
      description: 'Клик, ввод текста, нажатие клавиши, наведение, прокрутка или ожидание селектора.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['click', 'fill', 'press', 'hover', 'scroll', 'wait', 'select']),
        selector: z.string().optional(),
        value: z.string().optional().describe('Текст для fill, клавиша для press, значение для select'),
        x: z.number().optional().describe('Прокрутка по горизонтали'),
        y: z.number().optional().describe('Прокрутка по вертикали'),
      },
    },
    async ({ sessionId, action, selector, value, x = 0, y = 0 }) => {
      const { page } = getSession(sessionId);
      switch (action) {
        case 'click': await page.locator(selector).first().click(); break;
        case 'fill': await page.locator(selector).first().fill(value ?? ''); break;
        case 'press': await page.locator(selector).first().press(value ?? 'Enter'); break;
        case 'hover': await page.locator(selector).first().hover(); break;
        case 'select': await page.locator(selector).first().selectOption(value ?? ''); break;
        case 'scroll': await page.evaluate(([sx, sy]) => window.scrollBy(sx, sy), [x, y]); break;
        case 'wait': await page.locator(selector).first().waitFor({ state: 'visible' }); break;
        default: throw new Error(`Неизвестное действие: ${action}`);
      }
      return json({ ok: true, action, selector, url: page.url() });
    },
  );

  server.registerTool(
    'browser_eval',
    {
      title: 'Выполнить JS на странице',
      description:
        'Выполняет выражение или тело функции в контексте страницы и возвращает результат. Годится и IIFE, и цепочка через .map(function(){return …}), и несколько инструкций с return в конце. Если результат undefined, об этом сказано явно, а не возвращается пустой ответ.',
      inputSchema: { sessionId: z.string(), expression: z.string() },
    },
    async ({ sessionId, expression }) => json(await evaluateOnPage(getSession(sessionId).page, expression)),
  );

  server.registerTool(
    'browser_style',
    {
      title: 'Патч CSS/JS на страницу',
      description:
        'Вкатывает свой CSS или JS поверх открытой страницы и переприменяет его после каждого перехода. Так проверяют правку на чужом или боевом стенде, ничего там не меняя: добавили правило — сняли скриншот — сравнили.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['add', 'remove', 'clear', 'list']).optional().describe('По умолчанию add'),
        css: z.string().optional().describe('Текст CSS'),
        js: z.string().optional().describe('Скрипт, выполняется при добавлении и после каждой навигации'),
        href: z.string().optional().describe('Подключить таблицу стилей по URL'),
        id: z.string().optional().describe('Метка патча: повторное добавление с тем же id заменяет прежний'),
      },
    },
    async ({ sessionId, action = 'add', css, js, href, id }) => {
      const session = getSession(sessionId);
      switch (action) {
        case 'add':
          return json({ added: await addInjection(session, { css, js, href, id }), injections: listInjections(session) });
        case 'remove':
          if (!id) throw new Error('Для remove нужен id.');
          return json({ ...(await removeInjection(session, id)), injections: listInjections(session) });
        case 'clear':
          return json({ cleared: await clearInjections(session) });
        default:
          return json({ injections: listInjections(session) });
      }
    },
  );

  server.registerTool(
    'browser_route',
    {
      title: 'Перехват запросов',
      description:
        'Правила на сетевые запросы страницы: отрезать аналитику и чаты, подменить таблицу стилей или скрипт своей версией, подставить заглушки вместо отсутствующих картинок, переписать адреса — когда сайт отдаёт абсолютные ссылки на боевой домен. Переживает навигацию; в list виден счётчик попаданий, чтобы отличить несработавшее правило от сработавшего.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['add', 'list', 'clear']).optional().describe('По умолчанию add'),
        pattern: z.string().optional().describe('Glob (**/analytics/**) или регулярное выражение в виде /…/flags'),
        handler: z
          .enum(['block', 'fulfill', 'file', 'redirect', 'rewrite', 'passthrough'])
          .optional()
          .describe(
            'block — оборвать, fulfill — отдать body, file — отдать файл стенда, redirect — увести все совпадения на один url, rewrite — заменить кусок адреса, сохранив путь',
          ),
        body: z.string().optional(),
        contentType: z.string().optional(),
        status: z.number().optional(),
        url: z.string().optional().describe('Куда увести запрос при redirect'),
        file: z.string().optional().describe('Путь относительно рабочего каталога стенда'),
        from: z
          .string()
          .optional()
          .describe(
            'Для rewrite: что заменить в адресе. Подстрока или регулярное выражение в виде /…/flags. Например /^https?:\\/\\/site\\.ru/',
          ),
        to: z.string().optional().describe('Для rewrite: чем заменить. В регулярном выражении работают $1, $2'),
      },
    },
    async ({ sessionId, action = 'add', ...rest }) => {
      const session = getSession(sessionId);
      if (action === 'clear') return json({ cleared: await clearRoutes(session) });
      if (action === 'list') return json({ routes: listRoutes(session) });
      return json({ added: await addRoute(session, rest), routes: listRoutes(session) });
    },
  );

  server.registerTool(
    'browser_sessions',
    { title: 'Список сессий', description: 'Показывает открытые сессии браузера.', inputSchema: {} },
    async () => json({ sessions: listSessions() }),
  );

  server.registerTool(
    'browser_close',
    { title: 'Закрыть сессию', description: 'Закрывает сессию браузера и освобождает память.', inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) => json({ closed: await closeSession(sessionId) }),
  );

  server.registerTool(
    'browser_storage',
    {
      title: 'Куки и хранилища',
      description:
        'Читает и подкладывает куки, localStorage и sessionStorage, а export и import сохраняют состояние сессии на диск и возвращают его в новую. Так логин переживает browser_close: сохранённое имя потом передаётся в storageState при открытии любой сессии. Важно: localStorage и sessionStorage снимаются с текущей страницы, а не со всего сайта — API уровня контекста у них нет.',
      inputSchema: {
        sessionId: z.string().optional().describe('Не нужен только для action: list'),
        action: z.enum(['get', 'set', 'clear', 'export', 'import', 'list']).optional().describe('По умолчанию get'),
        scope: z.enum(['cookies', 'local', 'session', 'all']).optional().describe('По умолчанию all'),
        name: z.string().optional().describe('Ключ для set в local и session; имя файла для export и import'),
        value: z.string().optional().describe('Значение для set. Для cookies — JSON: объект или массив куки'),
      },
    },
    async ({ sessionId, action = 'get', scope = 'all', name, value }) => {
      if (action === 'list') return json({ dir: DIRS.state, states: await listStates() });
      if (!sessionId) throw new Error('Нужен sessionId.');
      const session = getSession(sessionId);

      switch (action) {
        case 'export':
          if (!name) throw new Error('Для export нужно name — под каким именем сохранить.');
          return json(await exportState(session, name));
        case 'import':
          if (!name) throw new Error('Для import нужно name — какое состояние влить.');
          return json(await importState(session, name));
        case 'set':
          if (scope === 'all') throw new Error('Для set нужен конкретный scope: cookies, local или session.');
          return json(await setStorage(session, scope, name, value));
        case 'clear':
          return json(await clearStorage(session, scope));
        default:
          return json(await getStorage(session, scope));
      }
    },
  );

  // ---------- Наблюдение ----------

  server.registerTool(
    'page_snapshot',
    {
      title: 'Текстовый слепок страницы',
      description:
        'Дерево ролей, имён и селекторов. Дешевле скриншота по объёму и содержит готовые селекторы для действий.',
      inputSchema: {
        sessionId: z.string(),
        maxNodes: z.number().optional(),
        interactiveOnly: z.boolean().optional().describe('Только ссылки, кнопки и поля'),
      },
    },
    async ({ sessionId, maxNodes, interactiveOnly }) => {
      const snap = await pageSnapshot(getSession(sessionId).page, { maxNodes, interactiveOnly });
      return text(
        `${snap.title} — ${snap.url}\nlang=${snap.lang} dir=${snap.dir}${snap.truncated ? ' (обрезано)' : ''}\n\n${snap.text}`,
      );
    },
  );

  server.registerTool(
    'page_logs',
    {
      title: 'Логи страницы',
      description:
        'Консоль, необработанные ошибки JS и неудачные сетевые запросы. По умолчанию — только с последнего перехода; sinceNavigation: false отдаёт всё с момента открытия сессии.',
      inputSchema: {
        sessionId: z.string(),
        kind: z.enum(['all', 'console', 'errors', 'network']).optional(),
        onlyProblems: z.boolean().optional(),
        sinceNavigation: z
          .boolean()
          .optional()
          .describe('Только записи после последнего перехода. По умолчанию true'),
      },
    },
    async ({ sessionId, kind = 'all', onlyProblems = true, sinceNavigation = true }) => {
      const session = getSession(sessionId);
      const { logs } = session;
      /*
       * По умолчанию показываем только текущую страницу: иначе ошибка, оставшаяся от
       * позапрошлого перехода, приезжает в разбор нынешнего и уводит в сторону.
       */
      const marks = (sinceNavigation && session.logMarks) || { console: 0, errors: 0, network: 0 };
      const rawNetwork = logs.network.slice(marks.network);
      const rawConsole = logs.console.slice(marks.console);

      const network = onlyProblems
        ? rawNetwork.filter((n) => n.failure || (n.status && n.status >= 400))
        : rawNetwork;
      const console_ = onlyProblems
        ? rawConsole.filter((c) => c.type === 'error' || c.type === 'warning')
        : rawConsole;
      const all = { console: console_, errors: logs.errors.slice(marks.errors), network };
      const scope = sinceNavigation && session.logMarks ? 'с последнего перехода' : 'с открытия сессии';
      return json({ scope, ...(kind === 'all' ? all : { [kind]: all[kind === 'errors' ? 'errors' : kind] }) });
    },
  );

  server.registerTool(
    'page_save',
    {
      title: 'Сохранить страницу локально',
      description:
        'Кладёт страницу в локальное зеркало: отрендеренный DOM с переписанными на локальные копии ссылками, отдельно сырой ответ сервера до JS, отдельно ресурсы с дедупликацией по содержимому. Копия открывается через browser_goto по internalUrl, и к ней применимы все остальные инструменты — layout_audit, screenshot, computed_styles. Дальше страницу можно разбирать сколько угодно, не обращаясь к чужому серверу.',
      inputSchema: {
        sessionId: z.string().optional().describe('Сохранить текущую страницу сессии'),
        url: z.string().optional().describe('Открыть свою одноразовую сессию по адресу и сохранить её'),
        siteId: z.string().optional().describe('Имя каталога в архиве. По умолчанию берётся из хоста'),
        assets: z.boolean().optional().describe('Тянуть ли CSS, картинки и шрифты. По умолчанию да'),
        scripts: z
          .enum(['strip', 'keep'])
          .optional()
          .describe('strip (по умолчанию) вырезает скрипты: на копии аналитика стучит в сеть, а роутер SPA подменяет страницу. JSON-LD остаётся в любом случае'),
        raw: z.boolean().optional().describe('Сохранять ли сырой ответ сервера отдельным файлом. По умолчанию да'),
        ...profileSchema,
      },
    },
    async ({ sessionId, url, siteId, assets, scripts, raw, ...profile }) => {
      const done = (saved) => json({
        ...saved,
        page: siteRef(saved.files.page),
        raw: saved.files.raw ? siteRef(saved.files.raw) : null,
        note: 'Открывать копию из browser_goto надо по internalUrl: публичного порта внутри контейнера нет.',
      });

      if (sessionId) return done(await savePage(getSession(sessionId), { siteId, assets, scripts, raw }));
      if (!url) throw new Error('Нужен sessionId или url.');

      const session = await createSession(profile);
      try {
        await gotoAndSettle(session, url);
        return done(await savePage(session, { siteId, assets, scripts, raw }));
      } finally {
        await closeSession(session.id);
      }
    },
  );

  // ---------- Вёрстка ----------

  server.registerTool(
    'layout_audit',
    {
      title: 'Эвристики вёрстки',
      description:
        'Ищет горизонтальный скролл, вылеты за viewport, наложения элементов, обрезанный текст, текст под непрозрачным слоем, мёртвый z-index (задан на position: static), битые картинки, картинки без размеров, мелкие тач-таргеты и низкий контраст.',
      inputSchema: {
        sessionId: z.string(),
        minTarget: z.number().optional().describe('Минимальный размер тач-таргета, px (по умолчанию 24)'),
        contrastRatio: z.number().optional().describe('Требуемый контраст обычного текста (по умолчанию 4.5)'),
        maxItems: z.number().optional().describe('Сколько примеров показывать в каждой категории (по умолчанию 50)'),
        categories: z
          .array(z.enum(AUDIT_CATEGORIES))
          .optional()
          .describe('Подробности только по этим категориям. Счётчики по всем возвращаются всегда'),
      },
    },
    async ({ sessionId, minTarget, contrastRatio, maxItems, categories }) =>
      json(await layoutAudit(getSession(sessionId).page, { minTarget, contrastRatio, maxItems, categories })),
  );

  server.registerTool(
    'computed_styles',
    {
      title: 'Вычисленные стили',
      description:
        'Геометрия и итоговые CSS-свойства элемента — чтобы понять, почему блок не там, где ожидается. Умеет псевдоэлементы (::before, ::after) и разом все совпадения селектора.',
      inputSchema: {
        sessionId: z.string(),
        selector: z.string(),
        props: z.array(z.string()).optional(),
        pseudo: z
          .enum(['::before', '::after', '::marker', '::placeholder', '::selection', '::first-line', '::first-letter'])
          .optional()
          .describe('Смотреть псевдоэлемент, а не сам элемент'),
        all: z.boolean().optional().describe('Все совпадения селектора, а не только первое'),
        maxItems: z.number().optional(),
      },
    },
    async ({ sessionId, selector, props, pseudo, all, maxItems }) =>
      json(await computedStyles(getSession(sessionId).page, selector, props, { pseudo, all, maxItems })),
  );

  server.registerTool(
    'matched_rules',
    {
      title: 'Какое правило победило',
      description:
        'Все CSS-правила, матчащие элемент: селектор, специфичность, файл и строка, объявления — и по каждому свойству кто победил, а кого перебили. Отвечает на вопрос «почему моя правка не применилась», на который getComputedStyle не отвечает. Понимает псевдоэлементы. Только chromium.',
      inputSchema: {
        sessionId: z.string(),
        selector: z.string(),
        pseudo: z
          .enum(['::before', '::after', '::marker', '::placeholder', '::selection', '::first-line', '::first-letter'])
          .optional(),
        properties: z
          .array(z.string())
          .optional()
          .describe('Интересующие свойства, например ["z-index","position"]. Без них показываются только конфликты'),
        maxRules: z.number().optional(),
      },
    },
    async ({ sessionId, selector, pseudo, properties, maxRules }) =>
      json(await matchedRules(getSession(sessionId).page, { selector, pseudo, properties, maxRules })),
  );

  server.registerTool(
    'element_layers',
    {
      title: 'Слои и перекрытия',
      description:
        'Почему элемента не видно и кто лежит сверху: порядок отрисовки, цепочка стек-контекстов над элементом, перекрывающие соседи и что реально нарисовано в его точках. Отдельно предупреждает про z-index на position: static и про z-index, который считается внутри чужого стек-контекста.',
      inputSchema: {
        sessionId: z.string(),
        selector: z.string(),
        pseudo: z
          .enum(['::before', '::after', '::marker', '::placeholder'])
          .optional()
          .describe('Разбирать псевдоэлемент, а не сам элемент'),
        maxItems: z.number().optional(),
      },
    },
    async ({ sessionId, selector, pseudo, maxItems }) =>
      json(await elementLayers(getSession(sessionId).page, { selector, pseudo, maxItems })),
  );

  // ---------- Скриншоты и визуальная регрессия ----------

  server.registerTool(
    'screenshot',
    {
      title: 'Скриншот',
      description:
        'Снимок страницы или элемента. Возвращает путь и URL; картинку в ответ вкладывает только при inline=true. Снимок по selector — это область элемента: наехавшие на неё чужие блоки в кадр попадут. Если часть ресурсов страницы не загрузилась, в ответе будет warnings — снимок в этом случае неполный.',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional(),
        fullPage: z.boolean().optional(),
        selector: z.string().optional().describe('Снять только этот элемент'),
        mask: z.array(z.string()).optional().describe('Селекторы нестабильных зон — закрашиваются'),
        hide: z
          .array(z.string())
          .optional()
          .describe('Убрать с кадра: cookie-баннеры, чаты, всплывашки. Ставит visibility: hidden, layout не едет'),
        isolate: z
          .array(z.string())
          .optional()
          .describe(
            'Оставить в кадре только эти элементы, остальных соседей убрать из потока (display: none). Так снимают пару соседних блоков без остальных — например, чтобы показать наложение',
          ),
        format: z.enum(['png', 'jpeg', 'webp']).optional().describe('По умолчанию png'),
        quality: z.number().optional().describe('Качество jpeg и webp, 1–100 (по умолчанию 80)'),
        maxWidth: z.number().optional().describe('Уменьшить до этой ширины — для вставки в документы'),
        inline: z.boolean().optional().describe('Вложить уменьшенную картинку в ответ'),
        runId: z.string().optional(),
      },
    },
    async ({
      sessionId,
      name = 'screenshot',
      fullPage = true,
      selector,
      mask,
      hide,
      isolate,
      format,
      quality,
      maxWidth,
      inline = false,
      runId,
    }) => {
      const session = getSession(sessionId);
      const shot = await takeScreenshot(session.page, {
        runId: runId || newRunId(slug(name)),
        name: `${slug(name)}__${slug(session.key)}`,
        fullPage,
        selector,
        mask,
        hide,
        isolate,
        format,
        quality,
        maxWidth,
      });

      // Снимок «удался» и при полностью битой странице: сообщаем об этом здесь,
      // а не оставляем агенту выяснять по пустым рамкам на готовом кадре.
      const failures = summarizeFailures(session.logs.network);
      const payload = failures ? { ...shot, warnings: failures } : shot;

      const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
      if (inline) {
        const img = await inlineImage(shot.path);
        content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
      return { content };
    },
  );

  server.registerTool(
    'compare_pages',
    {
      title: 'Сравнить две страницы',
      description:
        'Сличает две живые страницы между собой на списке ширин: макет против собранной страницы. У каждой стороны свой HTTP-доступ и свои условия. Разная высота сравнению не мешает — кадры дополняются до общего холста, а разница высот отдаётся отдельным числом. Картинки в ответ не вкладываются: смотреть в артефактах.',
      inputSchema: {
        a: z
          .object({
            url: z.string(),
            auth: z.string().optional().describe('HTTP basic auth «пользователь:пароль»'),
            extraHTTPHeaders: z.record(z.string()).optional(),
            hostMap: z.record(z.string()).optional(),
            browser: z.enum(BROWSERS).optional(),
            colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
            waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
          })
          .describe('Что считаем образцом — обычно макет'),
        b: z
          .object({
            url: z.string(),
            auth: z.string().optional(),
            extraHTTPHeaders: z.record(z.string()).optional(),
            hostMap: z.record(z.string()).optional(),
            browser: z.enum(BROWSERS).optional(),
            colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
            waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
          })
          .describe('Что проверяем — обычно собранная страница'),
        viewports: z.array(z.string()).optional().describe('По умолчанию desktop'),
        name: z.string().optional(),
        selector: z.string().optional().describe('Сравнивать только этот блок'),
        fullPage: z.boolean().optional(),
        hide: z.array(z.string()).optional(),
        mask: z.array(z.string()).optional(),
        threshold: z.number().optional().describe('Допустимое расхождение в процентах пикселей'),
      },
    },
    async ({ a, b, viewports = ['desktop'], name = 'compare', selector, fullPage = true, hide = [], mask = [], threshold }) => {
      const runId = newRunId(name);
      const res = await comparePages({
        pool: { createSession, gotoAndSettle, closeSession },
        runId,
        name,
        a,
        b,
        viewports,
        selector,
        fullPage,
        hide,
        mask,
        ...(threshold === undefined ? {} : { threshold }),
      });
      const { dir, ...payload } = res;
      return json({ ...payload, url: publicUrl(dir) });
    },
  );

  server.registerTool(
    'compare_layout',
    {
      title: 'Сравнить вёрстку двух страниц',
      description:
        'Сличает макет и собранную страницу по DOM, а не по пикселям: какие классы есть только в одной из них и чем различаются одноимённые блоки — размер коробки, шрифт, отступы, сетка. Не зависит от контента, поэтому отвечает на вопрос «сошлась ли вёрстка» там, где попиксельное сравнение бесполезно из-за разных текстов и фотографий.',
      inputSchema: {
        a: z
          .object({
            url: z.string(),
            auth: z.string().optional(),
            extraHTTPHeaders: z.record(z.string()).optional(),
            hostMap: z.record(z.string()).optional(),
            browser: z.enum(BROWSERS).optional(),
            colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
            waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
          })
          .describe('Образец — обычно макет'),
        b: z
          .object({
            url: z.string(),
            auth: z.string().optional(),
            extraHTTPHeaders: z.record(z.string()).optional(),
            hostMap: z.record(z.string()).optional(),
            browser: z.enum(BROWSERS).optional(),
            colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
            waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
          })
          .describe('Проверяемая страница'),
        viewport: z.string().optional(),
        tolerance: z.number().optional().describe('Допуск по размеру в пикселях, по умолчанию 2'),
        props: z.array(z.string()).optional().describe('Какие CSS-свойства сверять'),
        maxItems: z.number().optional(),
      },
    },
    async ({ a, b, viewport = 'desktop', tolerance, props, maxItems }) => {
      const res = await compareLayout({
        pool: { createSession, gotoAndSettle, closeSession },
        a,
        b,
        viewport,
        ...(tolerance === undefined ? {} : { tolerance }),
        ...(props === undefined ? {} : { props }),
        ...(maxItems === undefined ? {} : { maxItems }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'visual_compare',
    {
      title: 'Сравнить с эталоном',
      description:
        'Снимает страницу и сравнивает с эталоном. Если эталона нет, снимок становится эталоном и это сообщается явно. Формат и масштаб здесь не настраиваются намеренно: сравнение попиксельное, и любая перекодировка обесценила бы накопленные эталоны.',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().describe('Имя эталона'),
        fullPage: z.boolean().optional(),
        selector: z.string().optional(),
        mask: z.array(z.string()).optional(),
        hide: z.array(z.string()).optional().describe('Убрать с кадра: cookie-баннеры, чаты, всплывашки'),
        isolate: z
          .array(z.string())
          .optional()
          .describe('Оставить в кадре только эти элементы (display: none остальным соседям)'),
        threshold: z.number().optional().describe('Допустимое расхождение в процентах пикселей'),
        updateBaseline: z.boolean().optional().describe('Перезаписать эталон текущим снимком'),
      },
    },
    async ({ sessionId, name, fullPage = true, selector, mask, hide, isolate, threshold, updateBaseline }) => {
      const session = getSession(sessionId);
      const runId = newRunId(slug(name));
      const shot = await takeScreenshot(session.page, {
        runId,
        name: `${slug(name)}__${slug(session.key)}`,
        fullPage,
        selector,
        mask,
        hide,
        isolate,
      });
      const result = await compareWithBaseline({
        runId,
        name,
        profileKey: session.key,
        actualPath: shot.path,
        threshold,
        updateBaseline,
      });
      return json({ runId, ...result });
    },
  );

  server.registerTool(
    'visual_guide',
    {
      title: 'Визуальный справочник',
      description:
        'Собирает один самодостаточный HTML: перечисленные блоки страницы, снятые в нескольких ширинах, с подписями параметров. Документ для человека — контент-менеджеру показать, что даёт каждая комбинация настроек. Картинки вшиты в файл, его можно переслать одним вложением.',
      inputSchema: {
        url: z.string().describe('Страница, с которой снимать'),
        items: z
          .array(
            z.object({
              selector: z.string().describe('Блок, который снимаем'),
              title: z.string().optional().describe('Заголовок карточки'),
              params: z.record(z.string()).optional().describe('Подписи вида «Расположение: Горизонтальное»'),
              note: z.string().optional(),
              isolate: z
                .array(z.string())
                .optional()
                .describe('Оставить в кадре только это — например блок и его соседа, чтобы показать наложение'),
              hide: z.array(z.string()).optional(),
            }),
          )
          .describe('Варианты по порядку появления в документе'),
        title: z.string().optional(),
        intro: z.string().optional().describe('Абзац-введение под заголовком'),
        profiles: z
          .array(z.string())
          .optional()
          .describe('Ширины: имена пресетов или WxH. По умолчанию ["desktop","mobile"]'),
        auth: z.string().optional().describe('HTTP basic auth в виде "пользователь:пароль"'),
        browser: z.enum(BROWSERS).optional(),
        format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Формат вшитых картинок, по умолчанию webp'),
        quality: z.number().optional(),
        maxWidth: z.number().optional().describe('Ширина вшитых картинок, по умолчанию 1000'),
      },
    },
    async ({ url, items, title, intro, profiles, auth, browser, format, quality, maxWidth }) =>
      json(
        await buildVisualGuide({
          url,
          items,
          title,
          intro,
          profiles,
          auth,
          browser,
          image: { format, quality, maxWidth },
        }),
      ),
  );

  server.registerTool(
    'visual_baselines',
    { title: 'Эталоны', description: 'Список сохранённых эталонов визуальной регрессии.', inputSchema: {} },
    async () => json({ dir: DIRS.baselines, baselines: await listBaselines(DIRS.baselines) }),
  );

  // ---------- Доступность ----------

  server.registerTool(
    'a11y_axe',
    {
      title: 'Проверка axe-core',
      description: 'Правила WCAG внутри открытой страницы: видит её в текущем состоянии, после логина и раскрытых меню.',
      inputSchema: {
        sessionId: z.string(),
        tags: z.array(z.string()).optional().describe('Например wcag2aa, wcag21aa, best-practice'),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      },
    },
    async ({ sessionId, tags, include, exclude }) =>
      json(await runAxe(getSession(sessionId).page, { tags, include, exclude })),
  );

  server.registerTool(
    'a11y_pa11y',
    {
      title: 'Проверка pa11y',
      description: 'Второй набор правил (HTML CodeSniffer) по URL — ловит не то же, что axe.',
      inputSchema: {
        url: z.string(),
        standard: z.enum(['WCAG2A', 'WCAG2AA', 'WCAG2AAA']).optional(),
      },
    },
    async ({ url, standard }) => json(await runPa11y(url, { standard })),
  );

  // ---------- Метрики ----------

  server.registerTool(
    'web_vitals',
    {
      title: 'Web Vitals',
      description:
        'CLS, LCP, FCP, TTFB для указанного URL с перечислением элементов, сдвинувших layout. Ловит то, чего не видно на статичном скриншоте.',
      inputSchema: { url: z.string(), settleMs: z.number().optional(), ...profileSchema },
    },
    async ({ url, settleMs, ...profile }) => {
      const session = await createSession(profile);
      try {
        await installVitalsCollector(session.page);
        const nav = await gotoAndSettle(session, url, { stabilizePage: false });
        return json({ navigation: nav, profileKey: session.key, vitals: await readVitals(session.page, { settleMs }) });
      } finally {
        await closeSession(session.id);
      }
    },
  );

  server.registerTool(
    'lighthouse',
    {
      title: 'Отчёт Lighthouse',
      description: 'Полный прогон Lighthouse. Возвращает оценки, метрики и провалившиеся аудиты, HTML-отчёт кладёт в артефакты.',
      inputSchema: {
        url: z.string(),
        categories: z.array(z.enum(['performance', 'accessibility', 'best-practices', 'seo'])).optional(),
        preset: z.enum(['mobile', 'desktop']).optional(),
      },
    },
    async ({ url, categories, preset }) => json(await runLighthouse(url, { runId: newRunId('lighthouse'), categories, preset })),
  );

  // ---------- SEO ----------

  server.registerTool(
    'seo_page',
    {
      title: 'SEO-поля страницы',
      description:
        'Заголовок, описание, canonical, hreflang, robots, Open Graph, Twitter, дерево заголовков, инвентарь ссылок и картинок, микроразметка (JSON-LD, микроданные, RDFa). Отдельно считает indexable с перечислением причин, по которым страница не попадёт в индекс. Источник — открытая сессия, произвольный URL или сохранённый HTML: по сохранённому работает без единого сетевого запроса.',
      inputSchema: {
        sessionId: z.string().optional().describe('Разобрать страницу открытой сессии — как она выглядит сейчас, после логина и раскрытых меню'),
        url: z.string().optional().describe('Открыть свою одноразовую сессию по адресу'),
        html: z.string().optional().describe('Разобрать переданную разметку без браузера'),
        file: z.string().optional().describe('Разобрать сохранённый файл: путь относительно рабочего каталога стенда'),
        pageUrl: z.string().optional().describe('Адрес, относительно которого разрешать ссылки в html или file. Без него относительные адреса и саморефренс canonical не посчитать'),
        ...profileSchema,
      },
    },
    async ({ sessionId, url, html, file, pageUrl, ...profile }) => {
      if (sessionId) {
        const session = getSession(sessionId);
        return json(await seoFromPage(session.page, session.lastResponse));
      }

      if (html || file) {
        const source = html ?? (await readFile(resolveInRoot(file), 'utf8'));
        /* Без адреса ссылки не разрешаются и canonical не с чем сравнивать — говорим об этом
           сразу, а не отдаём отчёт, где половина полей молча null. */
        if (!pageUrl) throw new Error('Для html и file нужен pageUrl — адрес, относительно которого разрешать ссылки.');
        return json(await seoFromHtml(source, { url: pageUrl }));
      }

      if (!url) throw new Error('Нужен sessionId, url, html или file.');

      const session = await createSession(profile);
      try {
        const navigation = await gotoAndSettle(session, url);
        return json({ navigation, ...(await seoFromPage(session.page, session.lastResponse)) });
      } finally {
        await closeSession(session.id);
      }
    },
  );

  // ---------- Статические проверки ----------

  server.registerTool(
    'validate_html',
    {
      title: 'Валидация HTML',
      description:
        'Проверяет разметку через Nu HTML Checker. Источник — открытая сессия, произвольный URL или переданный текст.',
      inputSchema: {
        sessionId: z.string().optional(),
        url: z.string().optional(),
        html: z.string().optional(),
      },
    },
    async ({ sessionId, url, html }) => {
      let source = html;
      if (!source && sessionId) source = await getSession(sessionId).page.content();
      if (!source && url) source = await (await fetch(url)).text();
      if (!source) throw new Error('Нужен sessionId, url или html.');
      try {
        return json({ source: 'vnu', ...(await validateHtmlWithVnu(source)) });
      } catch (err) {
        return json({ source: 'html-validate', fallbackReason: err.message, ...(await validateHtmlLocal(source)) });
      }
    },
  );

  server.registerTool(
    'lint_css',
    {
      title: 'Проверка CSS',
      description: 'Stylelint по файлам рабочего каталога или по переданному коду.',
      inputSchema: {
        files: z.array(z.string()).optional().describe('Пути относительно рабочего каталога, глоб поддерживается'),
        code: z.string().optional(),
        config: z.record(z.any()).optional(),
      },
    },
    async ({ files, code, config }) => json(await lintCss({ files, code, config })),
  );

  // ---------- Комплексные прогоны ----------

  server.registerTool(
    'audit',
    {
      title: 'Комплексная проверка страницы',
      description:
        `Открывает URL под заданными условиями и прогоняет выбранные проверки: ${ALL_CHECKS.join(', ')} или all. Возвращает сводку и складывает артефакты.`,
      inputSchema: {
        url: z.string(),
        checks: z.array(z.enum([...ALL_CHECKS, 'all'])).optional(),
        name: z.string().optional().describe('Имя прогона; используется в именах файлов и эталонов'),
        mask: z.array(z.string()).optional(),
        hide: z.array(z.string()).optional().describe('Убрать с кадра: cookie-баннеры, чаты, всплывашки'),
        fullPage: z.boolean().optional(),
        updateBaseline: z.boolean().optional(),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
          .optional()
          .describe('Чего ждать при переходе. Для тяжёлых боевых сайтов — domcontentloaded'),
        timeout: z.number().optional().describe('Таймаут навигации, мс'),
        ...profileSchema,
      },
    },
    async ({ url, checks, name = 'page', mask, hide, fullPage, updateBaseline, waitUntil, timeout, ...profile }) => {
      const report = await runAudit({ url, profile, checks, name, mask, hide, fullPage, updateBaseline, waitUntil, timeout });
      return json({
        runId: report.runId,
        profileKey: report.profileKey,
        summary: report.summary,
        artifacts: `${CONFIG.publicBaseUrl}/${report.runId}/`,
        results: report.results,
        errors: report.errors,
      });
    },
  );

  server.registerTool(
    'matrix_run',
    {
      title: 'Матрица условий',
      description:
        'Прогоняет страницу по декартову произведению осей (браузеры × viewport × тема × RTL × zoom × forced-colors × псевдолокализация × DPR) и собирает сводный HTML-отчёт.',
      inputSchema: {
        url: z.string(),
        name: z.string().optional(),
        checks: z.array(z.enum([...ALL_CHECKS, 'all'])).optional(),
        browsers: z.array(z.enum(BROWSERS)).optional(),
        viewports: z.array(z.string()).optional(),
        colorSchemes: z.array(z.enum(['light', 'dark'])).optional(),
        rtl: z.array(z.boolean()).optional(),
        zooms: z.array(z.number()).optional(),
        forcedColors: z.array(z.enum(['none', 'active'])).optional(),
        pseudoLoc: z.array(z.boolean()).optional(),
        deviceScaleFactors: z.array(z.number()).optional(),
        concurrency: z.number().optional().describe('Сколько комбинаций гнать параллельно (по умолчанию 2)'),
        updateBaseline: z.boolean().optional(),
        mask: z.array(z.string()).optional(),
        hide: z.array(z.string()).optional().describe('Убрать с кадра: cookie-баннеры, чаты, всплывашки'),
      },
    },
    async ({
      url, name = 'matrix', checks, browsers, viewports, colorSchemes, rtl, zooms,
      forcedColors, pseudoLoc, deviceScaleFactors, concurrency, updateBaseline, mask, hide,
    }) => {
      const result = await runMatrix({
        url,
        name,
        checks,
        concurrency,
        updateBaseline,
        mask,
        hide,
        axes: {
          browser: browsers,
          viewport: viewports,
          colorScheme: colorSchemes,
          rtl,
          zoom: zooms,
          forcedColors,
          pseudoLoc,
          deviceScaleFactor: deviceScaleFactors,
        },
      });
      return json({ ...result, report: publicUrl(result.report), axes: AXES });
    },
  );

  server.registerTool(
    'storybook_audit',
    {
      title: 'Обход Storybook',
      description: 'Проходит все истории Storybook, для каждой снимает скриншот и гоняет layout-эвристики и axe.',
      inputSchema: {
        storybookUrl: z.string().describe('Например http://node_myapp:6006'),
        include: z.string().optional().describe('Регулярное выражение по id и заголовку истории'),
        limit: z.number().optional(),
        visual: z.boolean().optional().describe('Сравнивать каждую историю с эталоном'),
        ...profileSchema,
      },
    },
    async ({ storybookUrl, include, limit, visual, ...profile }) =>
      json(await auditStorybook({ storybookUrl, include, limit, visual, profile })),
  );

  // ---------- Артефакты ----------

  server.registerTool(
    'artifacts_list',
    {
      title: 'Артефакты прогонов',
      description: 'Список прогонов и ссылок на их отчёты.',
      inputSchema: { limit: z.number().optional() },
    },
    async ({ limit = 20 }) => {
      const runs = (await listRuns()).slice(0, limit);
      return json({
        baseUrl: CONFIG.publicBaseUrl,
        runs: runs.map((r) => ({ runId: r, url: `${CONFIG.publicBaseUrl}/${r}/` })),
      });
    },
  );

  server.registerTool(
    'artifacts_clean',
    {
      title: 'Очистить артефакты',
      description: 'Удаляет старые прогоны, оставляя последние keep штук.',
      inputSchema: { keep: z.number().optional() },
    },
    async ({ keep }) => json({ removed: await pruneRuns(keep) }),
  );

  server.registerTool(
    'read_artifact',
    {
      title: 'Прочитать артефакт',
      description:
        'Читает файл из каталога артефактов. Текст и JSON отдаются как есть, картинки и прочие бинарники — в base64: иначе снимок, который стенд сам же и сделал, забрать через MCP нечем.',
      inputSchema: {
        file: z.string().describe('Путь относительно каталога артефактов'),
        encoding: z
          .enum(['auto', 'utf8', 'base64'])
          .optional()
          .describe('auto (по умолчанию) определяет по расширению'),
      },
    },
    async ({ file, encoding = 'auto' }) => {
      const abs = resolveInArtifacts(file);

      const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
      const binary = encoding === 'base64' || (encoding === 'auto' && Boolean(mime));
      if (!binary) return text(await readFile(abs, 'utf8'));

      const buf = await readFile(abs);
      const payload = { file, bytes: buf.length, mimeType: mime || 'application/octet-stream', encoding: 'base64' };
      const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
      // Картинку кладём и как image-контент: агенту чаще нужно на неё посмотреть,
      // а не разбирать base64 руками.
      if (mime) content.push({ type: 'image', data: buf.toString('base64'), mimeType: mime });
      else content.push({ type: 'text', text: buf.toString('base64') });
      return { content };
    },
  );

  server.registerTool(
    'read_project_file',
    {
      title: 'Прочитать файл стенда',
      description:
        'Читает файл из рабочего каталога стенда — фикстуру, конфиг матрицы, CSS. Если указан каталог, возвращает его содержимое.',
      inputSchema: { file: z.string() },
    },
    async ({ file }) => {
      const abs = resolveInRoot(file);

      // Каталог вместо файла — обычная опечатка в пути. Сырой EISDIR ничего
      // не подсказывает, а листинг сразу показывает, что здесь лежит.
      const info = await stat(abs).catch(() => null);
      if (!info) {
        throw new Error(`Нет такого файла: ${file}. Корень стенда — ${DIRS.root}.`);
      }
      if (info.isDirectory()) {
        const entries = await readdir(abs, { withFileTypes: true });
        return json({
          directory: file || '.',
          entries: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort(),
        });
      }
      return text(await readLocalFile(file));
    },
  );

  server.registerTool(
    'stand_info',
    {
      title: 'Состояние стенда',
      description: 'Версии, пути, доступные браузеры и viewport-пресеты, адреса артефактов и валидатора.',
      inputSchema: {},
    },
    async () => {
      const vnu = await fetch(`${CONFIG.vnuUrl}/`, { method: 'HEAD' })
        .then((r) => (r.ok ? 'доступен' : `ответил ${r.status}`))
        .catch((e) => `недоступен: ${e.message}`);
      return json({
        version: pkg.version,
        dirs: DIRS,
        publicBaseUrl: CONFIG.publicBaseUrl,
        internalBaseUrl: CONFIG.internalBaseUrl,
        baseUrlNote:
          'publicBaseUrl — для человека снаружи. Внутри стенда проброшенного порта нет: в browser_goto подставляйте internalBaseUrl.',
        vnu: { url: CONFIG.vnuUrl, state: vnu },
        chromePath: CONFIG.chromePath || '(не задан)',
        browsers: BROWSERS,
        viewports: VIEWPORTS,
        checks: ALL_CHECKS,
        sessions: listSessions(),
      });
    },
  );

  registerCrawl(server);

  return server;
}
