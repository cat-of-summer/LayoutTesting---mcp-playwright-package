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
}
