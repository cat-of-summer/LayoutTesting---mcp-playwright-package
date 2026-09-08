/**
 * Инструменты: текстовый слепок страницы, её журналы и сохранение в локальное зеркало.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { siteRef } from '../artifacts.js';
import { createSession, closeSession, getSession, gotoAndSettle } from '../browser/pool.js';
import { pageSnapshot } from '../checks/snapshot.js';
import { CONFIG } from '../config.js';
import { cappedTail, json, profileSchema, text } from './shared.js';
import { savePage } from '../mirror/save.js';
import { t } from '../i18n.js';


/*
 * Одна console.log сериализованного стора весит мегабайты, и такая запись в ответе вытесняет
 * все остальные. Значение обрезаем, а не выбрасываем: по началу строки обычно и понятно,
 * что случилось.
 */
const clip = (value, max) =>
  typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value;

const clipEntry = (entry) => ({
  ...entry,
  ...(entry.text !== undefined ? { text: clip(entry.text, 500) } : {}),
  ...(entry.message !== undefined ? { message: clip(entry.message, 500) } : {}),
  ...(entry.url !== undefined ? { url: clip(entry.url, 200) } : {}),
  ...(entry.stack !== undefined ? { stack: clip(entry.stack, 1000) } : {}),
});
export function register(server) {
  server.registerTool(
    'page_snapshot',
    {
      title: t({ ru: 'Текстовый слепок страницы', en: "Text outline of the page" }),
      description: t({
        ru: 'Дерево ролей, имён и селекторов. Дешевле скриншота по объёму и содержит готовые селекторы для действий.',
        en: "A tree of roles, names and selectors. An order of magnitude cheaper than a screenshot and every line carries a ready-to-use selector, so this is the cheapest way to start looking at a page.",
      }),
      inputSchema: {
        sessionId: z.string(),
        maxNodes: z.number().optional(),
        interactiveOnly: z.boolean().optional().describe(d('Только ссылки, кнопки и поля')),
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
      title: t({ ru: 'Логи страницы', en: "Page logs" }),
      description: t({
        ru: 'Консоль, необработанные ошибки JS и неудачные сетевые запросы. По умолчанию — только с последнего перехода; sinceNavigation: false отдаёт всё с момента открытия сессии.',
        en: "Console output, unhandled JS errors and failed network requests. By default only since the last navigation; sinceNavigation: false returns everything since the session was opened.",
      }),
      inputSchema: {
        sessionId: z.string(),
        kind: z.enum(['all', 'console', 'errors', 'network']).optional(),
        onlyProblems: z.boolean().optional(),
        sinceNavigation: z
          .boolean()
          .optional()
          .describe(d('Только записи после последнего перехода. По умолчанию true')),
        limit: z
          .number()
          .optional()
          .describe(d('Сколько записей каждого вида показать; берутся последние. По умолчанию 100')),
      },
    },
    async ({ sessionId, kind = 'all', onlyProblems = true, sinceNavigation = true, limit }) => {
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

      /*
       * Буфер сессии держит до logBufferSize записей на каждый из трёх видов — три тысячи
       * объектов в одном ответе. Берём хвост по той же причине, по какой буфер и обрезается
       * с головы: свежая ошибка объясняет происходящее, первая из позапрошлой страницы — нет.
       */
      const cap = limit || CONFIG.maxLogEntries;
      const picked = kind === 'all' ? all : { [kind]: all[kind] };
      const shown = Object.fromEntries(
        Object.entries(picked).map(([name, list]) => [name, cappedTail(list.map(clipEntry), cap)]),
      );
      return json({ scope, ...shown });
    },

  );

  server.registerTool(
    'page_save',
    {
      title: t({ ru: 'Сохранить страницу локально', en: "Save the page locally" }),
      description: t({
        ru: 'Кладёт страницу в локальное зеркало: отрендеренный DOM с переписанными на локальные копии ссылками, отдельно сырой ответ сервера до JS, отдельно ресурсы с дедупликацией по содержимому. Копия открывается через browser_goto по internalUrl, и к ней применимы все остальные инструменты — layout_audit, screenshot, computed_styles. Дальше страницу можно разбирать сколько угодно, не обращаясь к чужому серверу.',
        en: "Puts the page into a local mirror: the rendered DOM with links rewritten to local copies, the raw server response before JS kept separately, and resources deduplicated by content. The copy opens through browser_goto by its internalUrl and every other tool applies to it — layout_audit, screenshot, computed_styles. After that the page can be examined as many times as needed without touching the remote server.",
      }),
      inputSchema: {
        sessionId: z.string().optional().describe(d('Сохранить текущую страницу сессии')),
        url: z.string().optional().describe(d('Открыть свою одноразовую сессию по адресу и сохранить её')),
        siteId: z.string().optional().describe(d('Имя каталога в архиве. По умолчанию берётся из хоста')),
        assets: z.boolean().optional().describe(d('Тянуть ли CSS, картинки и шрифты. По умолчанию да')),
        scripts: z
          .enum(['strip', 'keep'])
          .optional()
          .describe(d('strip (по умолчанию) вырезает скрипты: на копии аналитика стучит в сеть, а роутер SPA подменяет страницу. JSON-LD остаётся в любом случае')),
        raw: z.boolean().optional().describe(d('Сохранять ли сырой ответ сервера отдельным файлом. По умолчанию да')),
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
}
