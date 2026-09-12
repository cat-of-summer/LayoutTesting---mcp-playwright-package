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
        ru: `Полный набор условий объявлен в одном месте — browser_open. Их двадцать один: движок, размер, тема, forced-colors, reduced-motion, движение (animations), RTL, zoom страницы, zoom шрифта, псевдолокализация, DPR, локаль, таймзона, User-Agent, заморозка времени, троттлинг сети и CPU, basic-auth, заголовки, подмена разрешения имён, сохранённый логин, Service Workers.

Инструменты, открывающие сессию сами (audit, web_vitals, seo_page, page_save, storybook_audit), принимают три самых частых параметра прямо — browser, viewport, colorScheme, — а остальные по имени профиля.

Порядок работы: browser_open с нужными условиями, убедиться, что страница отрисовалась как надо, затем browser_profile с action: save. Дальше profile: "имя" в любом из этих инструментов.

Профиль живёт в памяти процесса; persist: true записывает его на диск, чтобы он пережил перезапуск. Пароли и заголовки в профиль не пишутся — логин переносят через storageState, его имя профиль хранит.

zoom стоит понимать буквально: увеличение страницы уменьшает область просмотра в CSS-пикселях, ровно как в браузере. zoom: 200 при desktop даёт 720x450, и это же попадает в имя эталона.

Про движки. chromium умеет всё: троттлинг, подмену разрешения имён, matched_rules — они идут через CDP, которого у остальных нет. У firefox и webkit в стенде нет WebGL, поэтому приложения, которые его требуют (тот же редактор Figma), в них не откроются. Часть боевых сайтов отдаёт headless-браузеру 403 ещё на CDN — помогает своя строка userAgent.`,
        en: `The full set of conditions is declared in exactly one place — browser_open. There are twenty-one: engine, size, color scheme, forced-colors, reduced-motion, motion (animations), RTL, page zoom, text zoom, pseudo-localization, DPR, locale, timezone, User-Agent, frozen time, network and CPU throttling, basic auth, headers, host resolution override, saved login, Service Workers.

Tools that open a session themselves (audit, web_vitals, seo_page, page_save, storybook_audit) take the three most frequent parameters directly — browser, viewport, colorScheme — and the rest by profile name.

The order of work: browser_open with the conditions you need, check the page renders as expected, then browser_profile with action: save. After that, profile: "name" in any of those tools.

A profile lives in process memory; persist: true writes it to disk so it survives a restart. Passwords and headers are never written into a profile — carry a login through storageState, whose name a profile does keep.

Take zoom literally: magnifying the page shrinks the viewport in CSS pixels, exactly as a browser does. zoom: 200 on desktop gives 720x450, and that is what goes into the baseline name.

About the engines. chromium can do everything: throttling, host resolution override, matched_rules — those go through CDP, which the others do not have. firefox and webkit in this stand have no WebGL, so applications that require it (the Figma editor, for one) will not open in them. Some production sites answer a headless browser with 403 at the CDN — a userAgent string of your own is what helps.`,
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

