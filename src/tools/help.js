/**
 * Подробности по требованию.
 *
 * Описание инструмента — единственное, что модель читает ДО выбора, и платит за него при каждом
 * подключении. Поэтому в описании остаётся то, от чего зависит выбор: симптом, с которым сюда
 * идут, и отличие от соседнего инструмента. Всё, что нужно уже после выбора — оговорки про
 * поддержку движками, нюансы параметров, форма ответа, действующие потолки, — уезжает сюда и
 * читается один раз, когда действительно понадобилось.
 *
 * Граница именно такая, а не «покороче»: описание, срезанное до неузнаваемости, экономит токены
 * ценой того, что инструмент не выберут вовсе, и до help дело не дойдёт.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { json, text } from './shared.js';
import { t } from '../i18n.js';
import { CONFIG } from '../config.js';

const TOPICS = {
  addressing: {
    title: t({ ru: 'Куда обращаться', en: 'Addressing targets' }),
    body: () =>
      t({
        ru: `Стенд живёт в контейнере, и это меняет смысл адресов.

localhost внутри контейнера — сам стенд, а не машина человека. Обращение по нему почти всегда ошибка.

- Локальный проект в общей docker-сети — по имени его контейнера: http://nginx_myapp/, http://node_myapp:3000.
- Приложение, запущенное на машине человека, — http://host.docker.internal:5173.
- Боевой сайт — по обычному адресу.
- Стенд за vhost, у которого имя не разрешается изнутри, — hostMap: {"www.site.local": "172.20.0.5"} в browser_open. Только chromium: это аргумент запуска браузера, и на каждый набор правил поднимается свой процесс.

Собственные артефакты стенд открывает по internalUrl, а не по url — см. topic: artifacts.`,
        en: `The stand runs inside a container, and that changes what addresses mean.

localhost inside the container is the stand itself, not the user machine. Reaching for it is almost always a mistake.

- A local project on the shared docker network — by its container name: http://nginx_myapp/, http://node_myapp:3000.
- An app running on the user machine — http://host.docker.internal:5173.
- A production site — by its normal address.
- A stand behind a vhost whose name does not resolve inside — hostMap: {"www.site.local": "172.20.0.5"} in browser_open. Chromium only: it is a browser launch argument, and each distinct rule set gets its own browser process.

The stand opens its own artifacts by internalUrl, not by url — see topic: artifacts.`,
      }),
  },

  artifacts: {
    title: t({ ru: 'Артефакты и адреса до них', en: 'Artifacts and how to address them' }),
    body: () =>
      t({
        ru: `Снимки, отчёты и зеркала складываются в каталог прогона и возвращаются тремя адресами:

- path — путь в файловой системе стенда, для read_artifact;
- url — для человека, открыть в своём браузере (${CONFIG.publicBaseUrl});
- internalUrl — для browser_goto, когда стенду надо открыть собственный отчёт или сохранённую копию (${CONFIG.internalBaseUrl}).

Различать обязательно: снаружи проброшен порт, внутри контейнера его не существует, и по публичной ссылке браузер стенда получит ECONNREFUSED.

Имя каталога прогона — метка времени плюс случайные знаки плюс необязательное имя: 2026-09-08T10-22-31_a1b2_имя-прогона. Старые прогоны чистятся сами, остаётся последние ${CONFIG.artifactsKeep}; artifacts_clean нужен, только когда место кончилось прямо сейчас.

Каталоги, чьё имя не похоже на прогон, автоочистка не трогает: их положил человек, ему и решать. Эталоны (baselines) и архивы обхода (sites) не чистятся вовсе — обход стоит несопоставимо дороже снимка.`,
        en: `Screenshots, reports and mirrors land in a run directory and come back with three addresses:

- path — a filesystem path inside the stand, for read_artifact;
- url — for a human to open in their own browser (${CONFIG.publicBaseUrl});
- internalUrl — for browser_goto, when the stand needs to open its own report or a saved copy (${CONFIG.internalBaseUrl}).

Telling them apart is mandatory: the port is published outside, does not exist inside the container, and the stand browser gets ECONNREFUSED from a public link.

A run directory is named by timestamp plus random characters plus an optional label: 2026-09-08T10-22-31_a1b2_run-label. Old runs are pruned automatically, the last ${CONFIG.artifactsKeep} are kept; artifacts_clean is only needed when disk space ran out right now.

Directories whose names do not look like a run are never pruned: a human put them there. Baselines and crawl archives (sites) are never pruned at all — a crawl costs incomparably more than a screenshot.`,
      }),
  },

  profiles: {
    title: t({ ru: 'Условия просмотра и профили', en: 'Viewing conditions and profiles' }),
    body: () =>
      t({
        ru: `Полный набор условий объявлен в одном месте — browser_open. Их девятнадцать: движок, размер, тема, forced-colors, reduced-motion, RTL, zoom страницы, zoom шрифта, псевдолокализация, DPR, локаль, таймзона, заморозка времени, троттлинг сети и CPU, basic-auth, заголовки, подмена разрешения имён, сохранённый логин, Service Workers.

Инструменты, открывающие сессию сами (audit, web_vitals, seo_page, page_save, storybook_audit), принимают три самых частых параметра прямо — browser, viewport, colorScheme, — а остальные по имени профиля.

Порядок работы: browser_open с нужными условиями, убедиться, что страница отрисовалась как надо, затем browser_profile с action: save. Дальше profile: "имя" в любом из этих инструментов.

Профиль живёт в памяти процесса; persist: true записывает его на диск, чтобы он пережил перезапуск. Пароли и заголовки в профиль не пишутся — логин переносят через storageState, его имя профиль хранит.

zoom стоит понимать буквально: увеличение страницы уменьшает область просмотра в CSS-пикселях, ровно как в браузере. zoom: 200 при desktop даёт 720x450, и это же попадает в имя эталона.`,
        en: `The full set of conditions is declared in exactly one place — browser_open. There are nineteen: engine, size, color scheme, forced-colors, reduced-motion, RTL, page zoom, text zoom, pseudo-localization, DPR, locale, timezone, frozen time, network and CPU throttling, basic auth, headers, host resolution override, saved login, Service Workers.

Tools that open a session themselves (audit, web_vitals, seo_page, page_save, storybook_audit) take the three most frequent parameters directly — browser, viewport, colorScheme — and the rest by profile name.

The order of work: browser_open with the conditions you need, check the page renders as expected, then browser_profile with action: save. After that, profile: "name" in any of those tools.

A profile lives in process memory; persist: true writes it to disk so it survives a restart. Passwords and headers are never written into a profile — carry a login through storageState, whose name a profile does keep.

Take zoom literally: magnifying the page shrinks the viewport in CSS pixels, exactly as a browser does. zoom: 200 on desktop gives 720x450, and that is what goes into the baseline name.`,
      }),
  },
};

const MORE_TOPICS = {
  limits: {
    title: t({ ru: 'Потолки на объём ответов', en: 'Response size caps' }),
    body: () =>
      t({
        ru: `Ответ инструмента ограничен, чтобы один вызов не занял больше контекста, чем весь разговор до него. Данные при этом не теряются — до них есть другой путь.

- Текст файла и результат browser_eval — ${CONFIG.maxTextBytes} символов. Дальше через offset, а для browser_eval лучше сузить само выражение: вернуть нужные поля, а не узел целиком.
- Картинка в ответе — до ${CONFIG.maxInlineBytes} байт. Выше — уменьшенная копия шириной 900px; если и она не помещается, ответ приходит без картинки, а оригинал остаётся по url артефакта.
- Логи — ${CONFIG.maxLogEntries} записей каждого вида, берётся хвост: свежая ошибка объясняет происходящее, первая из позапрошлой страницы нет. Длинные поля записей обрезаются.
- Списки в отчётах несут признак truncated и подсказку со следующим offset. В отчёте по сайту рядом с примерами лежит counts с полными числами: пятьдесят битых ссылок и пять тысяч требуют разных решений.

Увидели truncated — не переспрашивайте тот же вызов, идите по offset из подсказки.`,
        en: `A tool response is capped so that one call cannot take more context than the whole conversation before it. No data is lost — there is another way to it.

- File text and browser_eval results — ${CONFIG.maxTextBytes} characters. Continue via offset; for browser_eval, better narrow the expression itself and return the fields you need, not the whole node.
- An inline image — up to ${CONFIG.maxInlineBytes} bytes. Above that, a 900px-wide downscaled copy; if even that does not fit, the response comes without an image and the original stays at the artifact url.
- Logs — ${CONFIG.maxLogEntries} entries of each kind, taken from the tail: a fresh error explains what is happening, the first one from two pages ago does not. Long entry fields are clipped.
- Lists in reports carry a truncated flag and a hint with the next offset. In the site report, counts sits next to the examples with the full numbers: fifty broken links and five thousand call for different decisions.

If you see truncated, do not repeat the same call — follow the offset from the hint.`,
      }),
  },

  sessions: {
    title: t({ ru: 'Жизнь сессий браузера', en: 'Browser session lifetime' }),
    body: () =>
      t({
        ru: `Сессия — это контекст браузера со своей страницей, логами и патчами. Она стоит сотни мегабайт, поэтому живёт не бесконечно.

- Одновременно не больше ${CONFIG.maxSessions}. На потолке вытесняется та, к которой дольше всех не обращались.
- Простой дольше ${Math.round(CONFIG.sessionIdleMs / 60000)} минут — сессия закрывается сама. Предельный возраст — ${Math.round(CONFIG.sessionMaxAgeMs / 60000)} минут, даже если её продолжают трогать.
- Сессии внутренних прогонов (обход, матрица) не вытесняются: за ними следит собственный порядок завершения.

Закрывайте browser_close, закончив со страницей: рассчитывать на автоматику не стоит, она страховка, а не порядок работы.

Если сессия исчезла, ошибка скажет, почему именно, и принесёт готовые условия для browser_open. Тот же журнал возвращает browser_sessions в поле recentlyClosed — там видно, что закрылось и по какой причине, без неудачного вызова.`,
        en: `A session is a browser context with its own page, logs and patches. It costs hundreds of megabytes, so it does not live forever.

- At most ${CONFIG.maxSessions} at a time. At the cap, the least recently used one is evicted.
- Idle for more than ${Math.round(CONFIG.sessionIdleMs / 60000)} minutes and a session closes itself. The hard age limit is ${Math.round(CONFIG.sessionMaxAgeMs / 60000)} minutes, even if it keeps being used.
- Sessions of internal runs (crawl, matrix) are never evicted: they are closed by their own teardown.

Call browser_close when you are done with a page: the automatic path is a safety net, not the way of working.

If a session is gone, the error says exactly why and carries ready conditions for browser_open. The same ledger comes back from browser_sessions in recentlyClosed — it shows what closed and for what reason, without a failed call first.`,
      }),
  },

  workflows: {
    title: t({ ru: 'Порядок разбора', en: 'How to work through a task' }),
    body: () =>
      t({
        ru: `Поехавшая вёрстка. layout_audit по открытой сессии — он отдаёт находки готовыми селекторами. Дальше по конкретному элементу: element_layers, если элемента не видно или он чем-то накрыт; matched_rules, если выиграло не то правило; computed_styles, если нужны итоговые значения. Скриншот в конце, а не в начале: page_snapshot стоит на порядок дешевле и обычно отвечает на вопрос.

Проверка страницы целиком. audit одним вызовом — самый дешёвый первый шаг. По его сводке видно, чем копать подробнее.

Визуальная регрессия. visual_compare сравнивает с эталоном по имени и профилю; при первом прогоне эталона нет, его заводят updateBaseline. Динамику убирают заранее: hide для баннеров и чатов, mask для областей с меняющимся содержимым, freezeTime для дат и случайных чисел.

Сравнение макета со сборкой. compare_pages, если различаться должны только пиксели. compare_layout, если тексты и картинки заведомо разные, а сверять надо структуру и геометрию.

Сайт целиком. crawl запускает обход фоном, action: status показывает прогресс. По готовому архиву: crawl_pages — выборка страниц, crawl_query — селектор по всем страницам, seo_report — сводка тем, чего не видно на отдельной странице.

Работа по копии. page_save кладёт страницу в локальное зеркало, дальше её можно разбирать сколько угодно, не трогая чужой сервер.`,
        en: `Broken layout. layout_audit on an open session — it returns findings as ready-to-use selectors. Then dig into one element: element_layers when it is invisible or covered, matched_rules when the wrong rule won, computed_styles when you need the resulting values. Take a screenshot at the end, not at the start: page_snapshot costs an order of magnitude less and usually answers the question.

Checking a whole page. audit in one call is the cheapest first step. Its summary shows what to dig into.

Visual regression. visual_compare compares against a baseline by name and profile; on the first run there is no baseline, so create it with updateBaseline. Remove the moving parts first: hide for banners and chat widgets, mask for regions with changing content, freezeTime for dates and random numbers.

Mockup against a build. compare_pages when only pixels should differ. compare_layout when texts and images are knowingly different and what you check is structure and geometry.

A whole site. crawl starts in the background, action: status shows progress. On a finished archive: crawl_pages selects pages, crawl_query runs a selector across all of them, seo_report sums up what is invisible on a single page.

Working off a copy. page_save puts the page into a local mirror, after which it can be examined as much as needed without touching the remote server.`,
      }),
  },
};

Object.assign(TOPICS, MORE_TOPICS);

/**
 * Подробности по инструментам: то, что нужно уже после выбора.
 *
 * Здесь лежит ровно то, что раньше занимало место в описаниях: оговорки про поддержку
 * движками, форма ответа, нюансы параметров, порядок вызовов.
 */
