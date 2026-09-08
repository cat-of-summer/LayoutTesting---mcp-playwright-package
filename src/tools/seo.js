/**
 * Инструменты: поля страницы и её сохранение в зеркало.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { readFile } from 'node:fs/promises';
import { createSession, closeSession, getSession, gotoAndSettle } from '../browser/pool.js';
import { json, profileCoreSchema } from './shared.js';
import { resolveConditions } from '../browser/profiles.js';
import { resolveInRoot } from '../paths.js';
import { seoFromHtml, seoFromPage } from '../seo/page.js';
import { t } from '../i18n.js';

export function register(server) {
  server.registerTool(
    'seo_page',
    {
      title: t({ ru: 'SEO-поля страницы', en: "SEO fields of a page" }),
      description: t({
        ru: 'Заголовок, описание, canonical, hreflang, robots, Open Graph, Twitter, дерево заголовков, инвентарь ссылок и картинок, микроразметка (JSON-LD, микроданные, RDFa). Отдельно считает indexable с перечислением причин, по которым страница не попадёт в индекс. Источник — открытая сессия, произвольный URL или сохранённый HTML: по сохранённому работает без единого сетевого запроса.',
        en: "Title, description, canonical, hreflang, robots directives, Open Graph, Twitter cards, the heading tree, an inventory of links and images, and structured data (JSON-LD, microdata, RDFa). Separately computes indexable with the reasons a page would stay out of the index. The source can be an open session, a URL, or a saved copy — against a saved copy it makes no network request at all.",
      }),
      inputSchema: {
        sessionId: z.string().optional().describe(d('Разобрать страницу открытой сессии — как она выглядит сейчас, после логина и раскрытых меню')),
        url: z.string().optional().describe(d('Открыть свою одноразовую сессию по адресу')),
        html: z.string().optional().describe(d('Разобрать переданную разметку без браузера')),
        file: z.string().optional().describe(d('Разобрать сохранённый файл: путь относительно рабочего каталога стенда')),
        pageUrl: z.string().optional().describe(d('Адрес, относительно которого разрешать ссылки в html или file. Без него относительные адреса и саморефренс canonical не посчитать')),
        ...profileCoreSchema,
      },
    },
    async ({ sessionId, url, html, file, pageUrl, ...conditions }) => {
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

      const session = await createSession(resolveConditions(conditions));
      try {
        const navigation = await gotoAndSettle(session, url);
        return json({ navigation, ...(await seoFromPage(session.page, session.lastResponse)) });
      } finally {
        await closeSession(session.id);
      }
    },
  );
}