const FIGMA_TOPIC = {
  figma: {
    title: t({ ru: 'Как верстать по макету', en: 'How to build from a design' }),
    body: () =>
      t({
        ru: `Правила, по которым разбирается макет. Инструменты считают, решение принимает агент.

Порядок и бюджет. Сначала figma_status, потом figma_sync со всеми кадрами задачи одним вызовом — десктоп, мобильная, модалки. Дальше разбор идёт по снимку и в Figma не ходит. Рендерить кадр целиком незачем: высокие кадры приходят частями, а структуру читают figma_structure и figma_inspect.

Группировка. Инстансы одного компонента — один блок, модификаторы из свойств варианта. Непривязанные блоки одинакового состава — тоже один блок: цвет, радиус, отступы и кегль становятся осями модификаторов, а не поводом завести второй класс. Разовый элемент компонентом не делают. То, что попало в drift, — расхождение в макете (пара пикселей, полтона): его сводят к одному значению, а не переносят в вёрстку.

Токены. Токеном становится значение, привязанное к переменной Figma, встречающееся не один раз или уже существующее в проекте. Поле unbound говорит, сколько раз то же значение вбито литералом при живой переменной, — это и есть работа, которую выносят в токен. Разовый отступ токеном не становится. То, что меняется по варианту, состоянию или ширине, — переменная компонента (.btn{--btn-bg} → .btn--ghost{--btn-bg:…}), а не новый глобальный токен.

Структура. Порядок DOM — это порядок чтения самой узкой вёрстки; перестановки на широких экранах делаются CSS, а не второй разметкой. Декор не попадает в поток (псевдоэлементы, absolute), фоновый прямоугольник становится фоном контейнера, контент не позиционируется абсолютно. Заметки notes показывают, где слои макета пришлось переставить, — это места, где вёрстка «по слоям» была бы неверной.

Брейкпоинты. Mobile-first. Линейно меняющиеся значения — clamp() (он уже посчитан), скачком меняющиеся — media-запрос. Между самым узким и самым широким кадром макетов нет: точку перелома проверяют прогоном layout_stress по ширинам, а не назначают по числу из макета. Замена элемента (select на десктопе, иконка на мобильной) — это два состояния одного блока, а не два блока.

Поведение. Что не описано связями прототипа, не выдумывают: unconfirmed уточняют у человека. Любая анимация уважает prefers-reduced-motion. Одинаковые связи — один обработчик, это видно по группировке.

Проверка. figma_compare по каждому брейкпоинту: расхождение до 1px и различия рендеринга шрифтов дефектом не считаются, а общий сдвиг блока читают как одну находку — сначала чинят высоту блока выше. Дальше layout_stress: длинный и пустой текст, слово без переносов, список из двенадцати, битая картинка, набор ширин. Вёрстка, не пережившая прогон, не готова, как бы точно она ни совпадала с макетом.`,
        en: `The rules the design is read by. The tools compute, the agent decides.

Order and budget. figma_status first, then figma_sync with every frame of the task in one call — desktop, mobile, modals. After that the analysis reads the snapshot and never calls Figma. Rendering a whole frame is pointless: tall frames come back in parts, and the structure is read by figma_structure and figma_inspect.

Grouping. Instances of one component are one block, with modifiers from the variant properties. Detached blocks of the same content are one block too: color, radius, padding and type size become modifier axes rather than a reason for a second class. A one-off element does not become a component. Whatever lands in drift is a discrepancy in the design (a pixel or two, half a tone): normalize it instead of carrying it into the markup.

Tokens. A value becomes a token when it is bound to a Figma variable, used more than once, or already exists in the project. The unbound field says how often the same value is hardcoded while a variable exists — that is the work a token removes. A one-off spacing does not become a token. Whatever changes by variant, state or width is a component variable (.btn{--btn-bg} → .btn--ghost{--btn-bg:…}), not a new global token.

Structure. DOM order is the reading order of the narrowest layout; rearranging on wide screens is done in CSS, not with a second markup. Decoration stays out of the flow (pseudo-elements, absolute), a background rectangle becomes the container background, content is never positioned absolutely. The notes show where the design layers had to be rearranged — exactly the places where building "by layers" would be wrong.

Breakpoints. Mobile-first. Linearly changing values become clamp() (already computed), values that jump become a media query. There are no frames between the narrowest and the widest: find the breaking point with a layout_stress width run rather than assigning a number from the design. A replaced element (a select on desktop, an icon on mobile) is two states of one block, not two blocks.

Behavior. What the prototype does not state is not invented: anything marked unconfirmed goes to the human. Any animation respects prefers-reduced-motion. Identical links are one handler — the grouping shows it.

Checking. figma_compare at every breakpoint: a difference up to 1px and font rendering differences are not defects, and a whole-block shift is one finding — fix the height of the block above first. Then layout_stress: long and empty text, a word with no break opportunities, a list of twelve, a broken image, a range of widths. Markup that does not survive that run is not done, however exactly it matches the design.`,
      }),
  },
};