const DETAILS = {
  matched_rules: () =>
    t({
      ru: 'Только chromium: нужен CDP. Понимает псевдоэлементы (::before, ::after) и наследование. Показывает все совпавшие правила с их специфичностью и то, какое из них выиграло по каждому свойству, плюс файл и строку, где оно объявлено.',
      en: 'Chromium only: it needs CDP. Understands pseudo-elements (::before, ::after) and inheritance. Shows every matching rule with its specificity and which one won for each property, plus the file and line where it is declared.',
    }),
  element_layers: () =>
    t({
      ru: 'Отдаёт свойства самого элемента, влияющие на слои, цепочку стек-контекстов над ним, перекрывающих соседей и то, что реально нарисовано в его точках. Последнее и отвечает на вопрос «почему не видно»: элемент может быть на месте, но под непрозрачным слоем.',
      en: 'Returns the own layer-affecting properties of the element, the chain of stacking contexts above it, overlapping siblings, and what is actually painted at its points. That last part answers why it is invisible: the element can be in place but under an opaque layer.',
    }),
  browser_route: () =>
    t({
      ru: 'Правила переживают навигацию: заданные один раз, они действуют и после browser_goto. В action: list виден счётчик попаданий по каждому правилу — без него несработавшее правило не отличить от сработавшего, и это самая частая причина, по которой подмена кажется неприменившейся. Ошибка внутри обработчика записывается в lastError, а запрос всё равно пропускается: иначе он повис бы навсегда.',
      en: 'Routes survive navigation: set once, they keep working after browser_goto. action: list shows a hit counter per route — without it a route that never matched is indistinguishable from one that did, and that is the most common reason an override looks like it did not apply. An error inside a handler is recorded in lastError and the request is let through anyway: otherwise it would hang forever.',
    }),
  browser_storage: () =>
    t({
      ru: 'localStorage и sessionStorage снимаются с текущей страницы, а не со всего сайта: API уровня контекста у них нет. Куки — со всего контекста. export кладёт куки и localStorage в state/<имя>.json; sessionStorage туда не попадает, это ограничение playwright. Сохранённое имя передаётся в storageState при открытии любой сессии — так логин переживает browser_close и перезапуск стенда.',
      en: 'localStorage and sessionStorage are read from the current page, not from the whole site: there is no context-level API for them. Cookies come from the whole context. export writes cookies and localStorage into state/<name>.json; sessionStorage is not included, which is a playwright limitation. Pass the saved name as storageState when opening any session — that is how a login survives browser_close and a stand restart.',
    }),
};

