/**
 * Инструменты: сессии браузера, навигация, действия и перехват запросов.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { CONFIG, DIRS } from '../config.js';
import { siteRef } from '../artifacts.js';
import {
  createSession,
  closeSession,
  getSession,
  listEvicted,
  listSessions,
  gotoAndSettle,
  takeNavigationSince,
} from '../browser/pool.js';
import { profileKey } from '../browser/profile.js';
import { evaluateOnPage } from '../browser/evaluate.js';
import { resolveInRoot } from '../paths.js';
import { stat } from 'node:fs/promises';
import { addInjection, clearInjections, listInjections, removeInjection } from '../browser/inject.js';
import { addRoute, clearRoutes, listRecorded, listRoutes } from '../browser/routes.js';
import { cappedText, json, profileSchema } from './shared.js';
import { listProfiles, removeProfile, saveProfile } from '../browser/profiles.js';
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
        ru: 'Переход в уже открытой сессии. Страница стабилизируется перед проверками: анимации останавливаются, шрифты догружаются — иначе снимки и замеры пляшут между прогонами. Живое движение возвращает animations: "allow" — здесь на один переход, в browser_open на всю сессию. Если часть ресурсов не доехала, об этом сказано в warnings, а не оставлено выясняться по пустым рамкам на готовом кадре.',
        en: "Navigates in an already open session. The page is stabilized before checks run: animations are stopped and fonts are awaited, otherwise screenshots and measurements drift between runs. animations: \"allow\" brings the motion back — here for one navigation, in browser_open for the whole session. If some resources failed to load, that is reported in warnings rather than left to be discovered as empty boxes on a finished screenshot.",
      }),
      inputSchema: {
        sessionId: z.string(),
        url: z.string(),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
        animations: z
          .enum(['freeze', 'allow'])
          .optional()
          .describe(d('Разово, на этот переход: allow не глушит движение на странице')),
        save: z
          .boolean()
          .optional()
          .describe(d('Сохранить страницу в локальное зеркало сразу после перехода — дальше её можно разбирать, не трогая чужой сервер')),
      },
    },
    async ({ sessionId, url, waitUntil, animations, save }) => {
      const session = getSession(sessionId);
      const navigation = await gotoAndSettle(session, url, { waitUntil, animations });
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
        ru: 'Клик, ввод текста, нажатие клавиши, наведение, прокрутка, выбор в списке, ожидание селектора, выбор файлов и ответ на alert с confirm. Нужен, когда проверяемое состояние возникает только после действия: раскрытое меню, открытая вкладка, заполненная форма, страница после логина. Готовые селекторы удобно брать из page_snapshot.',
        en: "Click, type, press a key, hover, scroll, select an option, wait for a selector, pick files for upload or decide what to do with alert and confirm. Needed when the state you want to check only appears after an action: an expanded menu, an opened tab, a filled form, a page behind a login. Ready-to-use selectors come from page_snapshot.",
      }),
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['click', 'fill', 'press', 'hover', 'scroll', 'wait', 'select', 'upload', 'dialog']),
        selector: z.string().optional().describe(d('Не нужен для scroll, для dialog и для press с кликом по координатам')),
        value: z
          .string()
          .optional()
          .describe(d('Текст для fill, клавиша для press, значение для select, accept | dismiss | текст ответа для dialog')),
        files: z
          .array(z.string())
          .optional()
          .describe(d('Для upload: пути к файлам относительно рабочего каталога стенда')),
        x: z.number().optional().describe(d('Смещение прокрутки по горизонтали; для click без селектора — координата')),
        y: z.number().optional().describe(d('Смещение прокрутки по вертикали; для click без селектора — координата')),
        timeout: z.number().optional().describe(d('Сколько ждать элемент, мс. По умолчанию 30000')),
        force: z
          .boolean()
          .optional()
          .describe(d('Кликнуть, не дожидаясь кликабельности: элемент под pointer-events: none иначе ждёт весь таймаут')),
      },
    },
    async ({ sessionId, action, selector, value, files, x = 0, y = 0, timeout, force }) => {
      const session = getSession(sessionId);
      const { page } = session;
      const wait = timeout === undefined ? {} : { timeout };

      /*
       * Диалог — не действие над элементом, а настройка сессии: политика применяется к
       * следующему alert, confirm или prompt, в том числе на уже открытой странице. Текст
       * диалогов пишется в журнал всегда и читается через page_logs с kind: dialogs.
       */
      if (action === 'dialog') {
        const wanted = String(value ?? 'dismiss');
        session.dialogPolicy =
          wanted === 'dismiss'
            ? { action: 'dismiss', promptText: null }
            : { action: 'accept', promptText: wanted === 'accept' ? null : wanted };
        return json({ ok: true, action, dialogPolicy: session.dialogPolicy });
      }

      /*
       * Клавиша и клик по координатам обходятся без селектора: Escape закрывают на уровне
       * страницы, а по координатам кликают там, где подходящего узла в DOM просто нет.
       * Раньше press без селектора уходил в locator('undefined') и падал по таймауту через
       * полминуты — по такой ошибке не понять, что не так с вызовом.
       */
      if (!selector && action !== 'scroll') {
        if (action === 'press') {
          await page.keyboard.press(value ?? 'Enter');
          return done(session, { action, key: value ?? 'Enter' });
        }
        if (action === 'click') {
          if (!x && !y) throw new Error('Для click без selector нужны координаты x и y.');
          await page.mouse.click(x, y);
          return done(session, { action, at: { x, y } });
        }
        throw new Error(`Для действия ${action} нужен selector.`);
      }

      const target = selector ? page.locator(selector).first() : null;
      const pressed = { ...wait, ...(force ? { force: true } : {}) };

      switch (action) {
        case 'click': await target.click(pressed); break;
        case 'fill': await target.fill(value ?? '', wait); break;
        case 'press': await target.press(value ?? 'Enter', wait); break;
        case 'hover': await target.hover(pressed); break;
        case 'select': await target.selectOption(value ?? '', wait); break;
        case 'scroll': await page.evaluate(([sx, sy]) => window.scrollBy(sx, sy), [x, y]); break;
        case 'wait': await target.waitFor({ state: 'visible', ...wait }); break;
        case 'upload': return done(session, { action, selector, ...(await upload(page, target, files, wait, pressed)) });
        default: throw new Error(`Неизвестное действие: ${action}`);
      }
      return done(session, { action, selector });
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
    async ({ sessionId, expression }) => {
      const session = getSession(sessionId);
      const result = await evaluateOnPage(session.page, expression);
      /* Между вызовами страница могла перезагрузиться сама — тогда замер относится уже к
         другой странице, и знать об этом надо до того, как по нему сделан вывод. */
      const navigated = takeNavigationSince(session);
      if (navigated) result.navigatedSince = navigated;
      /*
       * Страница возвращает что угодно: document.body.innerHTML боевого сайта — это мегабайты
       * в одном ответе. Режем по сериализации, а не по самому значению: длина строки —
       * единственная мера, общая для массива, объекта и текста.
       */
      const serialized = JSON.stringify(result.value ?? null) ?? 'null';
      if (serialized.length <= CONFIG.maxTextBytes) return json(result);
      const part = cappedText(serialized, { max: CONFIG.maxTextBytes });
      return json({
        ...result,
        value: part.text,
        valueSerialized: true,
        chars: part.chars,
        truncated: true,
        note: 'Значение не поместилось и сериализовано с обрезкой. Сузьте выражение: верните нужные поля, а не узел целиком.',
      });
    },
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
        ru: "Правила на сетевые запросы страницы: отрезать аналитику и чаты, подменить таблицу стилей или скрипт своей версией, подставить заглушки вместо отсутствующих картинок, переписать адреса, когда сайт отдаёт абсолютные ссылки на боевой домен. С record правило ещё и записывает, что именно ушло на сервер, — читается через action: requests.",
        en: "Rules over the page network requests: cut analytics and chat widgets, replace a stylesheet or a script with your own version, stub missing images, rewrite addresses when the site returns absolute links to a production domain. With record a rule also captures what actually went to the server — read it back with action: requests.",
      }),
      inputSchema: {
        sessionId: z.string(),
        action: z
          .enum(['add', 'list', 'clear', 'requests'])
          .optional()
          .describe(d('По умолчанию add. requests — что записали правила с record')),
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
        record: z
          .boolean()
          .optional()
          .describe(d('Записывать совпавшие запросы: метод, адрес, заголовки и тело. У multipart — состав полей и имена файлов')),
        id: z.string().optional().describe(d('Для requests: показать записи только этого правила')),
        limit: z.number().optional().describe(d('Для requests: сколько последних записей показать. По умолчанию 20')),
      },
    },
    async ({ sessionId, action = 'add', id, limit, ...rest }) => {
      const session = getSession(sessionId);
      if (action === 'clear') return json({ cleared: await clearRoutes(session) });
      if (action === 'list') return json({ routes: listRoutes(session) });
      if (action === 'requests') return json({ recorded: listRecorded(session, { id, limit }) });
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
        ru: "Читает и подкладывает куки, localStorage и sessionStorage; export и import переносят состояние сессии через диск. Так логин переживает browser_close и перезапуск стенда.",
        en: "Reads and injects cookies, localStorage and sessionStorage; export and import carry a session state through disk. That is how a login survives browser_close and a stand restart.",
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

  server.registerTool(
    'browser_profile',
    {
      title: t({ ru: 'Профили условий просмотра', en: "Viewing condition profiles" }),
      description: t({
        ru: "Закрепляет условия открытой сессии под именем, чтобы задавать их одним словом: profile: \"mobile-dark\" в audit, screenshot, seo_page, web_vitals, page_save. Так редкие условия — zoom, RTL, троттлинг, hostMap, псевдолокализация — остаются доступны этим инструментам, не занимая места в их схеме.",
        en: "Pins the conditions of an open session under a name, so they can be given as one word: profile: \"mobile-dark\" in audit, screenshot, seo_page, web_vitals, page_save. That keeps rare conditions — zoom, RTL, throttling, hostMap, pseudo-localization — reachable from those tools without taking up room in their schema.",
      }),
      inputSchema: {
        action: z.enum(['save', 'list', 'remove']).optional().describe(d('По умолчанию list')),
        sessionId: z.string().optional().describe(d('Сессия, с которой снимаются условия — нужен для save')),
        name: z.string().optional().describe(d('Имя профиля — нужно для save и remove')),
        persist: z
          .boolean()
          .optional()
          .describe(d('Записать профиль на диск, чтобы он пережил перезапуск стенда. По умолчанию профиль живёт в памяти процесса')),
      },
    },
    async ({ action = 'list', sessionId, name, persist }) => {
      if (action === 'list') return json({ profiles: listProfiles() });
      if (!name) throw new Error(`Для action: ${action} нужно name.`);
      if (action === 'remove') return json({ removed: await removeProfile(name) });

      if (!sessionId) {
        throw new Error(
          'Для save нужен sessionId: профиль снимается с живой сессии, а не описывается заново. ' +
            'Откройте её через browser_open с нужными условиями.',
        );
      }
      /* session.reopen — те же условия, что передали в browser_open, уже без секретов:
         журнал закрытых сессий считает их для той же цели, и второй раз считать незачем. */
      const session = getSession(sessionId);
      return json(await saveProfile(name, session.reopen, { persist }));
    },
  );
}