Object.assign(TOPICS, MORE_TOPICS, FIGMA_TOPIC);

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
      ru: 'Правила переживают навигацию: заданные один раз, они действуют и после browser_goto. В action: list виден счётчик попаданий по каждому правилу — без него несработавшее правило не отличить от сработавшего, и это самая частая причина, по которой подмена кажется неприменившейся. Ошибка внутри обработчика записывается в lastError, а запрос всё равно пропускается: иначе он повис бы навсегда. record ортогонален обработчику: fulfill вместе с record отдаёт заглушку и записывает, что именно ушло на сервер. Записи читаются через action: requests — метод, адрес, заголовки и тело; у multipart перечисляются поля с их значениями и файлы с именем и типом. Содержимое файлов браузер в тело запроса не отдаёт вовсе, поэтому их размер там нулевой — об этом сказано отдельной заметкой, чтобы не читалось как «ушёл пустой файл». Cookie и Authorization в журнал не попадают, на правило держится последние полсотни запросов.',
      en: 'Routes survive navigation: set once, they keep working after browser_goto. action: list shows a hit counter per route — without it a route that never matched is indistinguishable from one that did, and that is the most common reason an override looks like it did not apply. An error inside a handler is recorded in lastError and the request is let through anyway: otherwise it would hang forever. record is orthogonal to the handler: fulfill together with record returns the stub and captures what actually went to the server. Read the captures with action: requests — method, address, headers and body; for multipart the fields are listed with their values and the files with name and type. The browser never puts file contents into the request body, so their size there is zero — a separate note says so, to keep it from reading as "an empty file was sent". Cookie and Authorization never reach the log, and each rule keeps the last fifty requests.',
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
      ru: 'fullPage по умолчанию true: снимается страница целиком, а не видимая область. На длинной мобильной странице это кадр в тысячи точек, и разбирать по нему нечего — берите selector для элемента или clip для прямоугольника в CSS-пикселях. hide убирает элементы из кадра целиком, mask закрашивает область — первое для баннеров и чатов, второе для мест с меняющимся содержимым. isolate оставляет в кадре только перечисленное: так показывают наложение двух блоков. inline: true вкладывает уменьшенную копию прямо в ответ; непропорционально высокий кадр при этом обрезается по верхней части, о чём сказано полем inlineNote, — оригинал остаётся по url артефакта.',
      en: 'fullPage defaults to true: the whole page is captured, not the visible area. On a long mobile page that is a frame thousands of pixels tall and nothing can be read off it — use selector for an element or clip for a rectangle in CSS pixels. hide removes elements from the frame entirely, mask paints over a region — the first for banners and chat widgets, the second for areas with changing content. isolate keeps only what is listed in the frame: that is how you show two blocks overlapping. inline: true embeds a downscaled copy right in the response; a disproportionately tall frame is cropped to its top part, which inlineNote states — the original stays at the artifact url.',
    }),
});


