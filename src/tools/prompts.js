/**
 * Готовые сценарии.
 *
 * Промпты ничего не стоят в манифесте: клиент перечисляет их отдельным запросом и подтягивает
 * тело только когда человек выбрал. Поэтому здесь уместно то, чему не место в описаниях —
 * порядок шагов целиком, со всеми оговорками.
 *
 * Сценарии, а не инструменты: человек выбирает «разобрать поехавшую вёрстку», и дальше агент
 * знает, с чего начать и чем продолжить. До сих пор этот порядок жил только в instructions
 * общим списком «симптом — первый инструмент», а что делать после первого шага, приходилось
 * додумывать каждый раз заново.
 */
import { z } from 'zod';
import { t } from '../i18n.js';

const say = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

export function register(server) {
  server.registerPrompt(
    'layout-broken',
    {
      title: t({ ru: 'Разобрать поехавшую вёрстку', en: 'Investigate broken layout' }),
      description: t({
        ru: 'Порядок разбора: от общей картины к конкретному элементу, от дешёвого шага к дорогому.',
        en: 'The order of investigation: from the whole page to one element, from cheap steps to expensive ones.',
      }),
      argsSchema: {
        url: z.string().describe(t({ ru: 'Адрес страницы', en: 'Page address' })),
        symptom: z
          .string()
          .optional()
          .describe(t({ ru: 'Что именно не так, словами человека', en: 'What is wrong, in the words of the person asking' })),
        viewport: z
          .string()
          .optional()
          .describe(t({ ru: 'Ширина: имя пресета или WxH', en: 'Width: a preset name or WxH' })),
      },
    },
    ({ url, symptom, viewport }) =>
      say(
        t({
          ru: `Разбери вёрстку страницы ${url}${viewport ? ` в ширине ${viewport}` : ''}.${symptom ? `
Симптом: ${symptom}` : ''}

Порядок:
1. browser_open${viewport ? ` с viewport: "${viewport}"` : ''} и переход на страницу.
2. layout_audit по этой сессии — он вернёт находки готовыми селекторами. Скриншот пока не нужен.
3. Нужно понять устройство страницы — page_snapshot: он на порядок дешевле снимка.
4. По конкретному элементу: element_layers, если его не видно или он чем-то накрыт; matched_rules, если применилось не то правило; computed_styles, если нужны итоговые значения.
5. Снимок в конце и только если вопрос действительно про внешний вид: screenshot с inline: true.
6. browser_close, когда закончишь.

Не пересказывай вывод инструментов целиком — назови причину и то, что именно её вызывает.`,
          en: `Investigate the layout of ${url}${viewport ? ` at width ${viewport}` : ''}.${symptom ? `
Symptom: ${symptom}` : ''}

The order:
1. browser_open${viewport ? ` with viewport: "${viewport}"` : ''} and navigate to the page.
2. layout_audit on that session — it returns findings as ready-to-use selectors. No screenshot yet.
3. If you need the structure of the page, use page_snapshot: it costs an order of magnitude less than a shot.
4. For one element: element_layers when it is invisible or covered, matched_rules when the wrong rule applied, computed_styles when you need the resulting values.
5. A screenshot last, and only if the question is really about appearance: screenshot with inline: true.
6. browser_close when you are done.

Do not retell the tool output in full — name the cause and what exactly produces it.`,
        }),
      ),
  );

  server.registerPrompt(
    'visual-regression',
    {
      title: t({ ru: 'Визуальная регрессия', en: 'Visual regression' }),
      description: t({
        ru: 'Сравнить страницу с эталоном, заранее убрав то, что меняется само по себе.',
        en: 'Compare a page against its baseline, having first removed everything that changes on its own.',
      }),
      argsSchema: {
        url: z.string().describe(t({ ru: 'Адрес страницы', en: 'Page address' })),
        name: z.string().describe(t({ ru: 'Имя эталона', en: 'Baseline name' })),
      },
    },
    ({ url, name }) =>
      say(
        t({
          ru: `Сравни ${url} с эталоном «${name}».

1. visual_baselines — посмотри, есть ли уже эталон с таким именем и под какие условия просмотра.
2. Убери динамику заранее, иначе расхождение будет ложным: hide для баннеров, чатов и всплывашек; mask для областей с меняющимся содержимым; freezeTime для дат и случайных чисел.
3. visual_compare с name: "${name}". Если эталона нет, первый прогон сам его заведёт — скажи об этом прямо, а не выдавай за успешное сравнение.
4. Есть расхождение — покажи diff и объясни, что именно разъехалось. Расхождение в пределах порога находкой не считается.`,
          en: `Compare ${url} against the baseline "${name}".

1. visual_baselines — check whether a baseline with that name already exists and under which viewing conditions.
2. Remove the moving parts first, otherwise the diff is false: hide for banners, chat widgets and popups; mask for regions with changing content; freezeTime for dates and random numbers.
3. visual_compare with name: "${name}". If there is no baseline, the first run creates one — say so plainly instead of presenting it as a successful comparison.
4. If there is a difference, show the diff and explain what actually moved. A difference within the threshold is not a finding.`,
        }),
      ),
  );

  server.registerPrompt(
    'seo-site',
    {
      title: t({ ru: 'SEO по сайту целиком', en: 'Site-wide SEO' }),
      description: t({
        ru: 'Обойти сайт и собрать то, чего не видно на отдельной странице.',
        en: 'Crawl a site and collect what is invisible on a single page.',
      }),
      argsSchema: {
        url: z.string().describe(t({ ru: 'Адрес сайта', en: 'Site address' })),
        maxPages: z.string().optional().describe(t({ ru: 'Предел числа страниц', en: 'Page limit' })),
      },
    },
    ({ url, maxPages }) =>
      say(
        t({
          ru: `Собери SEO-картину по сайту ${url}.

1. site_files — robots.txt и карта сайта: сразу видно, что закрыто от обхода и что сайт сам про себя заявляет.
2. crawl${maxPages ? ` с maxPages: ${maxPages}` : ''}. Он возвращает управление сразу — следи через action: status, не жди молча.
3. Когда обход закончится — seo_report по архиву. Читай его вместе с counts: в findings лежат только примеры, а пятьдесят битых ссылок и пять тысяч требуют разных решений.
4. Обязательно посмотри раздел про то, что НЕ проверялось. Закрытое robots.txt — находка; упёршийся лимит — повод перезапустить обход шире; неудачные запросы — возможная поломка сайта. Смешивать их нельзя.
5. Точечные вопросы по всем страницам — crawl_query с нужным селектором.`,
          en: `Build the SEO picture of ${url}.

1. site_files — robots.txt and the sitemap: it immediately shows what is closed to crawling and what the site claims about itself.
2. crawl${maxPages ? ` with maxPages: ${maxPages}` : ''}. It returns control immediately — follow action: status instead of waiting silently.
3. When the crawl finishes, run seo_report over the archive. Read it together with counts: findings holds only examples, and fifty broken links and five thousand call for different decisions.
4. Always look at the section on what was NOT checked. Blocked by robots.txt is a finding; hitting a limit is a reason to re-run wider; failed requests may be a broken site. These must not be mixed.
5. For specific questions across all pages, use crawl_query with the selector you need.`,
        }),
      ),
  );

  server.registerPrompt(
    'figma-layout',
    {
      title: t({ ru: 'Свёрстать по макету Figma', en: 'Build markup from a Figma design' }),
      description: t({
        ru: 'Порядок работы по макету: один снимок, разбор по снимку, вёрстка, проверка сравнением и контентом.',
        en: 'How to work from a design: one snapshot, analysis over it, markup, then checks by comparison and by content.',
      }),
      argsSchema: {
        figma: z.string().describe(t({ ru: 'Ссылки на кадры через запятую: десктоп, мобильная, модалки', en: 'Frame links separated by commas: desktop, mobile, modals' })),
        projectUrl: z
          .string()
          .optional()
          .describe(t({ ru: 'Адрес страницы проекта для сверки токенов и классов', en: 'Project page address to compare tokens and classes against' })),
        pageUrl: z
          .string()
          .optional()
          .describe(t({ ru: 'Адрес страницы, которую верстаем', en: 'Address of the page being built' })),
      },
    },
    ({ figma, projectUrl, pageUrl }) =>
      say(
        t({
          ru: `Свёрстай страницу по макету: ${figma}.

Правило одно: макет снимается один раз, дальше разбор идёт по снимку. Лимит REST — десять запросов в минуту, у места View/Collab двадцать в месяц.

1. figma_status — проверь доступ и остаток лимита. needs_human означает капчу, письмо или код: спроси код у человека, остальное он проходит сам.
2. figma_sync со ВСЕМИ кадрами задачи одним вызовом. Дальше figma_* читают снимок.
3. figma_structure по каждому экрану. Это план разметки: теги, классы, раскладка. Читай notes — там сказано, где слои в макете перепутаны и что стало фоном, декором и наложением.
4. figma_breakpoints по кадрам одного экрана: что меняется с шириной, что исчезает, чем заменено, где расходится порядок чтения. clamp() для линейных значений уже посчитан.
5. figma_components${projectUrl ? ` с project: { url: "${projectUrl}" }` : ''} — сколько на самом деле блоков и какие у них модификаторы. drift — это расхождения в макете, а не варианты: сведи их к одному значению. Совпадения с классами проекта значат, что верстать заново не надо.
6. figma_tokens${projectUrl ? ` с тем же project` : ''} — палитра, типографика, шкалы. unbound показывает, сколько раз значение вбито литералом при живой переменной Figma. Компонентные переменные — в разделе component.
7. figma_comments и figma_behavior — требования и связи: что открывает модалку, что переключает состояние, что закреплено при прокрутке. Неподтверждённое (unconfirmed) уточни у человека, а не додумывай.
8. figma_export — иконки (svg, currentColor) и растровые заливки, кадрированные как в макете. Сначала проверь, нет ли их уже в проекте.
9. Верстай: порядок DOM = порядок чтения самой узкой вёрстки, перестановки — CSS, декор — псевдоэлементами, значения — токенами.
10. Проверь: figma_compare${pageUrl ? ` с url: "${pageUrl}"` : ''} по каждому брейкпоинту, затем layout_stress — длинный и пустой текст, список из двенадцати, битая картинка, набор ширин. Расхождение ≤1px и различия рендеринга шрифтов дефектом не считаются.`,
          en: `Build the page from the design: ${figma}.

One rule: the design is pulled once, and all analysis runs over that snapshot. The REST limit is ten requests a minute, and twenty a month on a View/Collab seat.

1. figma_status — check access and the remaining budget. needs_human means a captcha, an email or a code: ask the human for the code, the rest they go through themselves.
2. figma_sync with ALL frames of the task in one call. After that figma_* read the snapshot.
3. figma_structure for each screen. It is the markup plan: tags, classes, layout. Read notes — they say where the layers are shuffled and what became a background, a decoration or an overlay.
4. figma_breakpoints across frames of one screen: what changes with width, what disappears, what replaced it, where the reading order diverges. clamp() for linear values is already computed.
5. figma_components${projectUrl ? ` with project: { url: "${projectUrl}" }` : ''} — how many blocks there really are and what modifiers they have. drift is a discrepancy in the design, not a variant: normalize it. Matches with project classes mean there is nothing to build again.
6. figma_tokens${projectUrl ? ' with the same project' : ''} — palette, typography, scales. unbound shows how often a value is hardcoded while a Figma variable exists. Component variables are in the component section.
7. figma_comments and figma_behavior — requirements and links: what opens a modal, what switches a state, what stays pinned while scrolling. Anything marked unconfirmed goes to the human, not to guesswork.
8. figma_export — icons (svg, currentColor) and raster fills cropped as in the design. First check whether the project already has them.
9. Build: DOM order = reading order of the narrowest layout, reordering in CSS, decorations as pseudo-elements, values as tokens.
10. Check: figma_compare${pageUrl ? ` with url: "${pageUrl}"` : ''} at every breakpoint, then layout_stress — long and empty text, a list of twelve, a broken image, a range of widths. A difference of 1px or font rendering is not a defect.`,
        }),
      ),
  );
}
