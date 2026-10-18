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
import { lintLiveCss } from '../checks/css-live.js';
import { getRestClient } from '../figma/rest.js';
import { editorChannel } from '../figma/editor.js';
import { ensureNodes } from '../figma/snapshot.js';
import { groupRefs } from '../figma/url.js';
import { collectTokens, statePalette } from '../figma/analyze/tokens.js';

/** Палитра состояний макета по ссылкам: цвета вариантов hover, active, selected. */
async function paletteOf(refs) {
  const client = getRestClient();
  const frames = [];
  for (const group of groupRefs(refs)) {
    const { found } = await ensureNodes(group.fileKey, group.nodeIds, { client, editor: editorChannel });
    for (const id of group.nodeIds) frames.push({ snapshot: found.get(id).snapshot, rootId: id, ref: `${group.fileKey}:${id}` });
  }
  return statePalette(collectTokens(frames, { minUses: 1 }).colors);
}

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
        strict: z.boolean().optional().describe(d('Показать и то, чего валидатор не знает: современный CSS и новые атрибуты платформы')),
        ignore: z
          .array(z.string())
          .optional()
          .describe(d('Регулярные выражения по тексту сообщений — соглашения проекта; отфильтрованное считается отдельно в ignored')),
      },
    },
    async ({ sessionId, url, html, strict, ignore }) => {
      let source = html;
      if (!source && sessionId) source = await getSession(sessionId).page.content();
      if (!source && url) source = await (await fetch(url)).text();
      if (!source) throw new Error('Нужен sessionId, url или html.');
      try {
        return json({ source: 'vnu', ...(await validateHtmlWithVnu(source, { strict, ignore: ignore?.length ? { messages: ignore } : null })) });
      } catch (err) {
        /* У запасного пути разделения нет — говорим об этом, а не делаем вид, что strict сработал. */
        return json({
          source: 'html-validate',
          fallbackReason: err.message,
          ...(await validateHtmlLocal(source, { ignore: ignore?.length ? { messages: ignore } : null })),
          ...(strict ? { strictNote: 'Запасной путь html-validate делит сообщения иначе: у него нет разделения на известные ограничения, и strict здесь ничего не меняет.' } : {}),
        });
      }
    },
  );

  server.registerTool(
    'lint_css',
    {
      title: t({ ru: 'Проверка CSS', en: "Check CSS" }),
      description: t({
        ru: 'Stylelint по CSS: файлам рабочего каталога стенда или переданному коду. С sessionId — все таблицы открытой страницы вместе с библиотечными: переменные, которые никто не читает, переменные состояний библиотеки, оставшиеся по умолчанию, а с figma — цвета :hover и .is-active вне палитры состояний макета.',
        en: "Stylelint over CSS: files in the stand working directory, or code passed inline. With sessionId — every stylesheet of the open page, library ones included: custom properties nobody reads, library state variables left at their defaults, and with figma — :hover and .is-active colors outside the design's state palette.",
      }),
      inputSchema: {
        files: z.array(z.string()).optional().describe(d('Пути относительно рабочего каталога, глоб поддерживается')),
        code: z.string().optional(),
        config: z.record(z.any()).optional(),
        sessionId: z.string().optional().describe(d('Проверить CSS открытой страницы: переменные и цвета состояний')),
        figma: z.array(z.string()).optional().describe(d('С sessionId: кадры UI-кита и страницы — палитра состояний макета для цветов :hover')),
      },
    },
    async ({ files, code, config, sessionId, figma }) => {
      if (sessionId) {
        const palette = figma?.length ? await paletteOf(figma) : null;
        return json(await lintLiveCss(getSession(sessionId).page, { palette }));
      }
      return json(await lintCss({ files, code, config }));
    },
  );
}