Object.assign(DETAILS, {
  browser_act: () =>
    t({
      ru: 'upload выбирает файлы: если под селектором input[type=file], файлы кладутся прямо в него — видимость при этом не нужна, а именно скрытый инпут за стилизованным label и встречается чаще всего. Под любым другим элементом (кнопка, скрепка) ловится системный диалог выбора, то есть проверяется и путь «клик → выбор файла». Пути — относительно рабочего каталога стенда. dialog задаёт, что делать со следующим alert, confirm и prompt: value accept, dismiss или текст ответа для prompt; сами диалоги пишутся в журнал всегда и читаются через page_logs с kind: dialogs. press без селектора нажимает клавишу на уровне страницы, click без селектора кликает по координатам x и y. force кликает, не дожидаясь кликабельности, timeout сокращает ожидание — под pointer-events: none элемент иначе ждёт все тридцать секунд. Если между вызовами страница перезагрузилась сама, в ответе появится navigatedSince: без него «модалка закрыта» после клика неотличимо от «клик не сработал».',
      en: 'upload picks files: when the selector points at an input[type=file], files go straight into it — visibility is not required, and a hidden input behind a styled label is exactly the common case. On any other element (a button, a paperclip) the native file chooser is intercepted, so the "click → pick a file" path is covered too. Paths are relative to the stand working directory. dialog sets what happens to the next alert, confirm and prompt: value accept, dismiss, or the reply text for a prompt; the dialogs themselves are always logged and read back with page_logs, kind: dialogs. press without a selector presses a key at page level, click without a selector clicks at the x and y coordinates. force clicks without waiting for actionability, timeout shortens the wait — under pointer-events: none an element otherwise waits out all thirty seconds. If the page reloaded itself between calls, the answer carries navigatedSince: without it "the modal is closed" after a click is indistinguishable from "the click did nothing".',
    }),
  browser_goto: () =>
    t({
      ru: 'Стабилизация останавливает переходы и анимации: без этого снимки и замеры пляшут между прогонами. Проверить саму анимацию в такой странице нельзя — через сто миллисекунд элемент уже в конечном состоянии. animations: "allow" возвращает движение: здесь на один переход, в browser_open на всю сессию. Заодно снимается reducedMotion: reduce, иначе аккуратно написанная страница глушит анимации сама медиа-запросом и переключатель выглядел бы сломанным. Остальная стабилизация остаётся: шрифты, ленивые картинки, блоки, появляющиеся по прокрутке, — она про полноту кадра, а не про движение. Для визуальной регрессии такую сессию использовать не надо: два прогона подряд дадут разные пиксели.',
      en: 'Stabilization stops transitions and animations: without it screenshots and measurements drift between runs. That also makes the animation itself impossible to check — a hundred milliseconds in, the element is already in its final state. animations: "allow" brings the motion back: here for one navigation, in browser_open for the whole session. It also lifts reducedMotion: reduce, since a well-written page mutes its own animations by media query and the switch would look broken. The rest of the stabilization stays — fonts, lazy images, blocks revealed on scroll — that part is about a complete frame, not about motion. Do not use such a session for visual regression: two consecutive runs will differ in pixels.',
    }),
  page_logs: () =>
    t({
      ru: 'Четыре вида записей: консоль, необработанные исключения, сетевые запросы и диалоги (alert, confirm, prompt) с их текстом и тем, как они были закрыты. Рядом с ошибками отдаётся resourceErrors — не доехавшие скрипты, стили и документы. Это отдельная категория потому, что именно она объясняет самый запутанный случай: страница отвечает 200 и выглядит целой, но её бандл ответил 404 после пересборки, JS на странице нет, клики «проходят» и ничего не делают, а необработанных исключений при этом не возникает. По умолчанию показывается только то, что случилось после последнего перехода; sinceNavigation: false отдаёт всё с открытия сессии. onlyProblems: false добавляет обычные записи консоли и удачные запросы.',
      en: 'Four kinds of entries: console, unhandled exceptions, network requests, and dialogs (alert, confirm, prompt) with their text and how they were closed. Next to the errors comes resourceErrors — scripts, stylesheets and documents that never arrived. It is a category of its own because it explains the most confusing case: the page answers 200 and looks whole, but its bundle returned 404 after a rebuild, there is no JS on the page, clicks "succeed" and do nothing, and no unhandled exception is raised at all. By default only what happened after the last navigation is shown; sinceNavigation: false returns everything since the session was opened. onlyProblems: false adds ordinary console entries and successful requests.',
    }),
  layout_audit: () =>
    t({
      ru: 'Счётчики возвращаются по всем категориям всегда, подробности — по тем, что перечислены в categories. include и exclude сужают саму область разбора, и вместе с подробностями уходят и числа: шапка с подвалом на странице те же, что вчера, и их мелкие тач-таргеты с низким контрастом перебивают собой то, ради чего разбор и затевали. Сужение видно в ответе полем scope — пустой отчёт по опечатке в селекторе иначе не отличить от пустого отчёта по здоровой странице. Горизонтальный скролл документа считается всегда по всей странице: это её свойство, а не свойство блока.',
      en: 'Counters come back for every category always, details only for those listed in categories. include and exclude narrow the inspected area itself, and the numbers narrow with the details: the header and the footer are the same as yesterday, and their small tap targets and low contrast drown out whatever the audit was actually for. The narrowing shows up in the answer as scope — otherwise an empty report caused by a typo in a selector is indistinguishable from an empty report on a healthy page. Document-level horizontal scroll is always measured across the whole page: it is a property of the page, not of a block.',
    }),
  validate_html: () =>
    t({
      ru: 'Разметка уходит в Nu HTML Checker — отдельный сервис, адрес которого задаётся в VNU_URL. Он стартует дольше остального стенда, и stand_info с «не ответил за 2 с» означает проверку живости, а не отсутствие валидатора в сборке. Вызывать инструмент можно в любом случае: при недоступном vnu он переключается на локальную проверку html-validate и честно пишет об этом полями source и fallbackReason. Наборы правил у них разные: html-validate строже к стилю разметки и мягче к тому, что считается ошибкой по спецификации.',
      en: 'The markup goes to the Nu HTML Checker — a separate service whose address is set by VNU_URL. It starts slower than the rest of the stand, so "no answer in 2s" in stand_info reports a liveness check, not a validator missing from the build. Call the tool either way: when vnu is unreachable it falls back to the local html-validate check and says so in the source and fallbackReason fields. Their rule sets differ: html-validate is stricter about markup style and softer about what counts as an error by the specification.',
    }),
});

