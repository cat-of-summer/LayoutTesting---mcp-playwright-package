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
import { resolveSelection } from './groups.js';

const say = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

/**
 * Сценарий имеет смысл, только когда подняты инструменты, о которых он рассказывает.
 * Порядок шагов, половина которого недоступна, сбивает сильнее, чем отсутствие сценария:
 * человек выбирает его руками и вправе рассчитывать, что выбранное выполнимо.
 *
 * @param {object} ctx
 * @param {{groups: Set<string>|null}} ctx.selection
 */
export function register(server, { selection = resolveSelection('all') } = {}) {
  const on = (...groups) => !selection.groups || groups.some((group) => selection.groups.has(group));

  if (on('layout', 'observe')) server.registerPrompt(
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

  if (on('visual')) server.registerPrompt(
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

  if (on('crawl', 'seo')) server.registerPrompt(
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

  if (on('figma')) server.registerPrompt(
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

Работа идёт по регламенту, и он проходится по одной фазе, а не читается целиком. Порядок такой: вызвал фазу — сделал — проверил её гейт — вызвал следующую. Имя следующей стоит в конце каждой фазы, поэтому список держать в голове не надо.

1. help(guide: "index") — как устроена процедура и сколько всего фаз.
2. help(guide: "setup") — фаза 0, и она до первой строки кода. Стенд в контейнере не видит localhost хоста: dev-сервер поднимается на 0.0.0.0 и открывается как http://host.docker.internal:<порт>. Проверь это первым делом — выяснять в середине работы дороже впятеро.
3. figma_status — до снимка: без REST не прочитать комментарии, а в них половина требований; нет токена — action: token или вопрос человеку, не пропуск. Затем figma_sync со ВСЕМИ кадрами задачи одним вызовом. Дальше разбор идёт по снимку и в Figma не ходит: лимит REST — десять запросов в минуту, у места View/Collab двадцать в месяц. Открой две сессии сразу: рабочую и живую с animations: "allow" — hover и intro видны только во второй.
4. Дальше веди цепочку до конца: фаза 1 — help(guide: "frames")${projectUrl ? `. На фазе 3 передавай figma_components и figma_tokens project: { url: "${projectUrl}" }` : ''}.

Не пропускай фазы и не меняй их местами. Пропущенная обычно всплывает переделкой блока: не спросил про шрифты — переделал типографику, не прокликал слайдер — сдал его сломанным.

Три вещи, которые надо знать до первого вызова, — остальное в регламенте:

- значения берутся из узла, а не из рендера и не из figma_tokens: figma_spec и figma_inspect с mode: outline показывают краску в фигурных скобках;
- структура берётся из дерева макета, а не с картинки;
- неподвижный снимок ничего не говорит про интерактив: его проходит interaction_audit в сессии с animations: "allow".

Перед переходом к следующей фазе перечитай текущую кратко: help(guide: "<фаза>", brief: true).

Проверка блока — help(guide: "block")${pageUrl ? `; figma_compare по адресу ${pageUrl}` : ''}: сверка — картинка с картинкой (sections: true), «высота секции сошлась» — не критерий. Правила и запреты одной страницей — help(guide: "rules"). Выбор инструмента под симптом — help(guide: "symptoms").`,
          en: `Build the page from the design: ${figma}.

The work follows the handbook, and the handbook is walked one phase at a time rather than read in full. The order is: call a phase, do it, check its gate, call the next. The name of the next one sits at the end of every phase, so there is no list to keep in your head.

1. help(guide: "index") — how the procedure works and how many phases there are.
2. help(guide: "setup") — phase 0, and it comes before the first line of code. The stand runs in a container and cannot see the host localhost: the dev server must listen on 0.0.0.0 and is reached as http://host.docker.internal:<port>. Check this first — finding it out mid-work costs five times as much.
3. figma_status — before the snapshot: without REST the comments cannot be read, and half the requirements live there; no token means action: token or a question to the human, not a skip. Then figma_sync with EVERY frame of the task in one call. After that the analysis reads the snapshot and never calls Figma: the REST limit is ten requests a minute, and twenty a month on a View/Collab seat. Open two sessions right away: a working one and a live one with animations: "allow" — hover and intro are visible only in the second.
4. Then follow the chain to the end: phase 1 is help(guide: "frames")${projectUrl ? `. At phase 3 pass figma_components and figma_tokens project: { url: "${projectUrl}" }` : ''}.

Do not skip phases and do not reorder them. A skipped one usually surfaces as a rebuilt block: the fonts were never asked about and the typography was redone; the slider was never clicked through and shipped broken.

Three things to know before the first call — the rest is in the handbook:

- values come from the node, not from the render and not from figma_tokens: figma_spec and figma_inspect with mode: outline show the paint inside curly braces;
- structure comes from the design tree, not from the picture;
- a still screenshot says nothing about interaction: interaction_audit walks it in a session with animations: "allow".

Before moving to the next phase, re-read the current one briefly: help(guide: "<phase>", brief: true).

Checking a block is help(guide: "block")${pageUrl ? `; run figma_compare against ${pageUrl}` : ''}: the check is picture against picture (sections: true); "the section height matches" is not a criterion. The rules and prohibitions on one page are help(guide: "rules"). Choosing a tool for a symptom is help(guide: "symptoms").`,
        }),
      ),
  );
}
