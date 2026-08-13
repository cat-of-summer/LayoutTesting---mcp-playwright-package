/**
 * Сравнение вёрстки двух страниц по DOM, а не по пикселям.
 *
 * Пиксельное сличение отвечает на вопрос «изменилась ли картинка». При натягивании
 * вёрстки вопрос другой — «сошлась ли раскладка», — и пиксели на него отвечать не умеют:
 * у макета демо-контент, у страницы боевой, тексты разной длины, фотографии разные.
 * Расхождение в сорок процентов там, где вёрстка идеальна, — обычное дело.
 *
 * Здесь сравнивается то, что от контента не зависит:
 *
 *   1. Набор классов. Какие блоки вёрстки есть в макете и не доехали до страницы —
 *      и наоборот, какие остались от прошлой версии. Это же делает регулярками
 *      scripts/sync-verstka.php в проекте adzhubey, но по живому DOM и точнее:
 *      классы, собранные в разметке условно, регулярка не видит, а браузер видит.
 *   2. Геометрия и ключевые стили одноимённых блоков: размер коробки, шрифт,
 *      отступы, раскладка сетки. Именно тут прячется «вроде похоже, но не то».
 *
 * Положение блока на странице намеренно не сравнивается: оно определяется длиной
 * предыдущего контента и на разных данных различается всегда, ничего не сообщая о вёрстке.
 */

/** Свойства, по которым видно расхождение вёрстки, а не разницу контента. */
const WATCHED = [
  'display',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'margin',
  'padding',
  'border-radius',
  'gap',
  'grid-template-columns',
  'flex-direction',
  'justify-content',
  'align-items',
  'text-align',
  'text-transform',
];

/**
 * Снимает слепок страницы: какие классы есть и как выглядит первый элемент каждого.
 *
 * Берём именно первый: одноимённых карточек на странице десятки, и сравнивать их попарно
 * бессмысленно — контент у них разный по определению. Расхождение вёрстки видно и на одной.
 */
function collectSnapshot({ watched, limit }) {
  const classes = new Map();

  for (const el of Array.from(document.body ? document.body.querySelectorAll('*') : [])) {
    // classList пуст у элементов без класса — они вёрстку не именуют, сравнивать нечего.
    for (const cls of Array.from(el.classList)) {
      // Служебные метки стенда сравнивать незачем: их ставим мы сами.
      if (cls.startsWith('lt-') || cls.startsWith('js-')) continue;
      if (!classes.has(cls)) classes.set(cls, { count: 0, first: el });
      classes.get(cls).count += 1;
    }
  }

  const snapshot = {};
  for (const [cls, info] of classes) {
    const el = info.first;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const props = {};
    for (const name of watched) props[name] = style.getPropertyValue(name);

    snapshot[cls] = {
      count: info.count,
      // Размер — да, положение — нет: положение зависит от длины предыдущего контента.
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      props,
    };

    if (Object.keys(snapshot).length >= limit) break;
  }

  return snapshot;
}

async function snapshotOf(pool, side, { viewport, watched, limit }) {
  const session = await pool.createSession({
    viewport,
    browser: side.browser,
    auth: side.auth,
    extraHTTPHeaders: side.extraHTTPHeaders,
    hostMap: side.hostMap,
    colorScheme: side.colorScheme,
  });

  try {
    const nav = await pool.gotoAndSettle(session, side.url, { waitUntil: side.waitUntil });
    const snapshot = await session.page.evaluate(collectSnapshot, { watched, limit });
    return { snapshot, nav };
  } finally {
    await pool.closeSession(session.id);
  }
}

/**
 * Сравнивает вёрстку двух страниц.
 *
 * Отдаёт три раздела: классы только слева, классы только справа и расхождения по общим.
 * Числа рядом со списками важнее самих списков — по ним видно, «забыли один блок» это
 * или «натянули не ту разметку целиком».
 */
export async function compareLayout({
  pool,
  a,
  b,
  viewport = 'desktop',
  tolerance = 2,
  maxClasses = 1500,
  maxItems = 60,
  props = WATCHED,
}) {
  if (!a?.url || !b?.url) throw new Error('Нужны обе стороны: a.url и b.url.');

  const left = await snapshotOf(pool, a, { viewport, watched: props, limit: maxClasses });
  const right = await snapshotOf(pool, b, { viewport, watched: props, limit: maxClasses });

  const inA = Object.keys(left.snapshot);
  const inB = Object.keys(right.snapshot);
  const setB = new Set(inB);
  const shared = inA.filter((cls) => setB.has(cls));

  const onlyInA = inA.filter((cls) => !setB.has(cls)).sort();
  const onlyInB = inB.filter((cls) => !left.snapshot[cls]).sort();

  const differences = [];
  for (const cls of shared) {
    const x = left.snapshot[cls];
    const y = right.snapshot[cls];
    const deltas = [];

    if (Math.abs(x.width - y.width) > tolerance) {
      deltas.push({ what: 'width', a: x.width, b: y.width, delta: y.width - x.width });
    }
    if (Math.abs(x.height - y.height) > tolerance) {
      deltas.push({ what: 'height', a: x.height, b: y.height, delta: y.height - x.height });
    }
    for (const name of props) {
      if (x.props[name] !== y.props[name]) {
        deltas.push({ what: name, a: x.props[name], b: y.props[name] });
      }
    }

    if (deltas.length) differences.push({ class: cls, countA: x.count, countB: y.count, deltas });
  }

  // Сначала блоки с самым большим числом расхождений: там и стоит копать.
  differences.sort((p, q) => q.deltas.length - p.deltas.length);

  return {
    viewport,
    a: a.url,
    b: b.url,
    classes: {
      inA: inA.length,
      inB: inB.length,
      shared: shared.length,
      onlyInA: onlyInA.slice(0, maxItems),
      onlyInB: onlyInB.slice(0, maxItems),
      onlyInATotal: onlyInA.length,
      onlyInBTotal: onlyInB.length,
    },
    differences: differences.slice(0, maxItems),
    differencesTotal: differences.length,
    clean: onlyInA.length === 0 && differences.length === 0,
    navigation: {
      a: { status: left.nav.status, warnings: left.nav.warnings || null },
      b: { status: right.nav.status, warnings: right.nav.warnings || null },
    },
  };
}