Object.assign(DETAILS, {
  page_save: () =>
    t({
      ru: 'Копия открывается через browser_goto по internalUrl, и к ней применимы все остальные инструменты — layout_audit, screenshot, computed_styles, matched_rules. scripts: strip (по умолчанию) вырезает скрипты: на копии аналитика стучит в сеть, а роутер SPA подменяет страницу. JSON-LD остаётся в любом случае. Ресурсы дедуплицируются по содержимому, поэтому повторные сохранения того же сайта почти не занимают места.',
      en: 'The copy opens through browser_goto by its internalUrl, and every other tool applies to it — layout_audit, screenshot, computed_styles, matched_rules. scripts: strip (the default) removes scripts: on a copy, analytics still calls out to the network and an SPA router replaces the page. JSON-LD is kept either way. Resources are deduplicated by content, so saving the same site again takes almost no space.',
    }),
  crawl: () =>
    t({
      ru: 'Каждая страница берётся обычным HTTP-запросом — дёшево и видно то же, что видит робот без JS. Если ответ выглядит пустым без скриптов, страница переоткрывается в браузере. Управление возвращается сразу, обход идёт фоном: следить через action: status. По умолчанию уважает robots.txt, держит паузу между запросами и не выходит за пределы хоста. Контекст браузера пересоздаётся каждые 25 страниц — на длинных обходах он течёт. Прерванный обход продолжается через action: resume.',
      en: 'Each page is fetched with a plain HTTP request — cheap, and it shows what a crawler without JS sees. If the response looks empty without scripts, the page is reopened in a browser. Control returns immediately and the crawl runs in the background: follow it with action: status. By default it respects robots.txt, keeps a delay between requests and stays within the host. The browser context is recreated every 25 pages — it leaks on long crawls. An interrupted crawl continues with action: resume.',
    }),
  seo_report: () =>
    t({
      ru: 'Адреса, объявленные в canonical и hreflang, но лежащие вне обхода, проверяются отдельными одиночными запросами — иначе про них нечего сказать. Отдельно сводится то, что НЕ проверялось, и это три разные причины, которые нельзя смешивать: закрытое robots.txt — находка, упёршийся лимит — повод перезапустить обход шире, неудачный запрос — возможная поломка сайта. Рядом с примерами лежит counts с полными числами.',
      en: 'Addresses declared in canonical and hreflang but lying outside the crawl are checked with separate single requests — otherwise there is nothing to say about them. What was NOT checked is summarized separately, and those are three different reasons that must not be mixed: blocked by robots.txt is a finding, hitting a limit is a reason to re-run the crawl wider, a failed request may be a broken site. counts sits next to the examples with the full numbers.',
    }),
  browser_profile: () =>
    t({
      ru: 'Профиль снимается с живой сессии, а не описывается заново: тогда ему не нужна своя схема условий. Порядок: browser_open с нужными условиями, убедиться, что страница отрисовалась как надо, затем action: save. Пароли и заголовки в профиль не пишутся — файл лежит в томе и читается глазами. Логин переносят через storageState, его имя профиль хранит. persist: true записывает профиль на диск; без него он живёт в памяти процесса.',
      en: 'A profile is captured from a live session rather than described from scratch: that way it needs no condition schema of its own. The order: browser_open with the conditions you need, check the page renders as expected, then action: save. Passwords and headers are never written into a profile — the file sits in a volume and gets read by humans. Carry a login through storageState, whose name a profile does keep. persist: true writes the profile to disk; without it the profile lives in process memory.',
    }),
  screenshot: () =>
    t({
      ru: 'hide убирает элементы из кадра целиком, mask закрашивает область — первое для баннеров и чатов, второе для мест с меняющимся содержимым. isolate оставляет в кадре только перечисленное: так показывают наложение двух блоков. inline: true вкладывает уменьшенную копию прямо в ответ; без него возвращается только адрес артефакта.',
      en: 'hide removes elements from the frame entirely, mask paints over a region — the first for banners and chat widgets, the second for areas with changing content. isolate keeps only what is listed in the frame: that is how you show two blocks overlapping. inline: true embeds a downscaled copy right in the response; without it only the artifact address comes back.',
    }),
});

