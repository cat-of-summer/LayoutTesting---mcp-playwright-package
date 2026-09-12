/**
 * Словарь групп инструментов и разбор выборки.
 *
 * Поверхность стенда выбирает тот, кто подключается, а не тот, кто поднял контейнер: набор
 * называется в адресе подключения (/mcp/seo+crawl), а не переменной окружения с перезапуском.
 * Одна поднятая копия обслуживает и верстальщика с Figma, и SEO-шника — у каждого свой манифест
 * и свои instructions, а браузеры, артефакты и эталоны общие, потому что процесс один.
 *
 * Словарь здесь один на всё: по нему собирается сервер, режутся instructions, фильтруется help
 * и отвечает stand_info. Второго списка групп в проекте быть не должно — разъедется молча.
 */

/** Группы, которые можно назвать в адресе. Совпадают с файлами в этом каталоге. */
export const GROUPS = [
  'session',
  'observe',
  'layout',
  'visual',
  'figma',
  'a11y',
  'perf',
  'seo',
  'static',
  'composite',
  'crawl',
];

/**
 * Поднимаются всегда, какую бы выборку ни назвали.
 *
 * stand_info — единственное, чем агент может выяснить, какой набор активен и как получить
 * остальное; help объясняет то, что намеренно вынуто из описаний. Без них сокращённая поверхность
 * выглядит как сломанный стенд, а не как выбранная.
 */
export const FLOOR = ['artifacts', 'help'];

/**
 * Чем группа бесполезна в одиночку.
 *
 * Выведено из схем, а не назначено по смыслу: layout, visual, observe и a11y объявляют sessionId
 * обязательным параметром — без группы session у них нечего спросить. figma тянет ещё и visual,
 * потому что figma_compare сверяет макет с живой страницей и складывает снимки.
 *
 * crawl, perf и composite не перечислены намеренно: они работают по адресу и сессию открывают
 * сами. seo и static принимают sessionId необязательным и без него тоже работают.
 */
export const DEPS = {
  layout: ['session'],
  visual: ['session'],
  observe: ['session'],
  a11y: ['session'],
  figma: ['session', 'visual'],
};

/**
 * Короткая запись частых сумм. Не «наборы, решённые за всех»: псевдоним разворачивается в те же
 * группы, и stand_info всегда показывает развёрнутый состав, а не ярлык.
 */
export const ALIASES = {
  core: 'session+observe+layout+visual+a11y+static+composite',
  minimal: 'session+observe+layout+composite',
  design: 'core+figma',
};

/** Полная выборка: groups === null означает «ничего не фильтруем». */
const FULL = Object.freeze({
  groups: null,
  requested: ['all'],
  added: [],
  unknown: [],
  key: 'all',
});

function expand(names, seen, out, unknown) {
  for (const name of names) {
    if (!name) continue;
    if (ALIASES[name]) {
      /* Псевдоним, названный дважды (core+design), разворачивается один раз. Заодно это защита
         от кольца, если псевдонимы когда-нибудь сошлются друг на друга. */
      if (seen.has(name)) continue;
      seen.add(name);
      expand(ALIASES[name].split('+'), seen, out, unknown);
    } else if (GROUPS.includes(name)) out.add(name);
    else if (FLOOR.includes(name)) out.add(name);
    else unknown.push(name);
  }
}

/**
 * Разбор того, что названо в адресе или в --tools.
 *
 * Неизвестное имя не проглатывается и не валит процесс: оно уезжает в unknown, а решение
 * принимает вызывающий. Молча поднять полный набор на опечатку нельзя — о ней тогда узнают по
 * счёту за контекст; но и падать нельзя, поэтому отвечает тот, кто знает, кому отвечать.
 *
 * @param {string} spec — «seo+crawl», «design», «all» или пусто
 */
export function resolveSelection(spec) {
  const raw = String(spec ?? '').trim().toLowerCase();
  if (!raw) return FULL;

  const parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.includes('all')) return FULL;

  const requested = new Set();
  const unknown = [];
  expand(parts, new Set(), requested, unknown);
  if (unknown.length) return { groups: null, requested: [...requested], added: [], unknown, key: null };

  /* Зависимости добираются транзитивно: figma тянет visual, visual тянет session. */
  const groups = new Set(requested);
  const queue = [...requested];
  while (queue.length) {
    const group = queue.pop();
    for (const dep of DEPS[group] || []) {
      if (groups.has(dep)) continue;
      groups.add(dep);
      queue.push(dep);
    }
  }
  for (const floor of FLOOR) groups.add(floor);

  const added = [...groups].filter((g) => !requested.has(g) && !FLOOR.includes(g));

  /* Подпись выборки: по ней проверяется, что сессия MCP пришла на свой адрес. Сортировка нужна,
     чтобы seo+crawl и crawl+seo были одним и тем же набором, а не двумя. Пол в подписи не
     участвует — он одинаков везде, — кроме вырожденного случая, когда кроме него ничего и не
     назвали: пустая подпись давала бы адрес /mcp/ и имя сервера «layout-testing/». */
  const named = [...groups].filter((g) => !FLOOR.includes(g)).sort();
  const key = (named.length ? named : [...FLOOR].sort()).join('+');

  return {
    groups,
    requested: [...requested].sort(),
    added: added.sort(),
    /* Пустой список, а не отсутствующее поле: вызывающий смотрит на unknown.length, не проверяя
       сперва, есть ли оно вообще. */
    unknown: [],
    key,
  };
}

/** Что можно назвать в адресе — для сообщения об ошибке и для stand_info. */
export function vocabulary() {
  return {
    groups: [...GROUPS].sort(),
    aliases: Object.fromEntries(Object.entries(ALIASES)),
    always: [...FLOOR],
  };
}
