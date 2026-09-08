/**
 * Инструменты: web vitals и Lighthouse.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { newRunId } from '../artifacts.js';
import { createSession, closeSession, gotoAndSettle } from '../browser/pool.js';
import { profileKey } from '../browser/profile.js';
import { installVitalsCollector, readVitals, runLighthouse } from '../checks/perf.js';
import { json, profileCoreSchema } from './shared.js';
import { resolveConditions } from '../browser/profiles.js';
import { t } from '../i18n.js';

export function register(server) {
  server.registerTool(
    'web_vitals',
    {
      title: t({ ru: 'Web Vitals', en: "Web Vitals" }),
      description: t({
        ru: 'CLS, LCP, FCP, TTFB для указанного URL с перечислением элементов, сдвинувших layout. Ловит то, чего не видно на статичном скриншоте.',
        en: "CLS, LCP, FCP and TTFB for a URL, with the elements that shifted the layout listed. Catches what a static screenshot cannot show: content jumping while the page loads.",
      }),
      inputSchema: { url: z.string(), settleMs: z.number().optional(), ...profileCoreSchema },
    },
    async ({ url, settleMs, ...conditions }) => {
      const session = await createSession(resolveConditions(conditions));
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
      title: t({ ru: 'Отчёт Lighthouse', en: "Lighthouse report" }),
      description: t({
        ru: 'Полный прогон Lighthouse. Возвращает оценки, метрики и провалившиеся аудиты, HTML-отчёт кладёт в артефакты.',
        en: "A full Lighthouse run. Returns category scores (performance, accessibility, best practices, SEO), metrics and failing audits, and writes the HTML report into artifacts.",
      }),
      inputSchema: {
        url: z.string(),
        categories: z.array(z.enum(['performance', 'accessibility', 'best-practices', 'seo'])).optional(),
        preset: z.enum(['mobile', 'desktop']).optional(),
      },
    },
    async ({ url, categories, preset }) => json(await runLighthouse(url, { runId: newRunId('lighthouse'), categories, preset })),
  );
}
