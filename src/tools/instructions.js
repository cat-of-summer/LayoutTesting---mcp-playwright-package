/**
 * Описание сервера для клиента MCP.
 *
 * Клиент показывает этот текст модели при подключении — это единственное место, где можно
 * объяснить, для каких задач сюда вообще идти. Без него агент видит четыре десятка описаний
 * без всякой рамки и выбирает инструмент по совпадению слов, то есть чаще всего не выбирает
 * вовсе.
 *
 * Текст построен от симптома, а не от устройства стенда: агент решает, чем воспользоваться,
 * по формулировке человека («поехала вёрстка», «find broken links»), а не по названию проверки.
 * Держать его коротким важнее, чем полным: полный список инструментов агент и так видит.
 *
 * Пункты помечены группами и собираются по активной выборке, а не выводятся целиком. Иначе на
 * /mcp/seo рамка советовала бы начать с layout_audit, которого на этом адресе нет, — а совет,
 * указывающий в пустоту, хуже отсутствующего: модель решит, что стенд неисправен, и не станет
 * искать обходной путь.
 *
 * Английская версия — не подстрочник. Симптомы в ней те, которые действительно произносят
 * по-английски, иначе триггеры не сработают.
 */
import { t } from '../i18n.js';
import { FLOOR } from './groups.js';

const LEAD = {
  ru: `Стенд тестирования вёрстки: живой браузер (chromium, firefox, webkit),
проверки страницы, SEO и обход сайта. Работает и с локальными стендами, и с боевыми сайтами.`,
  en: `Layout testing stand: a real browser (chromium, firefox, webkit), page checks, SEO
and site crawling. Works against local dev servers and production sites alike.`,
};

/** Заголовок над списком симптомов. Отдельно от преамбулы: без списка он повис бы над пустотой. */
const HEADING = {
  ru: 'С чего начинать по типу задачи:',
  en: 'Where to start, by what the user asks:',
};

/**
 * Оговорка про неполную выборку.
 *
 * Преамбула описывает стенд целиком, и на /mcp/layout она обещала бы SEO и обход сайта, которых
 * на этом адресе нет. Сказать об этом надо прямо и сразу: агент, не нашедший инструмента, иначе
 * заключит, что стенд сломан, вместо того чтобы попросить человека о втором подключении.
 */
const scope = (active) => {
  /* artifacts и help перечислять незачем: они есть на любом адресе, и в списке только шумят. */
  const named = [...active].filter((group) => !FLOOR.includes(group)).sort().join(', ');
  return {
    ru: `На этом подключении поднята часть инструментов стенда: ${named}. Остальные есть у того же
стенда по адресу /mcp — полный словарь, адрес этого подключения и то, что добрано по
зависимостям, показывает stand_info.`,
    en: `This connection exposes a subset of the stand: ${named}. The rest live on the same stand at
/mcp — stand_info shows the full vocabulary, the address of this connection and what was pulled
in as a dependency.`,
  };
};

/**
 * Пункты «симптом — инструмент». groups — при каких активных группах пункт имеет смысл:
 * достаточно одной из перечисленных, потому что пункт называет несколько инструментов и
 * остаётся полезным, даже если поднята часть.
 */