Object.assign(DETAILS, {
  figma_status: () =>
    t({
      ru: 'Токен ищется в FIGMA_TOKEN, затем среди выпущенных стендом. Тип места Figma сообщает только заголовками ответов, поэтому до первого такого ответа лимиты считаются по Starter с местом Full: 10 запросов в минуту к файлам и рендерам (tier 1), 25 к комментариям и заливкам (tier 2), 50 к метаданным (tier 3). rateLimitType: low — место View или Collab: запросы к файлам и рендерам считаются в месяц, их двадцать, и каждый figma_sync и figma_export на счету. blockedUntil значит, что Figma уже отказала: повтор раньше этого времени отклоняется стендом сразу, не тратя попытку. Учёт переживает перезапуск стенда. Редактор: стенд входит сам по FIGMA_EMAIL и FIGMA_PASSWORD или берёт сохранённое состояние (FIGMA_STORAGE_STATE, по умолчанию figma-editor). state: ready — работает; needs_login — нечем войти или Figma отклонила пароль, это правит человек в .env; needs_human — капча, письмо или код 2FA: код спросите у человека и передайте в action: login с otp, остальное человек проходит сам, после чего снова action: login; blocked и error — канал отдыхает 5 минут, снимки тем временем идут через REST. Комментарии есть только в REST. Токен: без FIGMA_TOKEN стенд выпускает личный токен сам через настройки аккаунта — только scopes на чтение, на 90 дней, за два дня до конца срока перевыпускает и отзывает прежний. Выпуск случается лишь тогда, когда запросу действительно нужен REST, или по action: token; результат последней попытки — rest.lastIssue. FIGMA_TOKEN_AUTOISSUE=0 его запрещает.',
      en: 'The token is taken from FIGMA_TOKEN, then from the ones the stand issued. Figma reports the seat type only in response headers, so until the first such response the limits are counted as Starter with a Full seat: 10 requests a minute to files and renders (tier 1), 25 to comments and image fills (tier 2), 50 to metadata (tier 3). rateLimitType: low is a View or Collab seat: requests to files and renders are counted per month, there are twenty of them, and every figma_sync and figma_export counts. blockedUntil means Figma has already refused: the stand rejects a retry before that time straight away without spending an attempt. The accounting survives a stand restart. Editor: the stand logs in by itself with FIGMA_EMAIL and FIGMA_PASSWORD or uses a saved state (FIGMA_STORAGE_STATE, figma-editor by default). state: ready — working; needs_login — nothing to log in with or Figma rejected the password, a human fixes it in .env; needs_human — a captcha, an email or a 2FA code: ask the human for the code and pass it as action: login with otp, the rest the human goes through personally, then action: login again; blocked and error — the channel rests for 5 minutes while snapshots go through REST. Comments exist in REST only. Token: without FIGMA_TOKEN the stand issues a personal token itself through the account settings — read-only scopes, for 90 days, reissued two days before expiry with the previous one revoked. Issuing happens only when a request really needs REST, or on action: token; the outcome of the last attempt is rest.lastIssue. FIGMA_TOKEN_AUTOISSUE=0 forbids it.',
    }),
  figma_sync: () =>
    t({
      ru: 'Узлы одного файла уходят одним запросом /nodes, поэтому все кадры задачи — десктоп, мобильную, модалки — передают одним вызовом, а не по одному. Повторный вызов по тем же узлам берёт снимок из кэша; версия файла сверяется не чаще раза в 10 минут отдельным запросом tier 3, и если макет поменялся, узлы снимаются заново — ответ говорит об этом полем changed. Ссылка без node-id отдаёт список страниц и кадров верхнего уровня, а не весь файл: целиком он обычно огромен. Остальные figma_* докачивают недостающий узел сами, но по одному вызову на узел — дешевле снять всё сразу. Канал auto берёт редактор, если в него есть вход: запросов из лимита он не тратит, приносит значения переменных (поле variables у снимка) и, с css: true, CSS от самой Figma. Если редактор отказал, снимок идёт через REST, а причина лежит в editorFallback. Без токена REST версия файла неизвестна: снимок редактора получает версию local-… и перечитывается через 10 минут.',
      en: 'Nodes of one file go out in a single /nodes request, so pass every frame of the task — desktop, mobile, modals — in one call rather than one by one. A repeated call on the same nodes reads the snapshot from cache; the file version is checked at most once every 10 minutes with a separate tier 3 request, and if the design changed the nodes are pulled again — the changed field says so. A link without node-id returns the list of pages and top-level frames rather than the whole file: in full it is usually huge. The other figma_* tools fetch a missing node themselves, but one call per node — pulling everything at once is cheaper. The auto channel uses the editor if the stand can log into it: it spends nothing from the limit, brings variable values (the variables field of the snapshot) and, with css: true, the CSS computed by Figma itself. If the editor fails, the snapshot goes through REST and the reason is in editorFallback. Without a REST token the file version is unknown: an editor snapshot gets a local-… version and is re-read after 10 minutes.',
    }),
  figma_inspect: () =>
    t({
      ru: 'outline показывает детей auto-layout в порядке потока, остальных — сверху вниз и слева направо, а не в порядке слоёв: слои в макетах часто перепутаны. Координаты — от левого верхнего угла запрошенного узла. Подряд идущие соседи одной формы сворачиваются в строку «×N как id» с их текстами. Флаги: w:fill, h:hug — намерение размера; abs — абсолютный ребёнок auto-layout; →N — число взаимодействий прототипа; img — растровая заливка. css считается из снимка одинаково для REST и редактора: HUG не даёт размера, FILL превращается во flex или stretch, градиенты пересчитываются под пропорции блока. Значения — литералы; привязки к переменным Figma лежат рядом в поле vars. Узлы с тем же css и той же формой отдаются как sameAs с текстом.',
      en: 'outline lists auto-layout children in flow order and the rest top to bottom and left to right, not in layer order: layers in designs are often shuffled. Coordinates are from the top-left corner of the requested node. Consecutive siblings of the same shape collapse into one "×N как id" line with their texts. Flags: w:fill, h:hug — the sizing intent; abs — an absolute child of auto-layout; →N — the number of prototype interactions; img — a raster fill. css is computed from the snapshot the same way for REST and the editor: HUG gives no size, FILL becomes flex or stretch, gradients are recalculated for the box proportions. Values are literals; bindings to Figma variables sit next to them in vars. Nodes with the same css and shape come back as sameAs with their text.',
    }),
  figma_export: () =>
    t({
      ru: 'Рендер кэшируется по версии файла: повторная выгрузка того же узла в том же масштабе запросов не тратит. Кадр выше 2,2 своих ширин режется на части по 1,4 ширины с перекрытием 40 px, у каждой части указан отступ сверху в CSS-пикселях — так высокий мобильный кадр читается, а не приходит полосой шириной в сотню точек. svg: одноцветные иконки получают currentColor, id внутри файла получают префикс по имени, одинаковые файлы объединяются, а refs перечисляет, откуда каждый взят. image: заливка кадрируется так же, как в макете (FILL, FIT, CROP по imageTransform), и сохраняется в webp в 1x и 2x — исходник в Figma обычно в разы тяжелее. Рендеры и svg идут в tier 1, файлы заливок — в tier 2.',
      en: 'Renders are cached by file version: exporting the same node at the same scale again spends no requests. A frame taller than 2.2 of its widths is cut into parts of 1.4 widths with a 40 px overlap, each with its top offset in CSS pixels — so a tall mobile frame is readable instead of arriving as a strip a hundred pixels wide. svg: single-colour icons get currentColor, ids inside the file get a name prefix, identical files are merged, and refs lists where each one came from. image: the fill is cropped the same way as in the design (FILL, FIT, CROP by imageTransform) and saved as webp at 1x and 2x — the Figma source is usually several times heavier. Renders and svg go to tier 1, image fill files to tier 2.',
    }),
});

