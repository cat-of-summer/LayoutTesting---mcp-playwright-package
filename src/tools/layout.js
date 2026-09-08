/**
 * Инструменты: эвристики вёрстки и разбор конкретного элемента.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { getSession } from '../browser/pool.js';
import { layoutAudit, computedStyles, AUDIT_CATEGORIES } from '../checks/layout.js';
import { matchedRules } from '../checks/cssom.js';
import { elementLayers } from '../checks/layers.js';
import { json, text } from './shared.js';
import { t } from '../i18n.js';

export function register(server) {
  server.registerTool(
    'layout_audit',
    {
      title: t({ ru: 'Эвристики вёрстки', en: "Layout heuristics" }),
      description: t({
        ru: 'Ищет горизонтальный скролл, вылеты за viewport, наложения элементов, обрезанный текст, текст под непрозрачным слоем, мёртвый z-index (задан на position: static), битые картинки, картинки без размеров, мелкие тач-таргеты и низкий контраст.',
        en: "Finds horizontal scroll, elements past the viewport, overlapping content, clipped text, text under an opaque layer, dead z-index (set on position: static), broken images, images without dimensions, small tap targets and low contrast. The first thing to run when the complaint sounds like \"the layout is broken\".",
      }),
      inputSchema: {
        sessionId: z.string(),
        minTarget: z.number().optional().describe(d('Минимальный размер тач-таргета, px (по умолчанию 24)')),
        contrastRatio: z.number().optional().describe(d('Требуемый контраст обычного текста (по умолчанию 4.5)')),
        maxItems: z.number().optional().describe(d('Сколько примеров показывать в каждой категории (по умолчанию 50)')),
        categories: z
          .array(z.enum(AUDIT_CATEGORIES))
          .optional()
          .describe(d('Подробности только по этим категориям. Счётчики по всем возвращаются всегда')),
      },
    },
    async ({ sessionId, minTarget, contrastRatio, maxItems, categories }) =>
      json(await layoutAudit(getSession(sessionId).page, { minTarget, contrastRatio, maxItems, categories })),
  );

  server.registerTool(
    'computed_styles',
    {
      title: t({ ru: 'Вычисленные стили', en: "Computed styles" }),
      description: t({
        ru: 'Геометрия и итоговые CSS-свойства элемента — чтобы понять, почему блок не там, где ожидается. Умеет псевдоэлементы (::before, ::after) и разом все совпадения селектора.',
        en: "Geometry and final CSS properties of an element — to understand why a block is not where it is expected. Handles pseudo-elements (::before, ::after) and all matches of a selector at once.",
      }),
      inputSchema: {
        sessionId: z.string(),
        selector: z.string(),
        props: z.array(z.string()).optional(),
        pseudo: z
          .enum(['::before', '::after', '::marker', '::placeholder', '::selection', '::first-line', '::first-letter'])
          .optional()
          .describe(d('Смотреть псевдоэлемент, а не сам элемент')),
        all: z.boolean().optional().describe(d('Все совпадения селектора, а не только первое')),
        maxItems: z.number().optional(),
      },
    },
    async ({ sessionId, selector, props, pseudo, all, maxItems }) =>
      json(await computedStyles(getSession(sessionId).page, selector, props, { pseudo, all, maxItems })),
  );

  server.registerTool(
    'matched_rules',
    {
      title: t({ ru: 'Какое правило победило', en: "Which rule won" }),
      description: t({
        ru: "Какое CSS-правило победило и где оно объявлено: селектор, специфичность, файл и строка, а по каждому свойству — кто перебил кого. Отвечает на вопрос «почему моя правка не применилась», на который getComputedStyle не отвечает.",
        en: "Which CSS rule won and where it is declared: selector, specificity, file and line, and for each property who overrode whom. Answers the question \"why did my change not apply\", which getComputedStyle cannot answer.",
      }),
      inputSchema: {
        sessionId: z.string(),
        selector: z.string(),
        pseudo: z
          .enum(['::before', '::after', '::marker', '::placeholder', '::selection', '::first-line', '::first-letter'])
          .optional(),
        properties: z
          .array(z.string())
          .optional()
          .describe(d('Интересующие свойства, например ["z-index","position"]. Без них показываются только конфликты')),
        maxRules: z.number().optional(),
      },
    },
    async ({ sessionId, selector, pseudo, properties, maxRules }) =>
      json(await matchedRules(getSession(sessionId).page, { selector, pseudo, properties, maxRules })),
  );

  server.registerTool(
    'element_layers',
    {
      title: t({ ru: 'Слои и перекрытия', en: "Layers and overlaps" }),
      description: t({
        ru: "Почему элемента не видно и кто лежит сверху. Отдельно предупреждает про мёртвый z-index: заданный на position: static или посчитанный внутри чужого стек-контекста.",
        en: "Why an element is invisible and who lies on top of it. Warns separately about a dead z-index: set on position: static, or resolved inside somebody else stacking context.",
      }),
      inputSchema: {
        sessionId: z.string(),
        selector: z.string(),
        pseudo: z
          .enum(['::before', '::after', '::marker', '::placeholder'])
          .optional()
          .describe(d('Разбирать псевдоэлемент, а не сам элемент')),
        maxItems: z.number().optional(),
      },
    },
    async ({ sessionId, selector, pseudo, maxItems }) =>
      json(await elementLayers(getSession(sessionId).page, { selector, pseudo, maxItems })),
  );
}
