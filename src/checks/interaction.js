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
function watchInPage({ selector, timeoutMs }) {
  return new Promise((resolve) => {
    const root = document.querySelector(selector);
    if (!root) {
      resolve({ error: 'элемент исчез до начала наблюдения' });
      return;
    }

    /* Цели наблюдения: сам элемент, то, чем он управляет, и его ближайший контейнер. */
    const controls = root.getAttribute('aria-controls');
    const watched = [root, controls ? document.getElementById(controls) : null, root.parentElement].filter(Boolean);

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
        return /auto|scroll/.test(s.overflowX + s.overflowY) && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
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
    const observer = new MutationObserver((records) => {
      for (const record of records) {
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

    const step = () => {
      frames += 1;
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
          changed: { moved: signature() !== before, added, removed, attrs },
          timing: {
            settled: false,
            kind: changedFrames >= frames - 2 ? 'continuous' : 'unsettled',
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
          changed: { moved: signature() !== before, added, removed, attrs },
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

/** Не изменилось ничего: ни геометрия, ни состав DOM, ни атрибуты. */
const isSilent = (result) =>
  !result.error && !result.changed.moved && !result.changed.added && !result.changed.removed && !result.changed.attrs.length;

export async function runInteractions(
  page,
  { selectors = null, actions = ['click'], maxTargets = 30, timeoutMs = 1200, maxItems = 20 } = {},
) {
  const targets = await page.evaluate(pickTargets, { selectors, maxTargets });
  const results = [];
  const silent = [];

  for (const target of targets) {
    for (const action of actions) {
      const locator = page.locator(target.selector).first();
      /*
       * Наблюдение запускается до действия и не ожидается сразу: иначе оно бы встало в очередь
       * ПОСЛЕ клика и пропустило первые кадры — а именно в первом кадре и видно рывок.
       */
      const watching = page.evaluate(watchInPage, { selector: target.selector, timeoutMs }).catch((err) => ({ error: err.message }));
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

      const quiet = isSilent(result);
      if (quiet) silent.push(`${target.selector} (${action})`);
      results.push({
        ...target,
        action,
        verdict: quiet ? 'молчит' : 'ответил',
        ...(forced ? { forced } : {}),
        ...(quiet ? {} : { changed: result.changed, timing: result.timing }),
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

  return {
    found: targets.length,
    probed: results.length,
    ...(targets.length >= maxTargets
      ? { note: `Показаны первые ${maxTargets} элементов — остальные не проверялись. Сузьте selectors или поднимите maxTargets.` }
      : {}),
    silent,
    targets: results.slice(0, maxItems),
    ...(results.length > maxItems ? { truncated: `Показано ${maxItems} из ${results.length}` } : {}),
  };
}
