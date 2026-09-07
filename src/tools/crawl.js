/**
 * Инструменты обхода сайта.
 *
 * Регистрации вынесены из server.js: тот и так на тысячу с лишним строк, и каждая новая группа
 * инструментов делает его хуже. Остальные группы переедут сюда же отдельной механической
 * правкой — она ничего не меняет по поведению и потому должна ехать отдельно от новой работы.
 */
import { z } from 'zod';
import { json } from './shared.js';
import { crawlStatus, resumeCrawl, startCrawl, stopCrawl } from '../crawl/runner.js';
import { queryPages, querySelector } from '../crawl/query.js';
import { listSites, readIndex, removeSite } from '../crawl/store.js';
import { parseSitemap, parseRobots, isAllowed } from '../crawl/robots.js';
import { normalizeUrl } from '../crawl/url.js';

const filterSchema = z
  .object({
    status: z.number().optional().describe('Код ответа, например 404'),
    indexable: z.boolean().optional(),
    minDepth: z.number().optional(),
    maxDepth: z.number().optional(),
    rendered: z.boolean().optional().describe('true — только те, что пришлось открывать в браузере'),
    maxWords: z.number().optional().describe('Не больше стольких слов — так ищут тонкий контент'),
    missing: z
      .array(z.enum(['title', 'description', 'h1', 'canonical']))
      .optional()
      .describe('Страницы, где этих полей нет'),
  })
  .optional();

export function register(server) {
  server.registerTool(
    'crawl',
    {
      title: 'Обход сайта',
      description:
        'Обходит сайт по внутренним ссылкам и складывает страницы в локальный архив: сначала обычным HTTP-запросом (дёшево и видно то же, что видит робот без JS), а если ответ пустой — переоткрывает в браузере. Возвращает управление сразу, обход идёт фоном; смотреть прогресс через action: status. По умолчанию уважает robots.txt, держит паузу между запросами и не выходит за пределы хоста.',
      inputSchema: {
        action: z.enum(['start', 'status', 'stop', 'resume', 'list', 'delete']).optional().describe('По умолчанию start'),
        url: z.string().optional().describe('Откуда начинать. Нужен для start'),
        siteId: z.string().optional().describe('Имя обхода. По умолчанию из хоста'),
        maxPages: z.number().optional().describe('По умолчанию 500'),
        maxDepth: z.number().optional().describe('Глубина от стартовой страницы. По умолчанию 5'),
        delayMs: z.number().optional().describe('Пауза между запросами. По умолчанию 500'),
        render: z
          .enum(['auto', 'never', 'always'])
          .optional()
          .describe('auto (по умолчанию) поднимает браузер только для страниц, пустых без JS'),
        sameOrigin: z.boolean().optional().describe('true (по умолчанию) — только тот же хост; false пускает на поддомены'),
        include: z.string().optional().describe('Регулярное выражение: брать только совпавшие адреса'),
        exclude: z.string().optional().describe('Регулярное выражение: пропускать совпавшие адреса'),
        respectRobots: z
          .boolean()
          .optional()
          .describe('По умолчанию true. Отключать только для своих стендов — факт отключения попадёт в отчёт'),
        userAgent: z.string().optional(),
        storageState: z.string().optional().describe('Имя сохранённого логина из browser_storage — для закрытых разделов'),
        auth: z.string().optional().describe('HTTP basic auth «пользователь:пароль»'),
        extraHTTPHeaders: z.record(z.string()).optional(),
        assets: z.boolean().optional().describe('Тянуть ли ресурсы для зеркала. По умолчанию да'),
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
      title: 'Страницы обхода',
      description:
        'Выборка по сохранённым страницам: фильтр по коду ответа, глубине, индексируемости, отсутствующим полям и объёму текста; полнотекстовый поиск; группировка для поиска дублей заголовков и описаний. Возвращает список страниц с полями, но не разметку — за разметкой в read_artifact или crawl_query.',
      inputSchema: {
        siteId: z.string(),
        filter: filterSchema,
        text: z.string().optional().describe('Искать подстроку в видимом тексте сохранённых страниц'),
        groupBy: z
          .enum(['title', 'description', 'h1', 'canonical'])
          .optional()
          .describe('Сгруппировать и показать только группы больше одной страницы — то есть дубли'),
        fields: z.array(z.string()).optional().describe('Какие поля вернуть. Без них возвращаются все'),
        limit: z.number().optional().describe('По умолчанию 50'),
        offset: z.number().optional(),
      },
    },
    async ({ siteId, ...opts }) => json(await queryPages(siteId, opts)),
  );

  server.registerTool(
    'crawl_query',
    {
      title: 'Селектор по всему архиву',
      description:
        'Применяет CSS-селектор к каждой сохранённой странице и возвращает найденные узлы с указанием страницы. Так отвечают на вопросы вида «где на сайте остались inline-стили», «на каких страницах нет разметки хлебных крошек», «где ссылки открываются в новой вкладке без rel=noopener». Ответ — список узлов, а не страниц: это другой вопрос, чем crawl_pages.',
      inputSchema: {
        siteId: z.string(),
        select: z.string().describe('CSS-селектор'),
        attr: z.string().optional().describe('Какой атрибут снять с найденных узлов'),
        filter: filterSchema,
        limit: z.number().optional().describe('Сколько страниц показать подробно. По умолчанию 50'),
      },
    },
    async ({ siteId, ...opts }) => json(await querySelector(siteId, opts)),
  );

  server.registerTool(
    'site_files',
    {
      title: 'robots.txt и sitemap.xml',
      description:
        'Забирает и разбирает robots.txt и sitemap.xml. Показывает правила для указанного агента, проверяет конкретные адреса на запрет и разворачивает индексные sitemap. Если указан siteId, дополнительно сверяет sitemap с обходом: чего нет в карте и что в карте есть, а на сайте не нашлось.',
      inputSchema: {
        url: z.string().describe('Любой адрес сайта — robots.txt и sitemap.xml берутся от его корня'),
        userAgent: z.string().optional().describe('Для какого агента показывать правила'),
        check: z.array(z.string()).optional().describe('Проверить эти адреса на запрет в robots.txt'),
        siteId: z.string().optional().describe('Сверить карту сайта с готовым обходом'),
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
}
