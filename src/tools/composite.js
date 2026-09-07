/**
 * Инструменты: проверка страницы целиком, матрица условий, обход Storybook.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { CONFIG, BROWSERS } from '../config.js';
import { publicUrl } from '../artifacts.js';
import { profileKey } from '../browser/profile.js';
import { auditStorybook } from '../checks/storybook.js';
import { runAudit, ALL_CHECKS } from '../audit.js';
import { runMatrix, AXES } from '../matrix.js';
import { json, profileSchema } from './shared.js';
import { t } from '../i18n.js';

export function register(server) {
  server.registerTool(
    'audit',
    {
      title: t({ ru: 'Комплексная проверка страницы', en: 'Check a page' }),
      description: t({
        ru: `Комплексная проверка одной страницы: открывает URL под заданными условиями и разом гоняет выбранные проверки (${ALL_CHECKS.join(', ')} или all). Самый дешёвый первый шаг, когда вопрос звучит как «проверь страницу» или «что тут не так»: одним вызовом даёт сводку с вердиктом и складывает артефакты, а дальше уже видно, чем копать подробнее.`,
        en: `A composite check of one page: opens the URL under the given viewing conditions and runs the selected checks at once (${ALL_CHECKS.join(', ')} or all). The cheapest first step when the question sounds like "check this page" or "what is wrong here": one call returns a summary with a verdict and stores the artifacts, and from there it is clear what to dig into.`,
      }),
      inputSchema: {
        url: z.string(),
        checks: z.array(z.enum([...ALL_CHECKS, 'all'])).optional(),
        name: z.string().optional().describe(d('Имя прогона; используется в именах файлов и эталонов')),
        mask: z.array(z.string()).optional(),
        hide: z.array(z.string()).optional().describe(d('Убрать с кадра: cookie-баннеры, чаты, всплывашки')),
        fullPage: z.boolean().optional(),
        updateBaseline: z.boolean().optional(),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
          .optional()
          .describe(d('Чего ждать при переходе. Для тяжёлых боевых сайтов — domcontentloaded')),
        timeout: z.number().optional().describe(d('Таймаут навигации, мс')),
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
      title: t({ ru: 'Матрица условий', en: "Condition matrix" }),
      description: t({
        ru: 'Прогоняет страницу по декартову произведению осей (браузеры × viewport × тема × RTL × zoom × forced-colors × псевдолокализация × DPR) и собирает сводный HTML-отчёт.',
        en: "Runs a page across the cartesian product of axes (browsers x viewport x color scheme x RTL x zoom x forced-colors x pseudo-localization x DPR) and assembles a single HTML report. This is how you check a page against every viewing condition at once instead of one by one.",
      }),
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
        concurrency: z.number().optional().describe(d('Сколько комбинаций гнать параллельно (по умолчанию 2)')),
        updateBaseline: z.boolean().optional(),
        mask: z.array(z.string()).optional(),
        hide: z.array(z.string()).optional().describe(d('Убрать с кадра: cookie-баннеры, чаты, всплывашки')),
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
      title: t({ ru: 'Обход Storybook', en: "Walk through Storybook" }),
      description: t({
        ru: 'Обходит все истории Storybook: для каждой снимает скриншот и гоняет эвристики вёрстки и axe. Так проверяют библиотеку компонентов целиком, не открывая истории руками. Отбор историй — регулярным выражением по id и заголовку.',
        en: "Walks every Storybook story, taking a screenshot of each and running layout heuristics and axe. This is how you check a component library as a whole instead of opening stories by hand. Stories are filtered by a regular expression over id and title.",
      }),
      inputSchema: {
        storybookUrl: z.string().describe(d('Например http://node_myapp:6006')),
        include: z.string().optional().describe(d('Регулярное выражение по id и заголовку истории')),
        limit: z.number().optional(),
        visual: z.boolean().optional().describe(d('Сравнивать каждую историю с эталоном')),
        ...profileSchema,
      },
    },
    async ({ storybookUrl, include, limit, visual, ...profile }) =>
      json(await auditStorybook({ storybookUrl, include, limit, visual, profile })),
  );
}
