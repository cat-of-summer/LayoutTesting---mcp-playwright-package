/**
 * Прогон интерактива: что отвечает на нажатие и наведение, а что молчит.
 *
 * Неподвижный снимок сломанного слайдера ничем не отличается от снимка исправного. Отсюда целый
 * класс находок, которых не видит ни одна статическая проверка: стрелка, у которой Swiper поднялся
 * с нулём слайдов; аккордеон, у которого grid-template-rows тянется секунду, а min-height
 * переключается в первом же кадре, и текст разъезжается в готовой пустой коробке; кнопка, на
 * которой обработчик не повесился вовсе.
 *
 * Раньше это проверялось browser_act вручную, и агент сам придумывал, что считать нормой.
 * Придумывал правдоподобно и неверно: «слайдер работает, просто заблокирован — три карточки при
 * трёх видимых» оказалось тремя карточками при нуле.
 *
 * Устройство то же, что у stress.js: работа по живой сессии, снятие разницы, возврат страницы
 * как было. Отличие в том, что здесь меряется ещё и время — по кадрам, а не по объявленной
 * длительности: важно, когда движение кончилось на самом деле.
 */

export const INTERACTION_ACTIONS = ['click', 'hover'];

/**
 * Выбор целей.
 *
 * Движение ищется по правилам стилей, а не по computed-значениям, — ровно по той же причине, по
 * которой так делает layout_audit: заморозка обнуляет длительности, и по элементам движения уже
 * не видно. Обработчики, повешенные через addEventListener, из страницы не видны вообще: это
 * ограничение платформы, и оно называется вслух полем listenersVisible.
 */
