/**
 * Переводы описаний параметров.
 *
 * Здесь словарь, а не перевод по месту — в отличие от заголовков и описаний инструментов.
 * Причина в повторах: «Убрать с кадра: cookie-баннеры, чаты, всплывашки» встречается в пяти
 * инструментах, и при переводе по месту пять копий разъедутся на первой же правке, причём
 * молча. Уникальных строк тут сто с лишним, сверять их потом построчно никто не станет.
 *
 * Ключ — русский текст как он написан в коде. Выглядит непривычно, зато на месте вызова видно
 * ровно то, что там и было: d('Движок браузера') читается без похода в словарь.
 *
 * Недостающий перевод не молчит, а всплывает тестом i18n-coverage: пропущенная строка означает
 * английское описание с русским текстом внутри, и заметить это иначе нельзя.
 */
import { LANG } from './i18n.js';

const EN = {
  'auto (по умолчанию) определяет по расширению': 'auto (default) decides by file extension',
  'auto (по умолчанию) поднимает браузер только для страниц, пустых без JS':
    'auto (default) starts a browser only for pages that look empty without JS',
  'block — не давать Service Worker подменять ответы своим кэшем':
    'block — stop the Service Worker from serving its own cache instead of the server',
  'CSS-селектор': 'CSS selector',
  'DPR: 1, 2, 3': 'Device pixel ratio: 1, 2, 3',
  'Glob (**/analytics/**) или регулярное выражение в виде /…/flags':
    'A glob (**/analytics/**) or a regular expression written as /…/flags',
  'HTTP basic auth «пользователь:пароль»': 'HTTP basic auth as "user:password"',
  'HTTP basic auth в виде "пользователь:пароль"': 'HTTP basic auth as "user:password"',
  'HTTP basic auth в виде "пользователь:пароль". Логин в самом URL не нужен — он потом лезет во все ответы':
    'HTTP basic auth as "user:password". Do not put credentials in the URL itself — they leak into every response afterwards',
  'strip (по умолчанию) вырезает скрипты: на копии аналитика стучит в сеть, а роутер SPA подменяет страницу. JSON-LD остаётся в любом случае':
    'strip (default) removes scripts: on a local copy analytics would call home and an SPA router would replace the page. JSON-LD is kept either way',
  'true — только те, что пришлось открывать в браузере': 'true — only pages that had to be opened in a browser',
  'true (по умолчанию) — только тот же хост; false пускает на поддомены':
    'true (default) — same host only; false also allows subdomains',
  'block — оборвать, fulfill — отдать body, file — отдать файл стенда, redirect — увести все совпадения на один url, rewrite — заменить кусок адреса, сохранив путь':
    'block — abort, fulfill — return a body, file — serve a file from the stand, redirect — send every match to one url, rewrite — replace part of the address while keeping the path',
  'Для rewrite: что заменить в адресе. Подстрока или регулярное выражение в виде /…/flags. Например /^https?:\\/\\/site\\.ru/':
    'For rewrite: what to replace in the address. A substring or a regular expression written as /…/flags, e.g. /^https?:\\/\\/site\\.ru/',
  'Оставить в кадре только эти элементы, остальных соседей убрать из потока (display: none). Так снимают пару соседних блоков без остальных — например, чтобы показать наложение':
    'Keep only these elements in frame and take the remaining siblings out of flow (display: none). This is how a pair of adjacent blocks is captured without the rest — to show an overlap, for instance',
  'Абзац-введение под заголовком': 'An intro paragraph under the title',
  'Адрес, относительно которого разрешать ссылки в html или file. Без него относительные адреса и саморефренс canonical не посчитать':
    'The address to resolve links against for html or file input. Without it relative URLs and canonical self-reference cannot be computed',
  'Блок, который снимаем': 'The block being captured',
  'Варианты по порядку появления в документе': 'Variants in the order they appear in the document',
  'Вложить уменьшенную картинку в ответ': 'Attach a downscaled image to the answer',
  'Все совпадения селектора, а не только первое': 'All matches of the selector, not just the first one',
  'Глубина от стартовой страницы. По умолчанию 5': 'Depth from the starting page. Default 5',
  'Движок браузера': 'Browser engine',
  'Для rewrite: чем заменить. В регулярном выражении работают $1, $2':
    'For rewrite: the replacement. $1, $2 work with a regular expression',
  'Для какого агента показывать правила': 'Which user agent to show the rules for',
  'Допуск по размеру в пикселях, по умолчанию 2': 'Size tolerance in pixels, default 2',
  'Допустимое расхождение в процентах пикселей': 'Allowed difference as a percentage of pixels',
  'Заголовки ко всем запросам: Accept-Language, X-Forwarded-Proto и прочее':
    'Headers added to every request: Accept-Language, X-Forwarded-Proto and so on',
  'Заголовок карточки': 'Card title',
  'Заморозить Date и Math.random для стабильных снимков': 'Freeze Date and Math.random for stable screenshots',
  'Значение для set. Для cookies — JSON: объект или массив куки':
    'Value for set. For cookies — JSON: a cookie object or an array of them',
  'Имя каталога в архиве. По умолчанию берётся из хоста': 'Directory name in the archive. Taken from the host by default',
  'Имя обхода. По умолчанию из хоста': 'Crawl name. Taken from the host by default',
  'Имя прогона; используется в именах файлов и эталонов': 'Run name; used in file and baseline names',
  'Имя сохранённого логина из browser_storage — для закрытых разделов':
    'Name of a login saved with browser_storage — for sections behind auth',
  'Имя сохранённого состояния из browser_storage: сессия откроется уже залогиненной':
    'Name of a state saved with browser_storage: the session opens already logged in',
  'Имя эталона': 'Baseline name',
  'Интересующие свойства, например ["z-index","position"]. Без них показываются только конфликты':
    'Properties of interest, e.g. ["z-index","position"]. Without them only conflicts are shown',
  'Искать подстроку в видимом тексте сохранённых страниц': 'Search for a substring in the visible text of stored pages',
  'Какие CSS-свойства сверять': 'Which CSS properties to compare',
  'Какие поля вернуть. Без них возвращаются все': 'Which fields to return. All of them by default',
  'Какой атрибут снять с найденных узлов': 'Which attribute to read off the matched nodes',
  'Качество jpeg и webp, 1–100 (по умолчанию 80)': 'Quality for jpeg and webp, 1–100 (default 80)',
  'Ключ для set в local и session; имя файла для export и import':
    'Key for set in local and session; file name for export and import',
  'Код ответа, например 404': 'Response status code, e.g. 404',
  'Куда увести запрос при redirect': 'Where to send the request for redirect',
  'Любой адрес сайта — robots.txt и sitemap.xml берутся от его корня':
    'Any address on the site — robots.txt and sitemap.xml are taken from its root',
  'Масштаб страницы в процентах: 200 сжимает viewport вдвое':
    'Page zoom in percent: 200 halves the viewport',
  'Масштаб только шрифта в процентах (WCAG 1.4.4)': 'Text-only zoom in percent (WCAG 1.4.4)',
  'Метка патча: повторное добавление с тем же id заменяет прежний':
    'Patch label: adding again with the same id replaces the previous one',
  'Минимальный размер тач-таргета, px (по умолчанию 24)': 'Minimum tap target size in px (default 24)',
  'Например http://node_myapp:6006': 'For example http://node_myapp:6006',
  'Например wcag2aa, wcag21aa, best-practice': 'For example wcag2aa, wcag21aa, best-practice',
  'Не больше стольких слов — так ищут тонкий контент': 'No more than this many words — that is how thin content is found',
  'Не нужен только для action: list': 'Not required only for action: list',
  'Образец — обычно макет': 'The reference side — usually the mockup',
  'Обход, по которому строить отчёт. Список — crawl с action: list':
    'The crawl to build the report from. List them with crawl, action: list',
  'Оставить в кадре только эти элементы (display: none остальным соседям)':
    'Keep only these elements in frame (display: none for the remaining siblings)',
  'Оставить в кадре только это — например блок и его соседа, чтобы показать наложение':
    'Keep only this in frame — for example a block and its neighbour, to show an overlap',
  'Открыть свою одноразовую сессию по адресу': 'Open a throwaway session at this address',
  'Открыть свою одноразовую сессию по адресу и сохранить её': 'Open a throwaway session at this address and save it',
  'Откуда начинать. Нужен для start': 'Where to start. Required for start',
  'Пауза между запросами. По умолчанию 500': 'Pause between requests. Default 500',
  'Перезаписать эталон текущим снимком': 'Overwrite the baseline with the current shot',
  'По умолчанию 50': 'Default 50',
  'По умолчанию 500': 'Default 500',
  'По умолчанию add': 'Default add',
  'По умолчанию all': 'Default all',
  'По умолчанию desktop': 'Default desktop',
  'По умолчанию get': 'Default get',
  'По умолчанию png': 'Default png',
  'По умолчанию start': 'Default start',
  'По умолчанию true. Отключать только для своих стендов — факт отключения попадёт в отчёт':
    'Default true. Turn it off only for your own environments — the fact that it was off goes into the report',
  'Подключить таблицу стилей по URL': 'Attach a stylesheet by URL',
  'Подмена разрешения имён: {"www.site.local": "172.20.0.5"} — для стендов за vhost. Только chromium':
    'Name resolution override: {"www.site.local": "172.20.0.5"} — for environments behind a vhost. Chromium only',
  'Подписи вида «Расположение: Горизонтальное»': 'Captions such as "Layout: horizontal"',
  'Подробности только по этим категориям. Счётчики по всем возвращаются всегда':
    'Details for these categories only. Counters for all of them are always returned',
  'Порог тонкого содержимого в словах, по умолчанию 200': 'Thin content threshold in words, default 200',
  'Проверить эти адреса на запрет в robots.txt': 'Check these addresses against robots.txt',
  'Проверяемая страница': 'The page under test',
  'Проверять ли одиночными запросами адреса вне обхода: canonical и hreflang наружу. По умолчанию да':
    'Whether to verify addresses outside the crawl with one-off requests: canonical and hreflang pointing away. Default yes',
  'Псевдолокализация: диакритика и +40% длины строк': 'Pseudo-localization: diacritics and +40% string length',
  'Пути относительно рабочего каталога, глоб поддерживается':
    'Paths relative to the working directory; globs are supported',
  'Путь относительно каталога артефактов': 'Path relative to the artifacts directory',
  'Путь относительно рабочего каталога стенда': 'Path relative to the stand working directory',
  'Разбирать псевдоэлемент, а не сам элемент': 'Inspect the pseudo-element instead of the element itself',
  'Развернуть страницу справа налево': 'Flip the page to right-to-left',
  'Разобрать переданную разметку без браузера': 'Parse the markup passed inline, without a browser',
  'Разобрать сохранённый файл: путь относительно рабочего каталога стенда':
    'Parse a saved file: a path relative to the stand working directory',
  'Разобрать страницу открытой сессии — как она выглядит сейчас, после логина и раскрытых меню':
    'Parse the page of an open session as it looks right now, after a login and with menus expanded',
  'Регулярное выражение по id и заголовку истории': 'A regular expression over story id and title',
  'Регулярное выражение: брать только совпавшие адреса': 'Regular expression: take only matching addresses',
  'Регулярное выражение: пропускать совпавшие адреса': 'Regular expression: skip matching addresses',
  'Режим высокой контрастности Windows': 'Windows high contrast mode',
  'Сверить карту сайта с готовым обходом': 'Reconcile the sitemap against a finished crawl',
  'Сгруппировать и показать только группы больше одной страницы — то есть дубли':
    'Group and show only groups larger than one page — that is, duplicates',
  'Селекторы нестабильных зон — закрашиваются': 'Selectors of unstable areas — they get painted over',
  'Сколько комбинаций гнать параллельно (по умолчанию 2)': 'How many combinations to run in parallel (default 2)',
  'Сколько примеров показывать в каждой категории (по умолчанию 50)':
    'How many examples to show per category (default 50)',
  'Сколько страниц показать подробно. По умолчанию 50': 'How many pages to show in detail. Default 50',
  'Скрипт, выполняется при добавлении и после каждой навигации':
    'A script, executed on add and after every navigation',
  'Смотреть псевдоэлемент, а не сам элемент': 'Look at the pseudo-element instead of the element itself',
  'Снять только этот элемент': 'Capture only this element',
  'Сохранить страницу в локальное зеркало сразу после перехода — дальше её можно разбирать, не трогая чужой сервер':
    'Save the page into the local mirror right after navigating — after that it can be examined without touching the remote server',
  'Сохранить текущую страницу сессии': 'Save the current page of the session',
  'Сохранять ли сырой ответ сервера отдельным файлом. По умолчанию да':
    'Whether to keep the raw server response as a separate file. Default yes',
  'Сравнивать каждую историю с эталоном': 'Compare every story against a baseline',
  'Сравнивать только этот блок': 'Compare only this block',
  'Страница, с которой снимать': 'The page to capture from',
  'Страницы, где этих полей нет': 'Pages where these fields are missing',
  'Таймаут навигации, мс': 'Navigation timeout, ms',
  'Текст CSS': 'CSS text',
  'Только записи после последнего перехода. По умолчанию true':
    'Only entries after the last navigation. Default true',
  'Имя сохранённого профиля условий: остальные условия берутся из него. Список — в stand_info':
    'Name of a saved condition profile: the remaining conditions are taken from it. See stand_info for the list',
  'По умолчанию list': 'Default list',
  'Какой эталон удалить — для delete': 'Which baseline to delete — for delete',
  'Для prune: старше скольких дней удалять. По умолчанию 90':
    'For prune: delete baselines older than this many days. Default 90',
  'delete и prune по умолчанию только показывают, что будет удалено. apply: true выполняет':
    'delete and prune only show what would be removed; apply: true actually removes it',
  'Тема. Без аргументов — список тем': 'Topic. With no arguments, lists the topics',
  'Имя инструмента: оговорки и нюансы именно его':
    'Tool name: the caveats and details specific to it',
  'Сессия, с которой снимаются условия — нужен для save':
    'The session whose conditions are captured — required for save',
  'Имя профиля — нужно для save и remove': 'Profile name — required for save and remove',
  'Записать профиль на диск, чтобы он пережил перезапуск стенда. По умолчанию профиль живёт в памяти процесса':
    'Write the profile to disk so it survives a stand restart. By default a profile lives in process memory only',
  'Сколько записей каждого вида показать; берутся последние. По умолчанию 100':
    'How many entries of each kind to return; the most recent ones. Default 100',
  'С какого символа читать текст, если файл не поместился целиком':
    'Character offset to read the text from, when the file did not fit in one response',
  'С какого символа читать, если файл не поместился целиком':
    'Character offset to read from, when the file did not fit in one response',
  'Пропустить столько страниц с попаданиями — чтобы дойти до тех, что дальше первой выдачи':
    'Skip this many matching pages, to reach the ones beyond the first batch',
  'Только ссылки, кнопки и поля': 'Links, buttons and form fields only',
  'Требуемый контраст обычного текста (по умолчанию 4.5)': 'Required contrast for normal text (default 4.5)',
  'Троттлинг (только chromium): network 3g|slow-3g|4g, cpu — множитель замедления':
    'Throttling (chromium only): network 3g|slow-3g|4g, cpu is a slowdown multiplier',
  'Тянуть ли CSS, картинки и шрифты. По умолчанию да': 'Whether to fetch CSS, images and fonts. Default yes',
  'Тянуть ли ресурсы для зеркала. По умолчанию да': 'Whether to fetch resources for the mirror. Default yes',
  'Убрать с кадра: cookie-баннеры, чаты, всплывашки': 'Remove from frame: cookie banners, chat widgets, popups',
  'Убрать с кадра: cookie-баннеры, чаты, всплывашки. Ставит visibility: hidden, layout не едет':
    'Remove from frame: cookie banners, chat widgets, popups. Uses visibility: hidden, so layout does not shift',
  'Уменьшить до этой ширины — для вставки в документы': 'Downscale to this width — for embedding into documents',
  'Формат вшитых картинок, по умолчанию webp': 'Format of the embedded images, default webp',
  'Чего ждать при переходе. Для тяжёлых боевых сайтов — domcontentloaded':
    'What to wait for on navigation. For heavy production sites use domcontentloaded',
  'Что проверяем — обычно собранная страница': 'The side under test — usually the built page',
  'Что считаем образцом — обычно макет': 'What counts as the reference — usually the mockup',
  'Ширина вшитых картинок, по умолчанию 1000': 'Width of the embedded images, default 1000',
  'Ширины: имена пресетов или WxH. По умолчанию ["desktop","mobile"]':
    'Widths: preset names or WxH. Default ["desktop","mobile"]',
  'allow не глушит движение: переходы и анимации остаются живыми':
    'allow leaves the motion alone: transitions and animations keep running',
  'Своя строка User-Agent: часть сайтов отдаёт headless-браузеру 403':
    'A User-Agent string of your own: some sites answer a headless browser with 403',
  'Не нужен для scroll, для dialog и для press с кликом по координатам':
    'Not required for scroll, for dialog, and for press or a click by coordinates',
  'Текст для fill, клавиша для press, значение для select, accept | dismiss | текст ответа для dialog':
    'Text for fill, key for press, option value for select, accept | dismiss | reply text for dialog',
  'Для upload: пути к файлам относительно рабочего каталога стенда':
    'For upload: file paths relative to the stand working directory',
  'Смещение прокрутки по горизонтали; для click без селектора — координата':
    'Horizontal scroll amount; for a click without a selector, the x coordinate',
  'Смещение прокрутки по вертикали; для click без селектора — координата':
    'Vertical scroll amount; for a click without a selector, the y coordinate',
  'Сколько ждать элемент, мс. По умолчанию 30000': 'How long to wait for the element, ms. Default 30000',
  'Кликнуть, не дожидаясь кликабельности: элемент под pointer-events: none иначе ждёт весь таймаут':
    'Click without waiting for the element to be actionable: under pointer-events: none it otherwise waits out the whole timeout',
  'По умолчанию add. requests — что записали правила с record':
    'Default add. requests returns what the rules with record captured',
  'Записывать совпавшие запросы: метод, адрес, заголовки и тело. У multipart — состав полей и имена файлов':
    'Capture matching requests: method, address, headers and body. For multipart — the field list and file names',
  'Для requests: показать записи только этого правила': 'For requests: show the entries of this rule only',
  'Для requests: сколько последних записей показать. По умолчанию 20':
    'For requests: how many of the most recent entries to show. Default 20',
  'Разово, на этот переход: allow не глушит движение на странице':
    'One-off, for this navigation only: allow leaves the page motion alone',
  'Разбирать только эти блоки — шапка и подвал иначе набивают счётчики своими находками':
    'Inspect only these blocks — the header and the footer otherwise pad the counters with their own findings',
  'Не разбирать эти блоки': 'Skip these blocks',
  'Страница целиком, а не видимая область. По умолчанию true':
    'The whole page rather than the visible area. Default true',
  'Снять прямоугольник страницы в CSS-пикселях — когда подходящего элемента для selector нет':
    'Capture a rectangle of the page in CSS pixels — when there is no element a selector could target',
};

/**
 * Описание параметра на текущем языке.
 *
 * Русский текст остаётся аргументом и в русском режиме возвращается как есть — словарь нужен
 * только для второго языка. Отсутствие перевода не роняет вызов: лучше русская строка в
 * английском описании, чем упавший сервер.
 */
export function d(ru) {
  return LANG === 'ru' ? ru : EN[ru] ?? ru;
}

/** Для теста полноты: какие строки словарь знает. */
export const KNOWN = EN;
