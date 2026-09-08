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
 * Английская версия — не подстрочник. Симптомы в ней те, которые действительно произносят
 * по-английски, иначе триггеры не сработают.
 */
import { t } from '../i18n.js';

const RU = `Стенд тестирования вёрстки: живой браузер (chromium, firefox, webkit),
проверки страницы, SEO и обход сайта. Работает и с локальными стендами, и с боевыми сайтами.

С чего начинать по типу задачи:

- «поехала вёрстка», «съехал блок», «горизонтальный скролл», «текст обрезан», «элементы
  наложились», «не видно кнопку», «стиль не применяется» — layout_audit, затем element_layers,
  matched_rules, computed_styles для разбора конкретного элемента;
- «проверь страницу», «что тут не так» — audit: один вызов гоняет набор проверок сразу и
  возвращает сводку. Это самый дешёвый первый шаг;
- «покажи, как выглядит», «сделай скриншот», «сравни с макетом» — screenshot, compare_pages
  (попиксельно), compare_layout (по DOM, когда тексты и картинки различаются);
- «доступность», «WCAG», «скринридер» — a11y_axe и a11y_pa11y: наборы правил разные, ловят разное;
- «медленно грузится», «прыгает при загрузке», «CLS», «Lighthouse» — web_vitals, lighthouse;
- «валидна ли разметка» — validate_html;
- «SEO», «мета-теги», «микроразметка», «canonical», «hreflang», «robots», «sitemap» — seo_page
  для страницы, site_files для robots.txt и карты сайта;
- «обойди сайт», «собери все страницы», «найди дубли заголовков», «где битые ссылки» — crawl,
  затем crawl_pages (выборка страниц), crawl_query (селектор по всем страницам) и seo_report
  (сводный отчёт по сайту);
- «сохрани страницу», «работай по копии, не дёргай сайт» — page_save;
- нужен доступ за логином — browser_storage: сохранить состояние и подставлять его по имени.

Разбор дешевле начинать с page_snapshot: текстовый слепок страницы с готовыми селекторами
обходится на порядок дешевле скриншота. Скриншот нужен, когда вопрос именно про внешний вид.

Описания инструментов намеренно короткие: в них симптом и отличие от соседа. Оговорки про
поддержку движками, нюансы параметров, действующие потолки на объём ответов и порядок разбора
типовой задачи лежат в help — help без аргументов перечисляет темы, help с tool: имя даёт
оговорки конкретного инструмента.

Куда обращаться. Стенд живёт в контейнере, и localhost внутри него указывает на сам стенд, а не
на машину пользователя. Локальный проект — по имени его контейнера в общей docker-сети
(http://nginx_myapp/), приложение на хосте — http://host.docker.internal:5173, боевой сайт — по
обычному адресу.

Артефакты возвращаются двумя ссылками. url открывают в своём браузере, internalUrl подставляют
в browser_goto, когда стенду надо открыть собственный отчёт или сохранённую копию: снаружи и
изнутри контейнера адреса разные.`;

const EN = `Layout testing stand: a real browser (chromium, firefox, webkit), page checks, SEO
and site crawling. Works against local dev servers and production sites alike.

Where to start, by what the user asks:

- "layout is broken", "element is misplaced", "horizontal scroll", "text is cut off", "elements
  overlap", "button is invisible", "my CSS is not applied" — layout_audit first, then
  element_layers, matched_rules, computed_styles to dig into one element;
- "check this page", "what is wrong here" — audit: one call runs a set of checks at once and
  returns a summary. Cheapest first step;
- "show me how it looks", "take a screenshot", "compare against the mockup" — screenshot,
  compare_pages (pixel diff), compare_layout (DOM diff, when texts and images differ);
- "accessibility", "WCAG", "screen reader" — a11y_axe and a11y_pa11y: different rule sets,
  they catch different things;
- "slow page", "content jumps while loading", "CLS", "Lighthouse" — web_vitals, lighthouse;
- "is the markup valid" — validate_html;
- "SEO", "meta tags", "structured data", "canonical", "hreflang", "robots", "sitemap" — seo_page
  for one page, site_files for robots.txt and the sitemap;
- "crawl the site", "collect all pages", "find duplicate titles", "find broken links" — crawl,
  then crawl_pages (select pages), crawl_query (run a selector across every page) and seo_report
  (site-wide report);
- "save the page", "work off a local copy, stop hitting the site" — page_save;
- something is behind a login — browser_storage: save the state, then pass it by name.

Prefer page_snapshot to start with: a text outline of the page with ready-to-use selectors costs
an order of magnitude less than a screenshot. Take a screenshot when the question is about looks.

Tool descriptions are deliberately short: they carry the symptom and the difference from a
neighbouring tool. Engine support caveats, parameter details, the response size caps in force and
the order of working through a typical task live in help — help with no arguments lists the
topics, help with tool: name gives the caveats of one tool.

Addressing targets. The stand runs inside a container, so localhost there points at the stand
itself, not at the user's machine. A local project is reachable by its container name on the
shared docker network (http://nginx_myapp/), an app on the host as http://host.docker.internal:5173,
a production site by its normal address.

Artifacts come back with two links. Open url in your own browser; pass internalUrl to browser_goto
when the stand needs to open its own report or a saved copy — the address differs inside and
outside the container.`;

export const INSTRUCTIONS = t({ ru: RU, en: EN });