Object.assign(DETAILS, {
  figma_structure: () =>
    t({
      ru: 'Дерево строится по геометрии, а не по слоям: auto-layout берётся как есть, у обычного фрейма дети раскладываются заново — фон, декор, наложения выносятся из потока, остальное режется по зазорам на строки и колонки. Роли определяются по признакам: заголовок — по кеглю относительно основного текста (внутри кнопки и поля заголовков не бывает), кнопка — по составу и взаимодействиям, список — по трём и более одинаковым соседям. Классы в стиле BEM: блок начинает контейнер с осмысленным именем или компонент, остальное — элементы. Имена вида Frame 2131329404 игнорируются. notes — самое важное в ответе: там сказано, где слои переставлены и что стало фоном; slots показывает, что подменять в layout_stress.',
      en: 'The tree is built from geometry rather than layers: auto-layout is taken as is, while children of a plain frame are laid out again — background, decoration and overlays leave the flow, the rest is cut by gaps into rows and columns. Roles come from evidence: a heading from its size relative to body text (there are no headings inside a button or a field), a button from its content and interactions, a list from three or more identical siblings. Classes are BEM-shaped: a block starts at a container with a meaningful name or at a component, everything else is an element. Names like Frame 2131329404 are ignored. notes is the most important part of the answer: it says where layers were rearranged and what became a background; slots says what layout_stress should replace.',
    }),
  figma_components: () =>
    t({
      ru: 'Кластеры считаются по сигнатуре: роль плюс состав содержимого, без цветов и размеров — они становятся осями модификаторов. Градиенты сравниваются по цветам без угла: Figma пересчитывает угол под пропорции блока, и одна кнопка иначе разошлась бы на три варианта. drift — различия в пределах двух пикселей или ΔE 2: это не варианты, а расхождения макета. Блоки, различающиеся только суффиксом mobile или desktop, сводятся в один с пометкой responsive. project сверяет базовый набор свойств с правилами проекта: совпадение означает, что блок уже свёрстан.',
      en: 'Clusters are keyed by signature: role plus content composition, without colors and sizes — those become modifier axes. Gradients are compared by their colors without the angle: Figma recomputes the angle for the box proportions, and one button would otherwise split into three variants. drift is a difference within two pixels or ΔE 2: not a variant but a discrepancy in the design. Blocks differing only by a mobile or desktop suffix merge into one marked responsive. project matches the base property set against the project rules: a hit means the block is already built.',
    }),
  figma_tokens: () =>
    t({
      ru: 'Цвета сводятся по ΔE: неразличимые глазом становятся одним токеном, просто похожие отмечаются в similar — обычно это ошибка макета. Имя берётся из переменной или стиля Figma, а если их нет — из роли (text, bg, line) и частоты. unbound считает использования литералом при живой переменной. Компонентные переменные берутся из осей вариантов, высота в них не входит: её задаёт содержимое. responsive считается только по кадрам одного экрана и только для значений, меняющихся не в разы. Значение с одним использованием токеном не становится — это регулируется minUses.',
      en: 'Colors merge by ΔE: those the eye cannot tell apart become one token, merely similar ones are listed in similar — usually a mistake in the design. The name comes from the Figma variable or style, and without them from the role (text, bg, line) and frequency. unbound counts hardcoded uses while a variable exists. Component variables come from the variant axes, height excluded: content sets it. responsive is computed only across frames of one screen and only for values that do not change several-fold. A value used once does not become a token — minUses controls that.',
    }),
  figma_breakpoints: () =>
    t({
      ru: 'Сопоставление идёт по содержимому: текст по тексту, картинка по хэшу заливки, инстанс по компоненту, контейнер по составу сопоставленных детей. Повторы связываются по порядку сверху вниз, лишнее честно остаётся несопоставленным. Кадры, у которых мало общих текстов с базовым, в сравнение не берутся — это другой экран, а не другая ширина, и об этом говорит warning. clamp() считается по двум ширинам линейно; порядок чтения сверяется отдельно — расхождение значит, что одной разметкой не обойтись.',
      en: 'Matching goes by content: text by text, image by fill hash, instance by component, container by the set of matched children. Repeats are paired top to bottom, and the extra one honestly stays unmatched. Frames sharing few texts with the base are left out — that is another screen, not another width, and a warning says so. clamp() is computed linearly from the two widths; reading order is checked separately — a divergence means one markup will not do.',
    }),
  figma_comments: () =>
    t({
      ru: 'Только REST: у Plugin API доступа к комментариям нет, поэтому без токена инструмент не работает. Список кэшируется на пять минут — комментарии пишут во время работы. Привязка: прикреплённый к узлу показывается вместе с путём до него, поставленный точкой на холсте — через попадание точки в самый глубокий узел снятых кадров. Если узел не снят, об этом сказано прямо: снимите его figma_sync, иначе «поправить отступ» останется без адресата. Закрытые треды по умолчанию скрыты. Рядом отдаются аннотации Dev Mode и devStatus.',
      en: 'REST only: the Plugin API has no access to comments, so without a token the tool does not work. The list is cached for five minutes — comments are written while the work is going on. Anchoring: one attached to a node comes with the path to it, one placed as a point on the canvas resolves to the deepest node of the synced frames under it. If the node was not synced, the answer says so plainly: pull it with figma_sync, otherwise "fix the spacing" has no address. Resolved threads are hidden by default. Dev Mode annotations and devStatus come alongside.',
    }),
  figma_behavior: () =>
    t({
      ru: 'Источник — связи прототипа, а не имена слоёв. Одинаковые связи группируются: шесть шевронов, ведущих в один вариант, это один обработчик. У перехода считается готовая строка transition, у оверлея видно, закрывается ли он по клику снаружи. CHANGE_TO по наведению — это :hover, а не отдельный экран. Цели, которых нет в снятых кадрах, перечислены в notSynced: что это за экран, покажет figma_sync. Слои, похожие по имени на состояние, но ни с чем не связанные, лежат в unconfirmed — это вопрос человеку, а не факт.',
      en: 'The source is prototype links, not layer names. Identical links are grouped: six chevrons leading to one variant are one handler. Each transition comes with a ready transition line, and an overlay shows whether it closes on an outside click. CHANGE_TO on hover is :hover, not a separate screen. Targets missing from the synced frames are listed in notSynced: figma_sync will show what they are. Layers that look like a state by name but are wired to nothing sit in unconfirmed — a question for the human, not a fact.',
    }),
  figma_compare: () =>
    t({
      ru: 'Смысловое сравнение — основное: тексты сопоставляются по содержимому, и по каждому видно смещение, размер и расхождения типографики с селектором и id узла. Общий сдвиг блока сворачивается в одну находку: если страница короче макета, весь подвал уезжает на одно и то же число, и чинить надо высоту блока выше, а не двадцать элементов. Своя сессия открывается шириной кадра — сравнивать десктопный макет с мобильной вёрсткой бессмысленно. Попиксельное сравнение идёт вторым слоем: на нём разный контент и другой рендеринг шрифтов дают проценты, которые сами по себе ничего не значат.',
      en: 'The semantic comparison is the main one: texts are matched by content, and each shows its offset, size and typography differences with a selector and a node id. A whole-block shift collapses into one finding: if the page is shorter than the design, the entire footer moves by the same number, and what needs fixing is the height of the block above, not twenty elements. A session of its own opens at the frame width — comparing a desktop design with a mobile build is meaningless. The pixel diff is the second layer: different content and font rendering there produce percentages that mean nothing on their own.',
    }),
  layout_stress: () =>
    t({
      ru: 'Работает по живой сессии: подменяет содержимое, прогоняет проверки раскладки, возвращает страницу как было. Показывается только то, что появилось от подмены, — то, что ломалось и до неё, ищите обычным layout_audit. Без selectors стенд выбирает цели сам: тексты с собственным содержимым, списки из трёх и более одинаковых соседей, картинки. Сценарий widths меняет ширину окна и возвращает исходную; firstBreak — первая ширина, на которой вёрстка поехала. Главная категория здесь — boxOverflow: содержимое вылезло за свой блок или было им обрезано, и это не то же самое, что вылет за viewport.',
      en: 'Works on a live session: it replaces the content, runs the layout checks and puts the page back. Only what the replacement caused is shown — whatever was broken before it is found by a plain layout_audit. Without selectors the stand picks targets itself: texts with their own content, lists of three or more identical siblings, images. The widths scenario resizes the window and restores it; firstBreak is the first width where the layout broke. The key category here is boxOverflow: content escaped its own box or was clipped by it, which is not the same as leaving the viewport.',
    }),
});