const HINTS = [
  {
    groups: ['layout'],
    ru: `- «поехала вёрстка», «съехал блок», «горизонтальный скролл», «текст обрезан», «элементы
  наложились», «не видно кнопку», «стиль не применяется» — layout_audit, затем element_layers,
  matched_rules, computed_styles для разбора конкретного элемента;`,
    en: `- "layout is broken", "element is misplaced", "horizontal scroll", "text is cut off", "elements
  overlap", "button is invisible", "my CSS is not applied" — layout_audit first, then
  element_layers, matched_rules, computed_styles to dig into one element;`,
  },
  {
    groups: ['composite'],
    ru: `- «проверь страницу», «что тут не так» — audit: один вызов гоняет набор проверок сразу и
  возвращает сводку. Это самый дешёвый первый шаг;`,
    en: `- "check this page", "what is wrong here" — audit: one call runs a set of checks at once and
  returns a summary. Cheapest first step;`,
  },
  {
    groups: ['visual'],
    ru: `- «покажи, как выглядит», «сделай скриншот», «сравни с макетом» — screenshot, compare_pages
  (попиксельно), compare_layout (по DOM, когда тексты и картинки различаются);`,
    en: `- "show me how it looks", "take a screenshot", "compare against the mockup" — screenshot,
  compare_pages (pixel diff), compare_layout (DOM diff, when texts and images differ);`,
  },
  {
    groups: ['a11y'],
    ru: `- «доступность», «WCAG», «скринридер» — a11y_axe и a11y_pa11y: наборы правил разные, ловят разное;`,
    en: `- "accessibility", "WCAG", "screen reader" — a11y_axe and a11y_pa11y: different rule sets,
  they catch different things;`,
  },
  {
    groups: ['perf'],
    ru: `- «медленно грузится», «прыгает при загрузке», «CLS», «Lighthouse» — web_vitals, lighthouse;`,
    en: `- "slow page", "content jumps while loading", "CLS", "Lighthouse" — web_vitals, lighthouse;`,
  },
  {
    groups: ['static'],
    ru: `- «валидна ли разметка» — validate_html;`,
    en: `- "is the markup valid" — validate_html;`,
  },
  /* Прежде это был один пункт, но seo_page и site_files живут в разных группах: на /mcp/seo
     совет про robots.txt вёл бы к отсутствующему инструменту. */
  {
    groups: ['seo'],
    ru: `- «SEO», «мета-теги», «микроразметка», «canonical», «hreflang» — seo_page;`,
    en: `- "SEO", "meta tags", "structured data", "canonical", "hreflang" — seo_page;`,
  },
  {
    groups: ['crawl'],
    ru: `- «robots», «sitemap», «карта сайта» — site_files;`,
    en: `- "robots", "sitemap" — site_files;`,
  },
  {
    groups: ['crawl'],
    ru: `- «обойди сайт», «собери все страницы», «найди дубли заголовков», «где битые ссылки» — crawl,
  затем crawl_pages (выборка страниц), crawl_query (селектор по всем страницам) и seo_report
  (сводный отчёт по сайту);`,
    en: `- "crawl the site", "collect all pages", "find duplicate titles", "find broken links" — crawl,
  then crawl_pages (select pages), crawl_query (run a selector across every page) and seo_report
  (site-wide report);`,
  },
  {
    groups: ['session'],
    ru: `- «заполни форму», «загрузи файл», «страница показала alert», «что именно ушло на сервер» —
  browser_act (click, fill, upload, dialog) и browser_route с record: он записывает состав
  запроса, а не только факт попадания;`,
    en: `- "fill the form", "upload a file", "the page shows an alert", "what did the form actually
  send" — browser_act (click, fill, upload, dialog) and browser_route with record, which
  captures the request body rather than just the fact that a rule matched;`,
  },
  {
    groups: ['figma'],
    ru: `- «сверстай по макету», «вот ссылка на Figma», «сделай как в макете» — figma_status, затем
  figma_sync со всеми кадрами задачи разом, дальше разбор по снимку: figma_structure (план
  разметки), figma_breakpoints (что меняется с шириной), figma_components (сколько на самом деле
  блоков), figma_tokens (что становится переменной), figma_comments и figma_behavior (требования
  и связи), figma_export (иконки и картинки). Готовый порядок целиком — промпт figma-layout;`,
    en: `- "build this from the design", "here is a Figma link", "make it like the mockup" — figma_status,
  then figma_sync with every frame of the task at once, then analysis over the snapshot:
  figma_structure (the markup plan), figma_breakpoints (what changes with width), figma_components
  (how many blocks there really are), figma_tokens (what becomes a variable), figma_comments and
  figma_behavior (requirements and links), figma_export (icons and images). The whole order is in
  the figma-layout prompt;`,
  },
  {
    groups: ['figma'],
    ru: `- «совпадает ли с макетом», «сравни вёрстку с Figma» — figma_compare: тексты сопоставляются по
  содержимому, и видно, что именно съехало, а не только процент различий;`,
    en: `- "does it match the design", "compare the build with Figma" — figma_compare: texts are matched by
  content, so it shows what actually moved rather than a percentage;`,
  },
  {
    groups: ['layout'],
    ru: `- «выдержит ли длинный текст», «что будет, если контента больше» — layout_stress;`,
    en: `- "will it survive a long title", "what if there is more content" — layout_stress;`,
  },
  {
    groups: ['observe'],
    ru: `- «сохрани страницу», «работай по копии, не дёргай сайт» — page_save;`,
    en: `- "save the page", "work off a local copy, stop hitting the site" — page_save;`,
  },
  {
    groups: ['session'],
    ru: `- нужен доступ за логином — browser_storage: сохранить состояние и подставлять его по имени.`,
    en: `- something is behind a login — browser_storage: save the state, then pass it by name.`,
  },
];