export function register(server) {
  server.registerTool(
    'help',
    {
      title: t({ ru: 'Подробности о стенде', en: 'Stand reference' }),
      description: t({
        ru: 'Подробности, которых в описаниях инструментов нет намеренно: как адресовать цели из контейнера, чем отличаются url и internalUrl, как задавать редкие условия просмотра, какие действуют потолки на объём ответов, сколько живёт сессия, в каком порядке разбирать типовую задачу. Без аргументов перечисляет темы. tool: имя — оговорки конкретного инструмента.',
        en: "Details deliberately left out of tool descriptions: how to address targets from inside the container, how url differs from internalUrl, how to set rare viewing conditions, what response size caps apply, how long a session lives, in what order to work through a typical task. With no arguments it lists the topics. tool: name gives the caveats of one tool.",
      }),
      inputSchema: {
        topic: z.enum(Object.keys(TOPICS)).optional().describe(d('Тема. Без аргументов — список тем')),
        tool: z.string().optional().describe(d('Имя инструмента: оговорки и нюансы именно его')),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ topic, tool }) => {
      if (tool) {
        const detail = DETAILS[tool];
        if (!detail) {
          return json({
            tool,
            detail: null,
            note: t({
              ru: `Отдельных оговорок у этого инструмента нет — существенное в его описании. Общие темы: ${Object.keys(TOPICS).join(', ')}`,
              en: `This tool has no separate caveats — the essentials are in its description. General topics: ${Object.keys(TOPICS).join(', ')}`,
            }),
          });
        }
        return text(detail());
      }

      if (topic) {
        const entry = TOPICS[topic];
        return text(`${entry.title}\n\n${entry.body()}`);
      }

      return json({
        topics: Object.entries(TOPICS).map(([name, entry]) => ({ topic: name, about: entry.title })),
        tools: Object.keys(DETAILS),
        note: t({
          ru: 'topic — общее устройство стенда, tool — оговорки конкретного инструмента.',
          en: 'topic covers how the stand works, tool covers one tool caveats.',
        }),
      });
    },
  );
}
