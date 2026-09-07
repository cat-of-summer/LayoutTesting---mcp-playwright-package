/**
 * Инструменты: снимки, сравнение страниц и эталоны.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import path from 'node:path';
import { DIRS, BROWSERS } from '../config.js';
import { newRunId, publicUrl, slug } from '../artifacts.js';
import { createSession, closeSession, getSession, gotoAndSettle, summarizeFailures } from '../browser/pool.js';
import { profileKey } from '../browser/profile.js';
import { takeScreenshot, compareWithBaseline, inlineImage, listBaselines } from '../checks/visual.js';
import { comparePages } from '../checks/compare.js';
import { compareLayout } from '../checks/compare-dom.js';
import { buildVisualGuide } from '../checks/guide.js';
import { json, text } from './shared.js';
import { t } from '../i18n.js';

export function register(server) {
  server.registerTool(
    'screenshot',
    {
      title: t({ ru: 'Скриншот', en: "Screenshot" }),
      description: t({
        ru: 'Снимок страницы или элемента. Возвращает путь и URL; картинку в ответ вкладывает только при inline=true. Снимок по selector — это область элемента: наехавшие на неё чужие блоки в кадр попадут. Если часть ресурсов страницы не загрузилась, в ответе будет warnings — снимок в этом случае неполный.',
        en: "A shot of the page or one element. Returns a path and a URL; the image itself is attached to the answer only with inline=true. A shot by selector is the element area: neighbours overlapping it will be in frame. If some resources failed to load, warnings say so — the shot is incomplete in that case.",
      }),
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional(),
        fullPage: z.boolean().optional(),
        selector: z.string().optional().describe(d('Снять только этот элемент')),
        mask: z.array(z.string()).optional().describe(d('Селекторы нестабильных зон — закрашиваются')),
        hide: z
          .array(z.string())
          .optional()
          .describe(d('Убрать с кадра: cookie-баннеры, чаты, всплывашки. Ставит visibility: hidden, layout не едет')),
        isolate: z
          .array(z.string())
          .optional()
          .describe(
            'Оставить в кадре только эти элементы, остальных соседей убрать из потока (display: none). Так снимают пару соседних блоков без остальных — например, чтобы показать наложение',
          ),
        format: z.enum(['png', 'jpeg', 'webp']).optional().describe(d('По умолчанию png')),
        quality: z.number().optional().describe(d('Качество jpeg и webp, 1–100 (по умолчанию 80)')),
        maxWidth: z.number().optional().describe(d('Уменьшить до этой ширины — для вставки в документы')),
        inline: z.boolean().optional().describe(d('Вложить уменьшенную картинку в ответ')),
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
      title: t({ ru: 'Сравнить две страницы', en: "Compare two live pages" }),
      description: t({
        ru: 'Сличает две живые страницы между собой на списке ширин: макет против собранной страницы. У каждой стороны свой HTTP-доступ и свои условия. Разная высота сравнению не мешает — кадры дополняются до общего холста, а разница высот отдаётся отдельным числом. Картинки в ответ не вкладываются: смотреть в артефактах.',
        en: "Compares two live pages pixel by pixel across a list of widths: a mockup against the built page. Each side has its own HTTP access and its own conditions. Different heights are not a problem — frames are padded to a common canvas and the height difference is returned separately.",
      }),
      inputSchema: {
        a: z
          .object({
            url: z.string(),
            auth: z.string().optional().describe(d('HTTP basic auth «пользователь:пароль»')),
            extraHTTPHeaders: z.record(z.string()).optional(),
            hostMap: z.record(z.string()).optional(),
            browser: z.enum(BROWSERS).optional(),
            colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
            waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
          })
          .describe(d('Что считаем образцом — обычно макет')),
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
          .describe(d('Что проверяем — обычно собранная страница')),
        viewports: z.array(z.string()).optional().describe(d('По умолчанию desktop')),
        name: z.string().optional(),
        selector: z.string().optional().describe(d('Сравнивать только этот блок')),
        fullPage: z.boolean().optional(),
        hide: z.array(z.string()).optional(),
        mask: z.array(z.string()).optional(),
        threshold: z.number().optional().describe(d('Допустимое расхождение в процентах пикселей')),
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
      title: t({ ru: 'Сравнить вёрстку двух страниц', en: "Compare layout of two pages" }),
      description: t({
        ru: 'Сличает макет и собранную страницу по DOM, а не по пикселям: какие классы есть только в одной из них и чем различаются одноимённые блоки — размер коробки, шрифт, отступы, сетка. Не зависит от контента, поэтому отвечает на вопрос «сошлась ли вёрстка» там, где попиксельное сравнение бесполезно из-за разных текстов и фотографий.',
        en: "Compares a mockup and a built page by DOM rather than by pixels: which classes exist in only one of them, and how same-named blocks differ in box size, font, spacing and grid. Independent of content, so it answers \"does the layout match\" where a pixel diff is useless because texts and photos differ.",
      }),
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
          .describe(d('Образец — обычно макет')),
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
          .describe(d('Проверяемая страница')),
        viewport: z.string().optional(),
        tolerance: z.number().optional().describe(d('Допуск по размеру в пикселях, по умолчанию 2')),
        props: z.array(z.string()).optional().describe(d('Какие CSS-свойства сверять')),
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
      title: t({ ru: 'Сравнить с эталоном', en: "Compare against a baseline" }),
      description: t({
        ru: 'Снимает страницу и сравнивает с эталоном. Если эталона нет, снимок становится эталоном и это сообщается явно. Формат и масштаб здесь не настраиваются намеренно: сравнение попиксельное, и любая перекодировка обесценила бы накопленные эталоны.',
        en: "Takes a screenshot and compares it with the stored baseline. If there is no baseline, the shot becomes one and that is stated explicitly. Format and scale are deliberately not configurable here: the comparison is pixel-exact and any re-encoding would devalue the baselines already collected.",
      }),
      inputSchema: {
        sessionId: z.string(),
        name: z.string().describe(d('Имя эталона')),
        fullPage: z.boolean().optional(),
        selector: z.string().optional(),
        mask: z.array(z.string()).optional(),
        hide: z.array(z.string()).optional().describe(d('Убрать с кадра: cookie-баннеры, чаты, всплывашки')),
        isolate: z
          .array(z.string())
          .optional()
          .describe(d('Оставить в кадре только эти элементы (display: none остальным соседям)')),
        threshold: z.number().optional().describe(d('Допустимое расхождение в процентах пикселей')),
        updateBaseline: z.boolean().optional().describe(d('Перезаписать эталон текущим снимком')),
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
      title: t({ ru: 'Визуальный справочник', en: "Visual reference document" }),
      description: t({
        ru: 'Собирает один самодостаточный HTML: перечисленные блоки страницы, снятые в нескольких ширинах, с подписями параметров. Документ для человека — контент-менеджеру показать, что даёт каждая комбинация настроек. Картинки вшиты в файл, его можно переслать одним вложением.',
        en: "Builds one self-contained HTML: the listed page blocks captured at several widths, with captions for their parameters. A document for humans — to show a content manager what each combination of settings produces. Images are embedded in the file, so it can be forwarded as a single attachment.",
      }),
      inputSchema: {
        url: z.string().describe(d('Страница, с которой снимать')),
        items: z
          .array(
            z.object({
              selector: z.string().describe(d('Блок, который снимаем')),
              title: z.string().optional().describe(d('Заголовок карточки')),
              params: z.record(z.string()).optional().describe(d('Подписи вида «Расположение: Горизонтальное»')),
              note: z.string().optional(),
              isolate: z
                .array(z.string())
                .optional()
                .describe(d('Оставить в кадре только это — например блок и его соседа, чтобы показать наложение')),
              hide: z.array(z.string()).optional(),
            }),
          )
          .describe(d('Варианты по порядку появления в документе')),
        title: z.string().optional(),
        intro: z.string().optional().describe(d('Абзац-введение под заголовком')),
        profiles: z
          .array(z.string())
          .optional()
          .describe(d('Ширины: имена пресетов или WxH. По умолчанию ["desktop","mobile"]')),
        auth: z.string().optional().describe(d('HTTP basic auth в виде "пользователь:пароль"')),
        browser: z.enum(BROWSERS).optional(),
        format: z.enum(['png', 'jpeg', 'webp']).optional().describe(d('Формат вшитых картинок, по умолчанию webp')),
        quality: z.number().optional(),
        maxWidth: z.number().optional().describe(d('Ширина вшитых картинок, по умолчанию 1000')),
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
    {
      title: t({ ru: 'Эталоны', en: "Baselines" }),
      description: t({
        ru: 'Сохранённые эталоны визуальной регрессии: для каких страниц и условий просмотра эталон уже есть. То есть где visual_compare найдёт с чем сравнивать, а где первый снимок сам станет эталоном.',
        en: "Stored visual regression baselines: which pages and viewing conditions already have one. That is, where visual_compare will have something to compare against, and where the first shot will itself become the baseline.",
      }),
      inputSchema: {},
    },
    async () => json({ dir: DIRS.baselines, baselines: await listBaselines(DIRS.baselines) }),
  );
}
