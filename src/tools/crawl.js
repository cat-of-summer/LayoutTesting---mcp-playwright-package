/**
 * Инструменты обхода сайта.
 *
 * Регистрации вынесены из server.js: тот и так на тысячу с лишним строк, и каждая новая группа
 * инструментов делает его хуже. Остальные группы переедут сюда же отдельной механической
 * правкой — она ничего не меняет по поведению и потому должна ехать отдельно от новой работы.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { json } from './shared.js';
import { t } from '../i18n.js';
import { crawlStatus, resumeCrawl, startCrawl, stopCrawl } from '../crawl/runner.js';
import { queryPages, querySelector } from '../crawl/query.js';
import { listSites, readIndex, removeSite, siteDir } from '../crawl/store.js';
import { parseSitemap, parseRobots, isAllowed } from '../crawl/robots.js';
import { normalizeUrl } from '../crawl/url.js';
import { auditSite, verdictOf } from '../seo/site.js';
import { renderSiteReport } from '../seo/render.js';
import { newRunId, siteRef, writeJson } from '../artifacts.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const filterSchema = z
  .object({
    status: z.number().optional().describe(d('Код ответа, например 404')),
    indexable: z.boolean().optional(),
    minDepth: z.number().optional(),
    maxDepth: z.number().optional(),
    rendered: z.boolean().optional().describe(d('true — только те, что пришлось открывать в браузере')),
    maxWords: z.number().optional().describe(d('Не больше стольких слов — так ищут тонкий контент')),
    missing: z
      .array(z.enum(['title', 'description', 'h1', 'canonical']))
      .optional()
      .describe(d('Страницы, где этих полей нет')),
  })
  .optional();

export function register(server) {
  server.registerTool(
    'crawl',
    {
      title: t({ ru: 'Обход сайта', en: "Crawl a site" }),
      description: t({
        ru: 'Обходит сайт по внутренним ссылкам и складывает страницы в локальный архив: сначала обычным HTTP-запросом (дёшево и видно то же, что видит робот без JS), а если ответ пустой — переоткрывает в браузере. Возвращает управление сразу, обход идёт фоном; смотреть прогресс через action: status. По умолчанию уважает robots.txt, держит паузу между запросами и не выходит за пределы хоста.',
        en: "Walks a site by its internal links and stores pages in a local archive: first with a plain HTTP request (cheap, and it shows exactly what a crawler without JS sees), then reopening a page in the browser if the response looks empty. Returns immediately, the crawl runs in the background; watch progress with action: status. By default it respects robots.txt, keeps a pause between requests and stays on the same host.",
      }),
      inputSchema: {
        action: z.enum(['start', 'status', 'stop', 'resume', 'list', 'delete']).optional().describe(d('По умолчанию start')),
        url: z.string().optional().describe(d('Откуда начинать. Нужен для start')),
        siteId: z.string().optional().describe(d('Имя обхода. По умолчанию из хоста')),
        maxPages: z.number().optional().describe(d('По умолчанию 500')),
        maxDepth: z.number().optional().describe(d('Глубина от стартовой страницы. По умолчанию 5')),
        delayMs: z.number().optional().describe(d('Пауза между запросами. По умолчанию 500')),
        render: z
          .enum(['auto', 'never', 'always'])
          .optional()
          .describe(d('auto (по умолчанию) поднимает браузер только для страниц, пустых без JS')),
        sameOrigin: z.boolean().optional().describe(d('true (по умолчанию) — только тот же хост; false пускает на поддомены')),
        include: z.string().optional().describe(d('Регулярное выражение: брать только совпавшие адреса')),
        exclude: z.string().optional().describe(d('Регулярное выражение: пропускать совпавшие адреса')),
        respectRobots: z
          .boolean()
          .optional()
          .describe(d('По умолчанию true. Отключать только для своих стендов — факт отключения попадёт в отчёт')),
        userAgent: z.string().optional(),
        storageState: z.string().optional().describe(d('Имя сохранённого логина из browser_storage — для закрытых разделов')),
        auth: z.string().optional().describe(d('HTTP basic auth «пользователь:пароль»')),
        extraHTTPHeaders: z.record(z.string()).optional(),
        assets: z.boolean().optional().describe(d('Тянуть ли ресурсы для зеркала. По умолчанию да')),
        scripts: z.enum(['strip', 'keep']).optional(),
      },
    },
    async ({ action = 'start', url, siteId, ...rest }) => {
      switch (action) {
        case 'list':
          return json({ sites: await listSites() });
        case 'status':
          if (!siteId) throw new Error('Нужен siteId.');
          return json(await crawlStatus(siteId));
        case 'stop':
          if (!siteId) throw new Error('Нужен siteId.');
          return json(await stopCrawl(siteId));
        case 'resume':
          if (!siteId) throw new Error('Нужен siteId.');
          return json(await resumeCrawl(siteId));
        case 'delete':
          if (!siteId) throw new Error('Нужен siteId.');
          return json({ removed: await removeSite(siteId) });
        default:
          if (!url) throw new Error('Для start нужен url.');
          return json(await startCrawl({ url, siteId, ...rest }));
      }
    },
  );

  server.registerTool(
    'crawl_pages',
    {
      title: t({ ru: 'Страницы обхода', en: "Pages of a crawl" }),
      description: t({
        ru: 'Выборка по сохранённым страницам: фильтр по коду ответа, глубине, индексируемости, отсутствующим полям и объёму текста; полнотекстовый поиск; группировка для поиска дублей заголовков и описаний. Возвращает список страниц с полями, но не разметку — за разметкой в read_artifact или crawl_query.',
        en: "Selects over stored pages: filter by status code, depth, indexability, missing fields and word count; full-text search; grouping to find duplicate titles and descriptions. Returns a list of pages with their fields, not their markup — for markup use read_artifact or crawl_query.",
      }),
      inputSchema: {
        siteId: z.string(),
        filter: filterSchema,
        text: z.string().optional().describe(d('Искать подстроку в видимом тексте сохранённых страниц')),
        groupBy: z
          .enum(['title', 'description', 'h1', 'canonical'])
          .optional()
          .describe(d('Сгруппировать и показать только группы больше одной страницы — то есть дубли')),
        fields: z.array(z.string()).optional().describe(d('Какие поля вернуть. Без них возвращаются все')),
        limit: z.number().optional().describe(d('По умолчанию 50')),
        offset: z.number().optional(),
      },
    },
    async ({ siteId, ...opts }) => json(await queryPages(siteId, opts)),
  );

  server.registerTool(
    'crawl_query',
    {
      title: t({ ru: 'Селектор по всему архиву', en: "Selector across the archive" }),
      description: t({
        ru: 'Применяет CSS-селектор к каждой сохранённой странице и возвращает найденные узлы с указанием страницы. Так отвечают на вопросы вида «где на сайте остались inline-стили», «на каких страницах нет разметки хлебных крошек», «где ссылки открываются в новой вкладке без rel=noopener». Ответ — список узлов, а не страниц: это другой вопрос, чем crawl_pages.',
        en: "Applies a CSS selector to every stored page and returns the matching nodes together with the page they came from. This answers questions like \"where are inline styles still used\", \"which pages have no breadcrumb markup\", \"where do links open in a new tab without rel=noopener\". The answer is a list of nodes, not of pages — a different question from crawl_pages.",
      }),
      inputSchema: {
        siteId: z.string(),
        select: z.string().describe(d('CSS-селектор')),
        attr: z.string().optional().describe(d('Какой атрибут снять с найденных узлов')),
        filter: filterSchema,
        limit: z.number().optional().describe(d('Сколько страниц показать подробно. По умолчанию 50')),
      },
    },
    async ({ siteId, ...opts }) => json(await querySelector(siteId, opts)),
  );

  server.registerTool(
    'site_files',
    {
      title: t({ ru: 'robots.txt и sitemap.xml', en: "robots.txt and sitemap.xml" }),
      description: t({
        ru: 'Забирает и разбирает robots.txt и sitemap.xml. Показывает правила для указанного агента, проверяет конкретные адреса на запрет и разворачивает индексные sitemap. Если указан siteId, дополнительно сверяет sitemap с обходом: чего нет в карте и что в карте есть, а на сайте не нашлось.',
        en: "Fetches and parses robots.txt and sitemap.xml. Shows the rules for a given user agent, checks specific addresses against them and expands sitemap index files. With a siteId it also reconciles the sitemap against a finished crawl: what is listed but was never found, and what was found but is missing from the map.",
      }),
      inputSchema: {
        url: z.string().describe(d('Любой адрес сайта — robots.txt и sitemap.xml берутся от его корня')),
        userAgent: z.string().optional().describe(d('Для какого агента показывать правила')),
        check: z.array(z.string()).optional().describe(d('Проверить эти адреса на запрет в robots.txt')),
        siteId: z.string().optional().describe(d('Сверить карту сайта с готовым обходом')),
      },
    },
    async ({ url, userAgent = 'LayoutTestingBot', check, siteId }) => {
      const origin = new URL(url).origin;
      const get = async (target) => {
        try {
          const res = await fetch(target, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(15000) });
          return res.ok ? await res.text() : null;
        } catch {
          return null;
        }
      };

      const robotsText = await get(`${origin}/robots.txt`);
      const robots = parseRobots(robotsText || '');
      const result = {
        origin,
        robots: {
          found: robotsText !== null,
          sitemaps: robots.sitemaps,
          rules: Object.fromEntries([...robots.groups].map(([agent, group]) => [agent, group])),
        },
      };

      if (check?.length) {
        result.robots.checked = check.map((target) => ({
          url: target,
          allowed: isAllowed(robots, userAgent, target),
        }));
      }

      /* Карта берётся из robots.txt, а если её там не объявили — по общепринятому адресу.
         Второе не гарантировано, поэтому в ответе видно, откуда она взялась. */
      const sitemapUrl = robots.sitemaps[0] || `${origin}/sitemap.xml`;
      const sitemapText = await get(sitemapUrl);
      if (sitemapText === null) {
        result.sitemap = { url: sitemapUrl, found: false, declaredInRobots: robots.sitemaps.length > 0 };
        return json(result);
      }

      const sitemap = await parseSitemap(sitemapText);
      result.sitemap = {
        url: sitemapUrl,
        found: true,
        declaredInRobots: robots.sitemaps.length > 0,
        isIndex: sitemap.isIndex,
        total: sitemap.total,
        sample: sitemap.entries.slice(0, 20),
      };

      if (siteId && !sitemap.isIndex) {
        const index = await readIndex(siteId);
        const crawled = new Set(Object.keys(index.pages));
        const listed = new Set(sitemap.entries.map((e) => normalizeUrl(e.loc)).filter(Boolean));

        result.comparison = {
          /* Расхождения в обе стороны — разные диагнозы. В карте, но не найдено обходом:
             страница либо сирота, либо карта устарела. Найдено, но не в карте: карту не обновили. */
          inSitemapNotCrawled: [...listed].filter((u) => !crawled.has(u)).slice(0, 100),
          crawledNotInSitemap: [...crawled].filter((u) => !listed.has(u)).slice(0, 100),
          sitemapTotal: listed.size,
          crawledTotal: crawled.size,
        };
      }

      return json(result);
    },
  );

  server.registerTool(
    'seo_report',
    {
      title: t({ ru: 'Сводный SEO-отчёт по сайту', en: "Site-wide SEO report" }),
      description: t({
        ru: 'Собирает по архиву обхода то, чего не видно на отдельной странице: дубли title, description, h1 и самого содержимого; битые внутренние ссылки с указанием, откуда на них ведут; страницы-сироты без единой входящей ссылки; цепочки редиректов; вопросы к canonical и взаимности hreflang; тонкое содержимое; смешанный контент. Адреса, объявленные в canonical и hreflang, но лежащие вне обхода, проверяются отдельными одиночными запросами — иначе про них нечего сказать. Отдельно сводит то, что НЕ проверялось: закрытое robots.txt, упёршееся в лимиты, неудачные запросы. Кладёт JSON и самодостаточный HTML.',
        en: "Collects from a crawl archive what is invisible on a single page: duplicate titles, descriptions, h1s and duplicate content; broken internal links with the pages that link to them; orphan pages with no inbound links at all; redirect chains; canonical and hreflang reciprocity problems; thin content; mixed content. Addresses declared in canonical and hreflang but lying outside the crawl are verified with separate one-off requests, otherwise there is nothing to say about them. Separately summarizes what was NOT checked: blocked by robots.txt, cut off by limits, failed requests. Writes JSON and a self-contained HTML report.",
      }),
      inputSchema: {
        siteId: z.string().describe(d('Обход, по которому строить отчёт. Список — crawl с action: list')),
        verify: z
          .boolean()
          .optional()
          .describe(d('Проверять ли одиночными запросами адреса вне обхода: canonical и hreflang наружу. По умолчанию да')),
        thinWords: z.number().optional().describe(d('Порог тонкого содержимого в словах, по умолчанию 200')),
      },
    },
    async ({ siteId, verify, thinWords }) => {
      const report = await auditSite(siteId, { verify, thinWords });
      const verdict = verdictOf(report);

      /* Отчёт лежит рядом с обходом, а не в артефактах: артефакты чистятся по счётчику прогонов,
         и отчёт по сайту исчез бы вместе с полусотней скриншотов. */
      const runId = newRunId('seo');
      const dir = path.join(siteDir(siteId), 'reports', runId);
      await fs.mkdir(dir, { recursive: true });
      const jsonFile = path.join(dir, 'seo.json');
      const htmlFile = path.join(dir, 'seo.html');
      await writeJson(jsonFile, { ...report, verdict });
      await fs.writeFile(htmlFile, renderSiteReport(report, verdict), 'utf8');

      return json({
        siteId,
        ...verdict,
        totals: report.totals,
        report: siteRef(htmlFile),
        json: siteRef(jsonFile),
        findings: report.findings,
      });
    },
  );
}