function pickTargets({ selectors, maxTargets }) {
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
      if (cls) part += `.${CSS.escape(cls)}`;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const ARIA = '[aria-expanded], [aria-controls], [aria-selected], [role="tab"], [role="button"], [role="switch"], details > summary, button, input[type="checkbox"], input[type="radio"]';

  const found = new Map();
  const add = (el, via) => {
    if (!el || !visible(el) || found.has(el)) return;
    found.set(el, via);
  };

  if (selectors?.length) {
    for (const sel of selectors) for (const el of document.querySelectorAll(sel)) add(el, 'задан');
  } else {
    for (const el of document.querySelectorAll(ARIA)) add(el, 'aria');
    for (const el of document.querySelectorAll('[onclick]')) add(el, 'onclick');

    /* Селекторы правил с движением — и по ним элементы на странице. */
    const moving = new Set();
    const scan = (list) => {
      for (const rule of Array.from(list || [])) {
        const s = rule.style;
        if (s && rule.selectorText) {
          const hasMotion = (value) => value && value.split(',').some((part) => parseFloat(part) > 0);
          if (hasMotion(s.transitionDuration) || (s.animationName && s.animationName !== 'none')) {
            for (const part of rule.selectorText.split(',')) moving.add(part.trim());
          }
        }
        if (rule.cssRules) scan(rule.cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        scan(sheet.cssRules);
      } catch {
        /* Чужой домен не отдаёт правила — это не повод терять остальное. */
      }
    }
    for (const sel of moving) {
      /* Псевдоклассы и псевдоэлементы в querySelectorAll не нужны: нас интересует сам элемент. */
      const base = sel.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').trim();
      if (!base) continue;
      try {
        for (const el of document.querySelectorAll(base)) add(el, 'transition');
      } catch {
        /* Селектор из чужих стилей может быть невалиден для querySelectorAll. */
      }
    }
  }

  return [...found.entries()].slice(0, maxTargets).map(([el, via]) => ({ selector: cssPath(el), via }));
}

/**
 * Наблюдение за одним действием.
 *
 * Ставится ДО действия и разрешается, когда движение улеглось: наблюдаемые величины не менялись
 * четыре кадра подряд. Четыре, а не один, — иначе пауза между двумя фазами перехода читается
 * как конец.
 *
 * Меряется именно геометрия и прокрутка, а не объявленная transition-duration. Отсюда честная
 * оговорка, которую ответ обязан нести: то, что не двигается и не гаснет — цвет, тень, фон, —
 * этим способом не измеряется вовсе и даст durationMs: 0 при работающем переходе.
 */
function watchInPage({ selector, timeoutMs, ignore = [] }) {
  return new Promise((resolve) => {
    const root = document.querySelector(selector);
    /*
     * Фон, который живёт сам по себе: звёзды на canvas, видео, бегущая строка в ignore. Их
     * атрибуты меняются каждый кадр, и без фильтра любой клик читался как «ответил», а таймер
     * упирался в «unsettled» — на всей странице разом.
     */
    const ignoreSelector = ignore.filter(Boolean).join(', ');
    const inIgnored = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === 'CANVAS' || el.tagName === 'VIDEO') return true;
      try {
        return Boolean(ignoreSelector && el.closest(ignoreSelector));
      } catch {
        return false;
      }
    };
    if (!root) {
      resolve({ error: 'элемент исчез до начала наблюдения' });
      return;
    }

    /* Цели наблюдения: сам элемент, то, чем он управляет, и его ближайший контейнер. */
    const controls = root.getAttribute('aria-controls');
    const controlled = controls ? document.getElementById(controls) : null;
    const watched = [root, controlled, root.parentElement].filter((el) => el && (el === root || !inIgnored(el)));

    /*
     * Фон страницы: fixed- и sticky-слои, не связанные с целью. Шапка, которая прячется и
     * появляется при прокрутке, меняла класс на каждом шаге обхода, и «ответил» доставался
     * случайным целям. Такие мутации считаются отдельно, в ambient, и в вердикт не идут.
     */
    const pinned = new WeakMap();
    const inUnrelatedPinned = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (pinned.has(el)) return pinned.get(el);
      let node = el;
      let verdict = false;
      while (node && node.nodeType === 1 && node !== document.body) {
        const position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'sticky') {
          verdict = !node.contains(root) && !(controlled && (node.contains(controlled) || controlled.contains(node)));
          break;
        }
        node = node.parentElement;
      }
      pinned.set(el, verdict);
      return verdict;
    };

    /*
     * Прокручиваемые области ищутся по всей странице, а не среди предков.
     *
     * Слайдер двигает дорожку прокруткой, а стрелка почти никогда не лежит внутри неё — она
     * рядом, соседом. Пока смотрели только предков кнопки, исправный слайдер уверенно
     * записывался в «молчит»: геометрия слайдов при прокрутке не меняется вовсе.
     */
    const scrollers = Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const s = getComputedStyle(el);
        return !inIgnored(el) && /auto|scroll/.test(s.overflowX + s.overflowY) && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
      })
      .slice(0, 20);

    const signature = () =>
      watched
        .map((el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), s.opacity, s.transform, s.visibility].join(',');
        })
        .concat(scrollers.map((el) => `${el.scrollLeft},${el.scrollTop}`))
        .join('|');

    const before = signature();
    const attrs = [];
    let added = 0;
    let removed = 0;
    let ambient = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (inIgnored(record.target)) continue;
        if (inUnrelatedPinned(record.target)) {
          ambient += 1;
          continue;
        }
        if (record.type === 'attributes' && attrs.length < 10) {
          attrs.push({
            attr: record.attributeName,
            from: record.oldValue,
            to: record.target.getAttribute?.(record.attributeName) ?? null,
          });
        }
        if (record.type === 'childList') {
          added += record.addedNodes.length;
          removed += record.removedNodes.length;
        }
      }
    });
    observer.observe(document.body, { attributes: true, attributeOldValue: true, childList: true, subtree: true });

    const startedAt = performance.now();
    let last = before;
    let firstChangeMs = null;
    let lastChangeMs = null;
    let frames = 0;
    let changedFrames = 0;
    let still = 0;

    /*
     * Качество перехода, а не только факт ответа. Табы ТОПГАН на время анимации показывали две
     * панели и внутренний скроллбар, а раскрытие вакансии дёргало саму карточку. Конечное
     * состояние у всех было верным, поэтому смотреть надо на кадры между.
     */
    const switching = root.matches('[role="tab"], [aria-selected], [aria-expanded], summary');
    const pageTop = () => root.getBoundingClientRect().top + window.scrollY;
    const anchorTop = pageTop();
    const shownPanel = (el) => {
      const s = getComputedStyle(el);
      return el.getBoundingClientRect().height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
    };
    const panels = root.matches('[role="tab"], [aria-selected]') ? Array.from(document.querySelectorAll('[role="tabpanel"]')) : [];
    const box = controlled?.parentElement || null;
    const hadScroll = box ? box.scrollHeight > box.clientHeight + 1 : false;
    const quality = { panels: 0, jump: 0, scroll: false };
    const measure = () => {
      if (!switching) return;
      quality.panels = Math.max(quality.panels, panels.filter(shownPanel).length);
      quality.jump = Math.max(quality.jump, Math.abs(pageTop() - anchorTop));
      if (box && !hadScroll && /auto|scroll/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 1) quality.scroll = true;
    };
    const issuesOf = () => {
      const out = [];
      if (quality.panels > 1) out.push({ kind: 'twoPanels', panels: quality.panels, note: 'во время перехода видно несколько панелей сразу' });
      if (quality.scroll) out.push({ kind: 'transientScroll', note: 'на время перехода у контейнера появляется внутренний скролл' });
      if (quality.jump > 4) out.push({ kind: 'jump', px: Math.round(quality.jump), note: 'сам элемент сдвигается при раскрытии: должен стоять на месте, двигается то, что ниже' });
      return out;
    };

    const step = () => {
      frames += 1;
      measure();
      const now = performance.now();
      const current = signature();
      if (current !== last) {
        last = current;
        still = 0;
        changedFrames += 1;
        if (firstChangeMs === null) firstChangeMs = Math.round(now - startedAt);
        lastChangeMs = Math.round(now - startedAt);
      } else {
        still += 1;
      }

      const elapsed = now - startedAt;
      /* Бесконечная анимация не уляжется никогда — её признаём отдельно, а не выдумываем ей конец. */
      if (elapsed >= timeoutMs) {
        observer.disconnect();
        resolve({
          quality: issuesOf(),
          changed: { moved: signature() !== before, added, removed, attrs, ...(ambient ? { ambient } : {}) },
          timing: {
            settled: false,
            /* Геометрия не менялась вовсе: ответ без движения (цвет, класс), а не бесконечная анимация. */
            kind: firstChangeMs === null ? 'noMotion' : changedFrames >= frames - 2 ? 'continuous' : 'unsettled',
            frames,
            changedFrames,
            firstChangeMs,
          },
        });
        return;
      }
      if (still >= 4 && firstChangeMs !== null) {
        observer.disconnect();
        resolve({
          quality: issuesOf(),
          changed: { moved: signature() !== before, added, removed, attrs, ...(ambient ? { ambient } : {}) },
          timing: {
            settled: true,
            frames,
            changedFrames,
            firstChangeMs,
            durationMs: Math.max(0, lastChangeMs - firstChangeMs),
            /* Состояние, переключившееся за один кадр, анимацией не является, как бы ни выглядело. */
            smooth: changedFrames >= 6,
          },
        });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/*
 * Свойства, которыми ховер меняет вид без движения. Ховер карточки — это заливка выреза у
 * SVG-потомка, цвет кнопки внутри, обводка, радиус; геометрию и DOM он не трогает вовсе. Пока
 * аудит смотрел только их, рабочий и мёртвый ховер одинаково получали «молчит».
 */
export const HOVER_PROPS = [
  'color', 'background-color', 'background-image', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-left-color', 'border-top-left-radius', 'outline-color', 'outline-style', 'box-shadow', 'text-shadow', 'fill',
  'stroke', 'opacity', 'filter', 'backdrop-filter', 'transform', 'text-decoration-line', 'text-decoration-color',
];

/**
 * Снимок вида цели и её потомков: computed styles по HOVER_PROPS, до 200 узлов, плюс ::before и
 * ::after у самой цели. Ключ узла — путь индексов от цели: так до и после сопоставляются без
 * селекторов. Заодно — самый длинный transition в поддереве и есть ли на странице правило
 * :hover, которое касается цели или её потомков.
 */
export function styleSnapshot({ selector, props }) {
  const root = document.querySelector(selector);
  if (!root) return null;
  const nodes = {};
  let maxTransitionMs = 0;
  const seconds = (value) =>
    Math.max(0, ...String(value || '0s').split(',').map((part) => (/ms$/.test(part.trim()) ? parseFloat(part) : parseFloat(part) * 1000) || 0));
  const name = (el) => {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    /* Текст — и у контейнера, если короткий: по нему потомок варианта макета находится на странице. */
    const full = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const text = full.length <= 40 ? full.slice(0, 30) : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${text ? ` «${text}»` : ''}`;
  };
  const read = (style) => Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
  const walk = (el, key, depth) => {
    if (Object.keys(nodes).length >= 200) return;
    const style = getComputedStyle(el);
    maxTransitionMs = Math.max(maxTransitionMs, seconds(style.transitionDuration) + seconds(style.transitionDelay));
    nodes[key] = { name: name(el), style: read(style) };
    if (depth === 0) {
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content && ps.content !== 'none') nodes[`${key}${pseudo}`] = { name: `${name(el)}${pseudo}`, style: read(ps) };
      }
    }
    Array.from(el.children).forEach((child, i) => walk(child, `${key}/${i}`, depth + 1));
  };
  walk(root, '0', 0);

  /* Объявлен ли ховер вообще: правило с :hover, база которого — цель, её предок или потомок. */
  let hoverRule = false;
  const scan = (list) => {
    for (const rule of Array.from(list || [])) {
      if (hoverRule) return;
      if (rule.selectorText && rule.selectorText.includes(':hover')) {
        for (const part of rule.selectorText.split(',')) {
          if (!part.includes(':hover')) continue;
          const host = part.slice(0, part.indexOf(':hover')).replace(/::?[a-z-]+(\([^)]*\))?/gi, '').trim();
          try {
            if (host && (root.matches(host) || root.closest(host) || root.querySelector(host))) hoverRule = true;
          } catch {
            /* Чужой селектор может быть невалиден для matches. */
          }
        }
      }
      if (rule.cssRules) scan(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      scan(sheet.cssRules);
    } catch {
      /* Чужой домен не отдаёт правила. */
    }
  }
  const rect = root.getBoundingClientRect();
  return { nodes, maxTransitionMs: Math.min(maxTransitionMs, 2000), hoverRule, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
}

/**
 * Ховер одного элемента: вид до и после наведения, с ожиданием самого длинного перехода. То же,
 * что делает interaction_audit для каждой цели, — для figma_variants, который сверяет это с
 * разницей вариантов макета.
 */
export async function hoverStyleDiff(page, selector, { limit = 60 } = {}) {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await page.mouse.move(0, 0).catch(() => {});
  await settle(page, 1200);
  const before = await page.evaluate(styleSnapshot, { selector, props: HOVER_PROPS });
  if (!before) throw new Error(`На странице нет элемента ${selector}`);
  await locator.hover({ timeout: 3000, force: true });
  await page.waitForTimeout(Math.min(before.maxTransitionMs + 80, 1100));
  const after = await page.evaluate(styleSnapshot, { selector, props: HOVER_PROPS });
  await page.mouse.move(0, 0).catch(() => {});
  return { changes: diffStyles(before, after, limit), hoverRule: before.hoverRule };
}

/** Что изменилось между двумя снимками вида: [{ node, prop, from, to }]. */
export function diffStyles(before, after, limit = 12) {
  const out = [];
  if (!before || !after) return out;
  for (const [key, node] of Object.entries(after.nodes)) {
    const was = before.nodes[key];
    if (!was) continue;
    for (const [prop, value] of Object.entries(node.style)) {
      if (was.style[prop] !== value) out.push({ node: node.name, prop, from: was.style[prop], to: value });
    }
  }
  return out.slice(0, limit);
}

/** Доля изменившихся пикселей между двумя PNG одного размера. */
export async function pixelChange(a, b) {
  if (!a || !b) return null;
  const { default: sharp } = await import('sharp');
  const [x, y] = await Promise.all([a, b].map((png) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) return 1;
  let changed = 0;
  const total = x.info.width * x.info.height;
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 24) changed += 1;
  }
  return total ? changed / total : 0;
}

/* Кадр цели в окне: page.screenshot с clip не ждёт, пока элемент замрёт, в отличие от locator. */
const shot = (page, box) =>
  box && box.width >= 1 && box.height >= 1
    ? page
        .screenshot({
          clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 1600), height: Math.min(box.height, 1200) },
          timeout: 3000,
        })
        .catch(() => null)
    : Promise.resolve(null);

/**
 * Подождать, пока страница перестанет двигаться после возврата.
 *
 * Потолок тот же, что у самого замера: бесконечная анимация не уляжется никогда, и ждать её
 * до бесконечности нельзя — но и мерить следующую цель на едущей странице тоже нельзя.
 */
const settle = (page, timeoutMs) =>
  page.evaluate(
    (limit) =>
      new Promise((resolve) => {
        const started = performance.now();
        const snap = () => `${document.body.scrollHeight}|${document.body.getBoundingClientRect().height}`;
        let last = snap();
        let still = 0;
        const step = () => {
          const current = snap();
          if (current === last) still += 1;
          else {
            last = current;
            still = 0;
          }
          if (still >= 4 || performance.now() - started > limit) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    timeoutMs,
  );

/**
 * Действие с одной оговоркой: непрерывно движущийся элемент обычным способом не нажать.
 *
 * Playwright перед кликом ждёт, пока элемент замрёт. Бегущая строка и карусель с бесконечной
 * анимацией не замирают никогда, и проверка честно упирается в таймаут. Отдать это как
 * «недоступен» значило бы потерять ровно тот случай, ради которого прогон и заводился, поэтому
 * вторая попытка идёт с force и помечается в ответе: агент должен видеть, что проверка
 * доступности не проходила, а не считать элемент обычным.
 */
async function act(locator, action) {
  const perform = (options) => (action === 'click' ? locator.click(options) : locator.hover(options));
  try {
    await perform({ timeout: 2000 });
    return { failed: null, forced: false };
  } catch (err) {
    const first = err.message.split('\n')[0];
    if (!/not stable|Timeout/i.test(first)) return { failed: first, forced: false };
    try {
      await perform({ timeout: 2000, force: true });
      return { failed: null, forced: 'элемент не замирает — проверка доступности не проходила, действие послано принудительно' };
    } catch (second) {
      return { failed: second.message.split('\n')[0], forced: false };
    }
  }
}

/** Не изменилось ничего: ни геометрия, ни состав DOM, ни атрибуты. Мутации фоновых fixed-слоёв не в счёт. */
const isSilent = (result) =>
  !result.error && !result.changed.moved && !result.changed.added && !result.changed.removed && !result.changed.attrs.length;

/** Элементы, у которых :hover меняет содержимое, а не только цвет. */
function pickHoverContent({ maxTargets }) {
  const CONTENT = ['display', 'visibility', 'opacity', 'height', 'maxHeight', 'transform'];
  const hosts = new Set();
  const scan = (list) => {
    for (const rule of Array.from(list || [])) {
      if (rule.cssRules?.length && !rule.selectorText) scan(rule.cssRules);
      if (!rule.selectorText || !rule.selectorText.includes(':hover')) continue;
      if (!CONTENT.some((prop) => rule.style?.[prop])) continue;
      for (const part of rule.selectorText.split(',')) {
        const at = part.indexOf(':hover');
        if (at < 0) continue;
        /* Потомок после :hover — значит, меняется содержимое, а не сам элемент. */
        if (!/^[^\s>+~]*[\s>+~]+\S/.test(part.slice(at + 6))) continue;
        const host = part.slice(0, at).trim();
        try {
          for (const el of document.querySelectorAll(host)) hosts.add(el);
        } catch {
          /* Чужой селектор может быть невалиден для querySelectorAll. */
        }
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      scan(sheet.cssRules);
    } catch {
      /* Чужой домен не отдаёт правила. */
    }
  }
  const path = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const same = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [];
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
      parts.unshift(`${node.tagName.toLowerCase()}${cls ? `.${CSS.escape(cls)}` : ''}${same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ''}`);
    }
    return parts.join(' > ');
  };
  return [...hosts]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .slice(0, maxTargets)
    .map((el) => path(el));
}

/** Вид потомков цели и перехват клика: страница не уходит, а видно, отменил ли его обработчик. */
function armTap(selector) {
  const root = document.querySelector(selector);
  if (!root) return null;
  const read = () =>
    Array.from(root.querySelectorAll('*'))
      .slice(0, 120)
      .map((el) => {
        const s = getComputedStyle(el);
        return `${s.display}|${s.visibility}|${s.opacity}|${s.transform}|${Math.round(el.getBoundingClientRect().height)}`;
      })
      .join(';');
  const state = { before: read(), clicked: false, prevented: false };
  const onClick = (event) => {
    state.clicked = true;
    state.prevented = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener('click', onClick);
  window.__ltTap = () => {
    window.removeEventListener('click', onClick);
    delete window.__ltTap;
    return { clicked: state.clicked, prevented: state.prevented, changed: read() !== state.before, link: Boolean(root.closest('a[href]')) };
  };
  const rect = root.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Hover на тач-устройстве.
 *
 * На ТОПГАН переключение карточек работало только наведением, и на телефоне состояние было
 * недостижимо. Норма такая: первый тап показывает состояние, второй идёт по ссылке. Находки две:
 * ссылка уходит с первого тапа или тап не меняет ничего. В сессии без касаний проверки нет.
 */
export async function auditTouchHover(page, { maxTargets = 12 } = {}) {
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0).catch(() => false);
  if (!touch) return [];
  const targets = await page.evaluate(pickHoverContent, { maxTargets });
  const out = [];
  for (const selector of targets) {
    await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    const point = await page.evaluate(armTap, selector).catch(() => null);
    if (!point) continue;
    await page.touchscreen.tap(point.x, point.y).catch(() => {});
    await page.waitForTimeout(350);
    const seen = await page.evaluate(() => window.__ltTap?.() ?? null).catch(() => null);
    if (!seen) continue;
    if (seen.link && seen.clicked && !seen.prevented) {
      out.push({ selector, kind: 'navigatesAtOnce', note: 'первый тап сразу идёт по ссылке: состояние из hover на телефоне не увидеть' });
    } else if (!seen.changed) {
      out.push({ selector, kind: 'noTouchState', note: 'тап не показывает состояние, которое есть при наведении' });
    }
    await page.touchscreen.tap(1, 1).catch(() => {});
    await page.waitForTimeout(120);
  }
  return out;
}

/* Ховер, изменивший меньше этой доли пикселей цели, на глаз не виден: курсор, сглаживание. */
const VISIBLE_PIXELS = 0.005;

export async function runInteractions(
  page,
  { selectors = null, actions = ['click'], maxTargets = 30, timeoutMs = 1200, maxItems = 20, ignore = [] } = {},
) {
  const targets = await page.evaluate(pickTargets, { selectors, maxTargets });
  /*
   * Табы и переключатели с одинаковыми панелями: переключение работает, а видно только смену
   * номера. Так было с новостями главной — пять одинаковых заголовков из макета.
   */
  const sameContent = await page
    .evaluate(() => {
      const panels = Array.from(document.querySelectorAll('[role="tab"][aria-controls], [aria-controls][aria-selected]'))
        .map((tab) => document.getElementById(tab.getAttribute('aria-controls')))
        .filter(Boolean);
      const texts = panels.map((panel) => (panel.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return texts.length >= 2 && new Set(texts).size === 1 ? texts.length : 0;
    })
    .catch(() => 0);
  const results = [];
  const silent = [];
  const hoverInvisible = [];
  const hoverNone = [];
  const transitionIssues = [];

  for (const target of targets) {
    for (const action of actions) {
      const locator = page.locator(target.selector).first();
      /*
       * Сначала прокрутить к цели и дождаться, пока страница уляжется, и только потом начинать
       * наблюдение. Иначе прокрутку, которую Playwright делает перед действием, и шапку,
       * спрятавшуюся при ней, аудит засчитывал как ответ цели.
       */
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      if (action === 'hover') await page.mouse.move(0, 0).catch(() => {});
      await settle(page, timeoutMs);

      const look =
        action === 'hover' ? await page.evaluate(styleSnapshot, { selector: target.selector, props: HOVER_PROPS }).catch(() => null) : null;
      const before = look ? await shot(page, look.box) : null;
      const startedAt = Date.now();
      /*
       * Наблюдение запускается до действия и не ожидается сразу: иначе оно бы встало в очередь
       * ПОСЛЕ клика и пропустило первые кадры — а именно в первом кадре и видно рывок.
       */
      const watching = page.evaluate(watchInPage, { selector: target.selector, timeoutMs, ignore }).catch((err) => ({ error: err.message }));
      const { failed, forced } = await act(locator, action);
      const result = await watching;

      if (failed) {
        results.push({ ...target, action, verdict: 'недоступен', why: failed });
        continue;
      }
      if (result.error) {
        results.push({ ...target, action, verdict: 'исчез', why: result.error });
        continue;
      }

      /* Вид после ховера: дождаться самого длинного перехода в поддереве, не дольше секунды. */
      let styles = [];
      let pixels = null;
      if (look) {
        const left = Math.min(look.maxTransitionMs + 50, 1000) - (Date.now() - startedAt);
        if (left > 0) await page.waitForTimeout(left);
        const after = await page.evaluate(styleSnapshot, { selector: target.selector, props: HOVER_PROPS }).catch(() => null);
        styles = diffStyles(look, after);
        pixels = await pixelChange(before, await shot(page, look.box)).catch(() => null);
      }
      const visible = styles.length > 0 || (pixels ?? 0) >= VISIBLE_PIXELS;

      if (action === 'click') for (const issue of result.quality || []) transitionIssues.push({ selector: target.selector, ...issue });

      const quiet = isSilent(result);
      let verdict = quiet ? 'молчит' : 'ответил';
      if (quiet && look && visible) verdict = 'ответил стилем';
      const name = `${target.selector} (${action})`;
      if (quiet && action === 'click') silent.push(name);
      if (quiet && action === 'hover' && !visible) {
        /* Ховер объявлен в стилях, а видимо ничего не меняется: это и есть мёртвый ховер. */
        if (look?.hoverRule) {
          verdict = 'ховер без видимого изменения';
          hoverInvisible.push(name);
        } else hoverNone.push(target.selector);
      }
      results.push({
        ...target,
        action,
        verdict,
        ...(forced ? { forced } : {}),
        ...(quiet ? {} : { changed: result.changed, timing: result.timing }),
        ...(styles.length ? { styles } : {}),
        ...(pixels !== null && look ? { pixels: Math.round(pixels * 1000) / 10 } : {}),
      });

      /* Возврат страницы: закрыть тем же способом, каким открыли, и увести курсор с наведения. */
      if (action === 'click' && !quiet) await locator.click({ timeout: 2000, force: Boolean(forced) }).catch(() => {});
      if (action === 'hover') await page.mouse.move(0, 0).catch(() => {});
      /*
       * Дождаться, пока возврат доиграет, — иначе следующая цель меряется на едущей странице.
       * Схлопывающийся аккордеон сдвигает по вертикали всё, что ниже, и соседняя кнопка без
       * обработчика уверенно записывалась в «ответил»: её секция в это время как раз уезжала.
       */
      if (!quiet) await settle(page, timeoutMs);
    }
  }

  const touchHover = await auditTouchHover(page, { maxTargets: Math.min(maxTargets, 12) }).catch(() => []);

  return {
    found: targets.length,
    probed: results.length,
    ...(transitionIssues.length ? { transitionIssues: transitionIssues.slice(0, maxItems) } : {}),
    ...(touchHover.length ? { touchHover } : {}),
    ...(targets.length >= maxTargets
      ? { note: `Показаны первые ${maxTargets} элементов — остальные не проверялись. Сузьте selectors или поднимите maxTargets.` }
      : {}),
    silent,
    ...(sameContent
      ? { sameContent: `у ${sameContent} панелей табов одинаковое содержимое — переключение работает, но его не видно: проверьте на разных данных` }
      : {}),
    ...(hoverInvisible.length ? { hoverInvisible } : {}),
    ...(hoverNone.length
      ? {
          hoverNone: {
            count: hoverNone.length,
            selectors: hoverNone.slice(0, 10),
            note: 'Наведение ничего не меняет, и правила :hover для них нет — сверьте с макетом, должен ли быть ховер.',
          },
        }
      : {}),
    targets: results.slice(0, maxItems),
    ...(results.length > maxItems ? { truncated: `Показано ${maxItems} из ${results.length}` } : {}),
  };
}