/**
 * @param {object} ctx
 * @param {() => Set<string>|null} ctx.activeTools — состав поднятого; null снимает фильтр.
 *   Ленивый: на момент регистрации help часть инструментов ещё не зарегистрирована.
 */
export function register(server, { activeTools = () => null } = {}) {
  /* На сокращённом адресе help не должен рекламировать то, чего здесь нет: список инструментов
     он выдаёт до выбора, и имя из него агент попробует вызвать. Оговорки при этом остаются
     доступными по имени — знать, чем инструмент отличается, полезно и до того, как его подняли. */
  const isActive = (name) => {
    const active = activeTools();
    return !active || active.has(name);
  };

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
        if (!isActive(tool)) {
          /* Отвечаем оговорками и сразу говорим, что вызвать инструмент здесь не выйдет: иначе
             агент прочитает подробности и упрётся в «нет такого инструмента» уже в вызове. */
          return json({
            tool,
            active: false,
            detail: detail(),
            note: t({
              ru: `Инструмент у стенда есть, но на этом подключении не поднят. Полный набор — подключение к /mcp; какие группы активны здесь, показывает stand_info.`,
              en: `The stand has this tool, but it is not exposed on this connection. The full set is at /mcp; stand_info shows which groups are active here.`,
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
        tools: Object.keys(DETAILS).filter(isActive),
        note: t({
          ru: 'topic — общее устройство стенда, tool — оговорки конкретного инструмента.',
          en: 'topic covers how the stand works, tool covers one tool caveats.',
        }),
      });
    },
  );
}