/**
 * Ответ действия.
 *
 * Признак навигации приклеивается здесь, а не в каждой ветке: страница перезагружается сама —
 * live reload дев-сервера, редирект, meta refresh, — и без этого поля «модалка закрыта» после
 * клика неотличимо от «клик не сработал». Поле появляется, только если переход был.
 */
function done(session, payload) {
  const navigated = takeNavigationSince(session);
  return json({
    ok: true,
    ...payload,
    url: session.page.url(),
    ...(navigated ? { navigatedSince: navigated } : {}),
  });
}

/**
 * Выбор файлов.
 *
 * Два разных пути, и оба нужны. Скрытый input[type=file] за стилизованным label — самый
 * частый случай, и setInputFiles работает с ним прямо, не требуя видимости. Всё остальное —
 * кнопка, скрепка, зона перетаскивания — открывает системный диалог выбора, и его ловим
 * событием: без этого путь «клик по скрепке → выбор файла» проверить нечем.
 */
async function upload(page, target, files, wait, pressed) {
  if (!files || !files.length) {
    throw new Error('Для upload нужен files — пути к файлам относительно рабочего каталога стенда.');
  }

  const picked = [];
  for (const name of files) {
    const abs = resolveInRoot(name);
    const info = await stat(abs).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`Файла ${name} нет в рабочем каталоге стенда.`);
    picked.push({ path: name, abs, bytes: info.size });
  }
  const paths = picked.map((f) => f.abs);

  const isFileInput = await target
    .evaluate((el) => el instanceof HTMLInputElement && el.type === 'file')
    .catch(() => false);

  if (isFileInput) {
    await target.setInputFiles(paths, wait);
    return { via: 'input', files: picked.map(({ path, bytes }) => ({ path, bytes })) };
  }

  const [chooser] = await Promise.all([page.waitForEvent('filechooser', wait), target.click(pressed)]);
  await chooser.setFiles(paths);
  return { via: 'filechooser', files: picked.map(({ path, bytes }) => ({ path, bytes })) };
}

