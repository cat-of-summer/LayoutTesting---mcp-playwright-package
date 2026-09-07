/**
 * Инструменты: два независимых набора правил WCAG.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { getSession } from '../browser/pool.js';
import { runAxe, runPa11y } from '../checks/a11y.js';
import { json } from './shared.js';
import { t } from '../i18n.js';

export function register(server) {
  server.registerTool(
    'a11y_axe',
    {
      title: t({ ru: 'Проверка axe-core', en: "axe-core check" }),
      description: t({
        ru: 'Правила WCAG (axe-core) по открытой странице. Работает с текущим её состоянием, поэтому видит и то, что закрыто за логином, раскрытым меню или вкладкой, — в отличие от проверок по одному адресу. Второй набор правил в a11y_pa11y, находят они разное.',
        en: "WCAG rules (axe-core) against the open page. Works with its current state, so it also sees what is behind a login, an expanded menu or a tab — unlike checks that take a bare URL. The second rule set is a11y_pa11y; they find different things.",
      }),
      inputSchema: {
        sessionId: z.string(),
        tags: z.array(z.string()).optional().describe(d('Например wcag2aa, wcag21aa, best-practice')),
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
      title: t({ ru: 'Проверка pa11y', en: "pa11y check" }),
      description: t({
        ru: 'Второй набор правил доступности (HTML CodeSniffer), по URL. Наборы axe и pa11y пересекаются лишь частично, поэтому для настоящей проверки на WCAG нужны оба: что молча пропускает один, находит другой.',
        en: "A second accessibility rule set (HTML CodeSniffer), by URL. The axe and pa11y sets overlap only partly, so a real WCAG check needs both: what one silently passes, the other reports.",
      }),
      inputSchema: {
        url: z.string(),
        standard: z.enum(['WCAG2A', 'WCAG2AA', 'WCAG2AAA']).optional(),
      },
    },
    async ({ url, standard }) => json(await runPa11y(url, { standard })),
  );
}
