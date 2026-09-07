/**
 * Инструменты: валидатор разметки и линтер CSS.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { getSession } from '../browser/pool.js';
import { validateHtmlWithVnu, validateHtmlLocal, lintCss } from '../checks/static.js';
import { json, text } from './shared.js';
import { t } from '../i18n.js';

export function register(server) {
  server.registerTool(
    'validate_html',
    {
      title: t({ ru: 'Валидация HTML', en: "Validate HTML" }),
      description: t({
        ru: 'Проверяет разметку через Nu HTML Checker. Источник — открытая сессия, произвольный URL или переданный текст.',
        en: "Checks markup with the Nu HTML Checker (W3C validator): unclosed tags, duplicate ids, missing required attributes. The source can be an open session, an arbitrary URL or markup passed inline.",
      }),
      inputSchema: {
        sessionId: z.string().optional(),
        url: z.string().optional(),
        html: z.string().optional(),
      },
    },
    async ({ sessionId, url, html }) => {
      let source = html;
      if (!source && sessionId) source = await getSession(sessionId).page.content();
      if (!source && url) source = await (await fetch(url)).text();
      if (!source) throw new Error('Нужен sessionId, url или html.');
      try {
        return json({ source: 'vnu', ...(await validateHtmlWithVnu(source)) });
      } catch (err) {
        return json({ source: 'html-validate', fallbackReason: err.message, ...(await validateHtmlLocal(source)) });
      }
    },
  );

  server.registerTool(
    'lint_css',
    {
      title: t({ ru: 'Проверка CSS', en: "Check CSS" }),
      description: t({
        ru: 'Stylelint по CSS: файлам рабочего каталога стенда или переданному коду. Отвечает на вопрос «правильно ли написан стиль», а не «почему он не применился» — на второй отвечает matched_rules.',
        en: "Stylelint over CSS: files in the stand working directory, or code passed inline. Answers \"is this stylesheet written correctly\", not \"why is my rule not applied\" — the latter is matched_rules.",
      }),
      inputSchema: {
        files: z.array(z.string()).optional().describe(d('Пути относительно рабочего каталога, глоб поддерживается')),
        code: z.string().optional(),
        config: z.record(z.any()).optional(),
      },
    },
    async ({ files, code, config }) => json(await lintCss({ files, code, config })),
  );
}