/** Совет про дешёвый первый шаг имеет смысл только там, где page_snapshot поднят. */
const SNAPSHOT = {
  groups: ['observe'],
  ru: `Разбор дешевле начинать с page_snapshot: текстовый слепок страницы с готовыми селекторами
обходится на порядок дешевле скриншота. Скриншот нужен, когда вопрос именно про внешний вид.`,
  en: `Prefer page_snapshot to start with: a text outline of the page with ready-to-use selectors costs
an order of magnitude less than a screenshot. Take a screenshot when the question is about looks.`,
};

/** Про устройство стенда, а не про инструменты: верно при любой выборке. */
const TAIL = {
  ru: `Описания инструментов намеренно короткие: в них симптом и отличие от соседа. Оговорки про
поддержку движками, нюансы параметров, действующие потолки на объём ответов и порядок разбора
типовой задачи лежат в help — help без аргументов перечисляет темы, help с tool: имя даёт
оговорки конкретного инструмента.

Куда обращаться. Стенд живёт в контейнере, и localhost внутри него указывает на сам стенд, а не
на машину пользователя. Локальный проект — по имени его контейнера в общей docker-сети
(http://nginx_myapp/), приложение на хосте — http://host.docker.internal:5173, боевой сайт — по
обычному адресу.

Артефакты возвращаются двумя ссылками. url открывают в своём браузере, internalUrl — адрес того
же файла изнутри контейнера: снаружи и изнутри они разные.`,
  en: `Tool descriptions are deliberately short: they carry the symptom and the difference from a
neighbouring tool. Engine support caveats, parameter details, the response size caps in force and
the order of working through a typical task live in help — help with no arguments lists the
topics, help with tool: name gives the caveats of one tool.

Addressing targets. The stand runs inside a container, so localhost there points at the stand
itself, not at the user's machine. A local project is reachable by its container name on the
shared docker network (http://nginx_myapp/), an app on the host as http://host.docker.internal:5173,
a production site by its normal address.

Artifacts come back with two links. Open url in your own browser; internalUrl is the same file as
seen from inside the container — the address differs inside and outside.`,
};

/**
 * Зачем нужен internalUrl на практике — это про browser_goto, поэтому говорится только там, где
 * группа session поднята. На /mcp/seo совет подставить адрес в browser_goto вёл бы в пустоту.
 */
const INTERNAL_URL = {
  groups: ['session'],
  ru: `internalUrl подставляют в browser_goto, когда стенду надо открыть собственный отчёт или
сохранённую копию.`,
  en: `Pass internalUrl to browser_goto when the stand needs to open its own report or a saved copy.`,
};

/**
 * Рамка подключения под активную выборку.
 *
 * @param {Set<string>|null} active — поднятые группы; null означает «все».
 */
export function buildInstructions(active) {
  const on = (entry) => !active || entry.groups.some((group) => active.has(group));

  const parts = [t(LEAD)];
  if (active) parts.push(t(scope(active)));

  const hints = HINTS.filter(on).map((hint) => t(hint));
  /* Выборка, в которой не нашлось ни одного симптома, рамку всё равно получает: преамбула и
     хвост объясняют, куда попал агент и как адресовать цели. Заголовок при этом опускается
     вместе со списком — над пустотой он только сбивает. */
  if (hints.length) parts.push(`${t(HEADING)}\n\n${hints.join('\n')}`);

  if (on(SNAPSHOT)) parts.push(t(SNAPSHOT));
  parts.push(t(TAIL));
  if (on(INTERNAL_URL)) parts.push(t(INTERNAL_URL));

  return parts.join('\n\n');
}

/** Полная рамка. Остаётся ради тех, кому нужен текст целиком: генератор документации, тесты. */
export const INSTRUCTIONS = buildInstructions(null);
