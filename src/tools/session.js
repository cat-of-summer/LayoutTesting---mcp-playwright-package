/**
 * Инструменты: сессии браузера, навигация, действия и перехват запросов.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { DIRS } from '../config.js';
import { siteRef } from '../artifacts.js';
import {
  createSession,
  closeSession,
  getSession,
  listEvicted,
  listSessions,
  gotoAndSettle,
} from '../browser/pool.js';
import { profileKey } from '../browser/profile.js';
import { evaluateOnPage } from '../browser/evaluate.js';
import { addInjection, clearInjections, listInjections, removeInjection } from '../browser/inject.js';
import { addRoute, clearRoutes, listRoutes } from '../browser/routes.js';
import { json, profileSchema } from './shared.js';
import { savePage } from '../mirror/save.js';
import { t } from '../i18n.js';
import { clearStorage, exportState, getStorage, importState, listStates, setStorage } from '../browser/storage.js';

export function register(server) {
  server.registerTool(
    'browser_open',
    {
      title: t({ ru: 'Открыть браузер', en: "Open browser" }),
      description: t({
        ru: 'Создаёт сессию браузера с заданными условиями просмотра и, если передан url, сразу переходит на страницу. Возвращает sessionId для остальных инструментов.',
        en: "Creates a browser session with the given viewing conditions and, if a url is passed, navigates to it right away. Returns a sessionId used by every other session-based tool. Viewing conditions cover engine, viewport, dark mode, RTL, zoom, forced colors, DPR, locale and access (basic auth, headers, host mapping).",
      }),
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
      title: t({ ru: 'Перейти по адресу', en: "Navigate" }),
      description: t({
        ru: 'Переход в уже открытой сессии. Страница стабилизируется перед проверками: анимации останавливаются, шрифты догружаются — иначе снимки и замеры пляшут между прогонами. Если часть ресурсов не доехала, об этом сказано в warnings, а не оставлено выясняться по пустым рамкам на готовом кадре.',
        en: "Navigates in an already open session. The page is stabilized before checks run: animations are stopped and fonts are awaited, otherwise screenshots and measurements drift between runs. If some resources failed to load, that is reported in warnings rather than left to be discovered as empty boxes on a finished screenshot.",
      }),
      inputSchema: {
        sessionId: z.string(),
        url: z.string(),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
        save: z
          .boolean()
          .optional()
          .describe(d('Сохранить страницу в локальное зеркало сразу после перехода — дальше её можно разбирать, не трогая чужой сервер')),
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
      title: t({ ru: 'Действие на странице', en: "Act on the page" }),
      description: t({
        ru: 'Клик, ввод текста, нажатие клавиши, наведение, прокрутка, выбор в списке или ожидание селектора. Нужен, когда проверяемое состояние возникает только после действия: раскрытое меню, открытая вкладка, заполненная форма, страница после логина. Готовые селекторы удобно брать из page_snapshot.',
        en: "Click, type, press a key, hover, scroll, select an option or wait for a selector. Needed when the state you want to check only appears after an action: an expanded menu, an opened tab, a filled form, a page behind a login. Ready-to-use selectors come from page_snapshot.",
      }),
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['click', 'fill', 'press', 'hover', 'scroll', 'wait', 'select']),
        selector: z.string().optional(),
        value: z.string().optional().describe(d('Текст для fill, клавиша для press, значение для select')),
        x: z.number().optional().describe(d('Прокрутка по горизонтали')),
        y: z.number().optional().describe(d('Прокрутка по вертикали')),
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
      title: t({ ru: 'Выполнить JS на странице', en: "Run JS on the page" }),
      description: t({
        ru: 'Выполняет выражение или тело функции в контексте страницы и возвращает результат. Годится и IIFE, и цепочка через .map(function(){return …}), и несколько инструкций с return в конце. Если результат undefined, об этом сказано явно, а не возвращается пустой ответ.',
        en: "Evaluates an expression or a function body in the page context and returns the result. Accepts an IIFE, a chained .map(function(){return …}), or several statements ending with return. If the result is undefined that is stated explicitly instead of returning an empty answer.",
      }),
      inputSchema: { sessionId: z.string(), expression: z.string() },
    },
    async ({ sessionId, expression }) => json(await evaluateOnPage(getSession(sessionId).page, expression)),
  );

  server.registerTool(
    'browser_style',
    {
      title: t({ ru: 'Патч CSS/JS на страницу', en: "Patch CSS/JS onto the page" }),
      description: t({
        ru: 'Вкатывает свой CSS или JS поверх открытой страницы и переприменяет его после каждого перехода. Так проверяют правку на чужом или боевом стенде, ничего там не меняя: добавили правило — сняли скриншот — сравнили.',
        en: "Injects your own CSS or JS on top of the open page and reapplies it after every navigation. This is how you try a fix against someone else's or a production site without touching it: add a rule, take a screenshot, compare.",
      }),
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['add', 'remove', 'clear', 'list']).optional().describe(d('По умолчанию add')),
        css: z.string().optional().describe(d('Текст CSS')),
        js: z.string().optional().describe(d('Скрипт, выполняется при добавлении и после каждой навигации')),
        href: z.string().optional().describe(d('Подключить таблицу стилей по URL')),
        id: z.string().optional().describe(d('Метка патча: повторное добавление с тем же id заменяет прежний')),
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
      title: t({ ru: 'Перехват запросов', en: "Intercept requests" }),
      description: t({
        ru: 'Правила на сетевые запросы страницы: отрезать аналитику и чаты, подменить таблицу стилей или скрипт своей версией, подставить заглушки вместо отсутствующих картинок, переписать адреса — когда сайт отдаёт абсолютные ссылки на боевой домен. Переживает навигацию; в list виден счётчик попаданий, чтобы отличить несработавшее правило от сработавшего.',
        en: "Rules over the page network requests: cut off analytics and chat widgets that keep a page from reaching load, swap a stylesheet or script for your own build, stub missing images, rewrite addresses when a site serves absolute links to the production domain. Survives navigation; list shows a hit counter so a silent rule is distinguishable from a working one.",
      }),
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['add', 'list', 'clear']).optional().describe(d('По умолчанию add')),
        pattern: z.string().optional().describe(d('Glob (**/analytics/**) или регулярное выражение в виде /…/flags')),
        handler: z
          .enum(['block', 'fulfill', 'file', 'redirect', 'rewrite', 'passthrough'])
          .optional()
          .describe(
            d('block — оборвать, fulfill — отдать body, file — отдать файл стенда, redirect — увести все совпадения на один url, rewrite — заменить кусок адреса, сохранив путь'),
          ),
        body: z.string().optional(),
        contentType: z.string().optional(),
        status: z.number().optional(),
        url: z.string().optional().describe(d('Куда увести запрос при redirect')),
        file: z.string().optional().describe(d('Путь относительно рабочего каталога стенда')),
        from: z
          .string()
          .optional()
          .describe(
            d('Для rewrite: что заменить в адресе. Подстрока или регулярное выражение в виде /…/flags. Например /^https?:\\/\\/site\\.ru/'),
          ),
        to: z.string().optional().describe(d('Для rewrite: чем заменить. В регулярном выражении работают $1, $2')),
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
    {
      title: t({ ru: 'Список сессий', en: "List sessions" }),
      description: t({
        ru: 'Какие сессии браузера сейчас открыты, с их условиями просмотра и текущим адресом. Пригодится, когда идентификатор открытой ранее сессии потерялся. Рядом — recentlyClosed: недавно закрытые сессии с причиной и условиями, по которым открывают такую же взамен.',
        en: "Which browser sessions are open right now, with their viewing conditions and current URL. Useful when a session was opened earlier and its id got lost. Alongside them, recentlyClosed lists sessions that were closed, why, and the conditions to reopen an equivalent one.",
      }),
      inputSchema: {},
    },
    async () => json({ sessions: listSessions(), recentlyClosed: listEvicted() }),
  );

  server.registerTool(
    'browser_close',
    {
      title: t({ ru: 'Закрыть сессию', en: "Close session" }),
      description: t({
        ru: 'Закрывает сессию и освобождает память. Стоит вызывать, закончив работу со страницей: каждая сессия держит свой контекст браузера. Сами по себе они закрываются только по простою или по достижении потолка — на это лучше не рассчитывать.',
        en: "Closes a session and frees its memory. Worth calling once you are done with a page: each session holds its own browser context. They do close on their own once idle or when the cap is reached, but do not rely on that.",
      }),
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => json({ closed: await closeSession(sessionId) }),
  );

  server.registerTool(
    'browser_storage',
    {
      title: t({ ru: 'Куки и хранилища', en: "Cookies and storage" }),
      description: t({
        ru: 'Читает и подкладывает куки, localStorage и sessionStorage, а export и import сохраняют состояние сессии на диск и возвращают его в новую. Так логин переживает browser_close: сохранённое имя потом передаётся в storageState при открытии любой сессии. Важно: localStorage и sessionStorage снимаются с текущей страницы, а не со всего сайта — API уровня контекста у них нет.',
        en: "Reads and injects cookies, localStorage and sessionStorage; export and import save a session state to disk and restore it into a new session. That is how a login survives browser_close: pass the saved name as storageState when opening any session. Note: localStorage and sessionStorage are read from the current page, not from the whole site — Playwright has no context-level API for them.",
      }),
      inputSchema: {
        sessionId: z.string().optional().describe(d('Не нужен только для action: list')),
        action: z.enum(['get', 'set', 'clear', 'export', 'import', 'list']).optional().describe(d('По умолчанию get')),
        scope: z.enum(['cookies', 'local', 'session', 'all']).optional().describe(d('По умолчанию all')),
        name: z.string().optional().describe(d('Ключ для set в local и session; имя файла для export и import')),
        value: z.string().optional().describe(d('Значение для set. Для cookies — JSON: объект или массив куки')),
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
}
