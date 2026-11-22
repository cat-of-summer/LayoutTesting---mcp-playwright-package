/**
 * Проверки страницы в покое: после прокрутки, reveal-анимаций и ленивой обработки текста.
 *
 * На приёмке ТОПГАН агент получил controlOverlaps и coveredText и списал их целой категорией:
 * «наложение — это reveal до прокрутки». Под этими сигналами были перекрытая кнопка и блок поверх
 * шапки. Значит, отсекать анимации появления должен стенд: дойти до элемента, дождаться покоя и
 * только тогда спрашивать браузер, что лежит сверху. Такой сигнал списывать уже не за что.
 *
 * Здесь же то, что видно только на готовой странице и чего нет в статическом кадре: кнопки карточек
 * не на одной линии, текст не по центру контрола из-за метрик шрифта, шапка, у которой состояние
 * после загрузки не совпадает с состоянием после возврата наверх.
 */

/** Страница перестала двигаться: нет конечных анимаций и инлайн-стили (GSAP) не меняются. */
function waitQuietInPage(limit) {
  return new Promise((resolve) => {
    const started = performance.now();
    const signature = () => {
      const styled = Array.from(document.querySelectorAll('[style]')).slice(0, 200);
      return `${document.documentElement.scrollHeight}|${styled.map((el) => el.getAttribute('style')).join('|')}`;
    };
    const running = () =>
      document.getAnimations().some((animation) => {
        if (animation.playState !== 'running') return false;
        return Number.isFinite(animation.effect?.getComputedTiming?.().endTime);
      });
    let last = signature();
    let still = 0;
    const step = () => {
      const current = signature();
      still = current === last && !running() ? still + 1 : 0;
      last = current;
      if (still >= 3 || performance.now() - started > limit) resolve(still >= 3);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Проход по странице и возврат: срабатывают наблюдатели появления и ленивый типограф. */
function scrollThroughInPage() {
  return new Promise((resolve) => {
    const startY = window.scrollY;
    const step = Math.max(200, Math.round(window.innerHeight * 0.8));
    let y = 0;
    const next = () => {
      window.scrollTo({ top: y, behavior: 'instant' });
      if (y >= document.documentElement.scrollHeight - window.innerHeight) {
        requestAnimationFrame(() =>
          setTimeout(() => {
            window.scrollTo({ top: startY, behavior: 'instant' });
            requestAnimationFrame(() => resolve());
          }, 60),
        );
        return;
      }
      y += step;
      requestAnimationFrame(() => setTimeout(next, 30));
    };
    next();
  });
}

/** Прокрутить страницу до конца и обратно и дождаться покоя. */
export async function settlePage(page, { timeoutMs = 2500 } = {}) {
  await page.evaluate(scrollThroughInPage);
  return page.evaluate(waitQuietInPage, timeoutMs);
}

async function collectSettled({ maxControls, maxItems, glyphPx, rowPx }, quiet) {
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
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const label = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const signature = (el) => {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
  };
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  /* Видимая часть: окно и все обрезающие предки. Клон карусели за рамкой проверять незачем. */
  const visibleRect = (el) => {
    const rect = el.getBoundingClientRect();
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, window.innerWidth);
    let bottom = Math.min(rect.bottom, window.innerHeight);
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      if (style.overflowX !== 'visible') {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (style.overflowY !== 'visible') {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : null;
  };
  const pinnedOf = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (/fixed|sticky/.test(getComputedStyle(node).position)) return node;
    }
    return null;
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startY = window.scrollY;

  /* Свой ли это элемент в точке: сам, потомок, предок, его подпись или общий интерактивный родитель. */
  const own = (el, hit) => {
    if (el === hit || el.contains(hit) || hit.contains(el)) return true;
    const wrapper = el.closest('label');
    if (wrapper && wrapper.contains(hit)) return true;
    if (el.labels && Array.from(el.labels).some((item) => item.contains(hit))) return true;
    const mine = el.closest('a, button');
    return Boolean(mine && mine === hit.closest('a, button'));
  };
  const coveredBy = (el) => {
    const box = visibleRect(el);
    if (!box) return null;
    const inset = Math.min(6, (box.right - box.left) * 0.2, (box.bottom - box.top) * 0.2);
    const center = [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
    const corners = [
      [box.left + inset, box.top + inset],
      [box.right - inset, box.top + inset],
      [box.left + inset, box.bottom - inset],
      [box.right - inset, box.bottom - inset],
    ];
    const foreign = ([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit || own(el, hit)) return null;
      /* Закреплённый слой уедет при прокрутке: его перекрытие считает отдельный проход. */
      if (pinnedOf(hit) && pinnedOf(hit) !== pinnedOf(el)) return null;
      return hit;
    };
    const atCenter = foreign(center);
    if (atCenter) return { by: atCenter, where: 'center' };
    const hits = corners.map(foreign).filter(Boolean);
    return hits.length >= 3 ? { by: hits[0], where: 'corners' } : null;
  };

  const controlsCovered = [];
  const list = Array.from(
    document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"]'),
  )
    .filter((el) => !el.disabled && shown(el))
    .map((el) => ({ el, top: el.getBoundingClientRect().top + window.scrollY }))
    .sort((a, b) => a.top - b.top);
  const controls = list.slice(0, maxControls);
  for (const { el } of controls) {
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.15 || rect.bottom > window.innerHeight * 0.85) {
      window.scrollTo({ top: rect.top + window.scrollY - window.innerHeight / 2 + rect.height / 2, behavior: 'instant' });
      await frame();
      await quiet(450);
    }
    if (!coveredBy(el)) continue;
    /* Вторая проба: слой, который ещё гаснет, находкой не считается. */
    await pause(220);
    await quiet(300);
    const found = coveredBy(el);
    if (!found || controlsCovered.length >= maxItems) continue;
    controlsCovered.push({
      selector: cssPath(el),
      text: label(el),
      covered: found.where,
      by: cssPath(found.by),
      scrollY: Math.round(window.scrollY),
    });
  }

  /* Что оказалось поверх шапки и плавающих кнопок на каждом шаге прокрутки. */
  const overPinned = [];
  const seen = new Set();
  const area = window.innerWidth * window.innerHeight;
  const pinned = Array.from(document.body.querySelectorAll('*')).filter((el) => {
    const style = getComputedStyle(el);
    if (!/fixed|sticky/.test(style.position) || style.pointerEvents === 'none' || !shown(el)) return false;
    if (parseInt(style.zIndex, 10) < 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 32 && rect.height >= 16 && rect.width * rect.height <= area * 0.6;
  });
  if (pinned.length) {
    const height = document.documentElement.scrollHeight;
    const step = Math.max(160, Math.round(window.innerHeight * 0.7));
    const stops = Math.min(40, Math.ceil(Math.max(0, height - window.innerHeight) / step) + 1);
    for (let index = 0; index < stops && overPinned.length < maxItems; index += 1) {
      window.scrollTo({ top: index * step, behavior: 'instant' });
      await frame();
      await quiet(250);
      for (const el of pinned) {
        if (!shown(el)) continue;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        /* Sticky, ещё не дошедший до упора, — обычный блок потока. */
        if (style.position === 'sticky' && !(Number.isFinite(parseFloat(style.top)) && rect.top <= parseFloat(style.top) + 1)) continue;
        const box = visibleRect(el);
        if (!box) continue;
        const counts = new Map();
        for (let col = 1; col <= 5; col += 1) {
          for (let row = 1; row <= 3; row += 1) {
            const x = box.left + ((box.right - box.left) * col) / 6;
            const y = box.top + ((box.bottom - box.top) * row) / 4;
            const hit = document.elementFromPoint(x, y);
            if (!hit || el.contains(hit) || hit.contains(el) || pinnedOf(hit)) continue;
            counts.set(hit, (counts.get(hit) || 0) + 1);
          }
        }
        for (const [hit, points] of counts) {
          if (points < 2) continue;
          const key = `${cssPath(el)}|${cssPath(hit)}`;
          if (seen.has(key) || overPinned.length >= maxItems) continue;
          seen.add(key);
          overPinned.push({ selector: cssPath(hit), pinned: cssPath(el), scrollY: Math.round(window.scrollY), points });
        }
      }
    }
  }
  window.scrollTo({ top: startY, behavior: 'instant' });
  await frame();

  /* Одноимённые кнопки, цены и даты в ряду однотипных карточек. */
  const rowChildren = [];
  const INNER = 'a, button, [role="button"], time, [class*="price" i], [class*="cost" i], [class*="date" i]';
  const parents = new Set(Array.from(document.body.querySelectorAll('*')).map((el) => el.parentElement).filter(Boolean));
  for (const parent of parents) {
    if (rowChildren.length >= maxItems) break;
    if (parent.children.length < 2) continue;
    const bySignature = new Map();
    for (const child of parent.children) {
      if (!shown(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) continue;
      const key = signature(child);
      bySignature.set(key, [...(bySignature.get(key) || []), { el: child, rect }]);
    }
    for (const cards of bySignature.values()) {
      if (cards.length < 2) continue;
      const rows = [];
      for (const card of [...cards].sort((a, b) => a.rect.top - b.rect.top)) {
        const row = rows.find((item) => Math.abs(item[0].rect.top - card.rect.top) <= 4);
        if (row) row.push(card);
        else rows.push([card]);
      }
      for (const row of rows) {
        if (row.length < 2) continue;
        const widths = row.map((card) => card.rect.width);
        if (Math.max(...widths) > Math.min(...widths) * 1.2) continue;
        const inner = row.map(({ el }) => {
          const numbered = new Map();
          const counts = new Map();
          for (const item of el.querySelectorAll(INNER)) {
            if (!shown(item)) continue;
            const base = signature(item);
            const index = counts.get(base) || 0;
            counts.set(base, index + 1);
            numbered.set(`${base}#${index}`, item);
          }
          return numbered;
        });
        for (const key of inner[0].keys()) {
          if (!inner.every((map) => map.has(key))) continue;
          const tops = inner.map((map) => ({ el: map.get(key), top: map.get(key).getBoundingClientRect().top }));
          const values = tops.map((item) => item.top);
          const spread = Math.max(...values) - Math.min(...values);
          if (spread <= rowPx) continue;
          const lines = new Map();
          for (const value of values) lines.set(Math.round(value), (lines.get(Math.round(value)) || 0) + 1);
          const line = [...lines.entries()].sort((a, b) => b[1] - a[1])[0][0];
          rowChildren.push({
            row: cssPath(parent),
            element: key.split('#')[0],
            spread: Math.round(spread),
            outliers: tops
              .filter((item) => Math.abs(item.top - line) > rowPx)
              .slice(0, 4)
              .map((item) => ({ selector: cssPath(item.el), delta: Math.round(item.top - line) })),
          });
          break;
        }
      }
    }
  }

  /* Центр глифов против центра контрола: так видна асимметрия метрик шрифта. */
  const glyphOffset = [];
  const context = document.createElement('canvas').getContext('2d');
  const transformed = (text, style) => {
    if (style.textTransform === 'uppercase') return text.toUpperCase();
    if (style.textTransform === 'lowercase') return text.toLowerCase();
    return text;
  };
  for (const { el } of controls) {
    if (glyphOffset.length >= maxItems) break;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.height > 96 || rect.height < 16) continue;
    const framed =
      !/rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor) ||
      style.backgroundImage !== 'none' ||
      ['Top', 'Bottom'].some((side) => parseFloat(style[`border${side}Width`]) > 0);
    if (!framed) continue;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
    if (nodes.length !== 1) continue;
    const owner = nodes[0].parentElement;
    const ownerStyle = getComputedStyle(owner);
    const range = document.createRange();
    range.selectNodeContents(nodes[0]);
    const rects = Array.from(range.getClientRects()).filter((item) => item.width && item.height);
    if (!rects.length || new Set(rects.map((item) => Math.round(item.top))).size !== 1) continue;
    context.font = `${ownerStyle.fontStyle} ${ownerStyle.fontWeight} ${ownerStyle.fontSize} ${ownerStyle.fontFamily}`;
    const metrics = context.measureText(transformed(nodes[0].nodeValue.trim(), ownerStyle));
    if (!metrics.actualBoundingBoxAscent) continue;
    /* Хвосты букв не в счёт: глаз центрирует строку по высоте заглавных, а не по «у» и «р». */
    const baseline = rects[0].top + metrics.fontBoundingBoxAscent;
    const inkCenter = baseline - metrics.actualBoundingBoxAscent / 2;
    const offset = Math.round((inkCenter - (rect.top + rect.height / 2)) * 10) / 10;
    if (Math.abs(offset) <= glyphPx) continue;
    glyphOffset.push({ selector: cssPath(el), text: label(el), offset, font: ownerStyle.fontFamily.split(',')[0].replace(/["']/g, '') });
  }

  return {
    checked: { controls: controls.length, controlsTotal: list.length, pinned: pinned.length },
    controlsCovered,
    overPinned,
    rowChildren,
    glyphOffset,
  };
}

/**
 * Проверки в покое.
 *
 * controlsCovered и overPinned — дефекты: страница уже доиграла, и сверху всё равно чужой элемент.
 * rowChildren и glyphOffset — подсказки: бывают задуманы, их смотрят глазами.
 */
export async function auditSettled(page, { maxControls = 150, maxItems = 20, glyphPx = 1, rowPx = 2, settle = true } = {}) {
  if (settle) await settlePage(page);
  await page.evaluate(() => document.fonts?.ready.then(() => true)).catch(() => {});
  /* Строкой, а не new Function в странице: Runtime.evaluate не подпадает под её CSP. */
  const options = JSON.stringify({ maxControls, maxItems, glyphPx, rowPx });
  return page.evaluate(`(${collectSettled.toString()})(${options}, ${waitQuietInPage.toString()})`);
}

/** Ключевые элементы и их вид: шапка, навигация, всё закреплённое. */
function readKeyStateInPage() {
  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    const same = el.parentElement ? Array.from(el.parentElement.children).filter((child) => child.tagName === el.tagName) : [];
    return `${el.tagName.toLowerCase()}${cls ? `.${CSS.escape(cls)}` : ''}${same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : ''}`;
  };
  const found = new Set(document.querySelectorAll('header, [role="banner"], body > nav'));
  for (const el of document.body.querySelectorAll('*')) {
    if (found.size >= 16) break;
    if (/fixed|sticky/.test(getComputedStyle(el).position)) found.add(el);
  }
  const out = {};
  for (const el of found) {
    const style = getComputedStyle(el);
    out[cssPath(el)] = {
      classes: (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).sort(),
      styles: {
        'background-color': style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
        visibility: style.visibility,
        'box-shadow': style.boxShadow,
        height: `${Math.round(el.getBoundingClientRect().height)}px`,
      },
    };
  }
  return out;
}

/** Чем состояние «сразу после загрузки» отличается от состояния после прокрутки и возврата. */
export function diffKeyState(before, after) {
  const out = [];
  for (const [selector, was] of Object.entries(before)) {
    const now = after[selector];
    if (!now) continue;
    const added = now.classes.filter((name) => !was.classes.includes(name));
    const removed = was.classes.filter((name) => !now.classes.includes(name));
    const styles = Object.fromEntries(
      Object.entries(was.styles)
        .filter(([prop, value]) => now.styles[prop] !== value)
        .map(([prop, value]) => [prop, { atLoad: value, afterReturn: now.styles[prop] }]),
    );
    if (!added.length && !removed.length && !Object.keys(styles).length) continue;
    out.push({
      selector,
      ...(removed.length ? { onlyAtLoad: removed } : {}),
      ...(added.length ? { onlyAfterReturn: added } : {}),
      ...(Object.keys(styles).length ? { styles } : {}),
    });
  }
  return out;
}

/**
 * Начальное состояние шапки и оверлеев.
 *
 * Шапка ТОПГАН получала is-solid до первого скролла: состояние считалось по смене route.fullPath,
 * а при первой загрузке путь не меняется. После прокрутки и возврата она становилась правильной,
 * поэтому увидеть ошибку можно только на нетронутой странице — без стабилизации, которая скроллит.
 */
export async function initialStateDrift(page) {
  await page.evaluate(waitQuietInPage, 1500);
  const before = await page.evaluate(readKeyStateInPage);
  await page.evaluate(scrollThroughInPage);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.evaluate(waitQuietInPage, 2000);
  const after = await page.evaluate(readKeyStateInPage);
  return diffKeyState(before, after);
}

/** Предупреждения библиотек, за которыми на приёмке стояли настоящие дефекты. */
const KNOWN_WARNINGS = [
  { kind: 'swiper-loop', test: /Swiper Loop Warning/i, why: 'слайдов мало для loop: на месте следующего слайда будет пусто' },
  { kind: 'vue-hydration', test: /hydration (node )?mismatch|hydration completed but/i, why: 'разметка сервера и клиента разошлась' },
  { kind: 'vue-warn', test: /\[Vue warn\]/i, why: 'Vue сообщает об ошибке в компоненте: пропс, ключ, отсутствующий элемент' },
  { kind: 'vue-router', test: /\[Vue Router warn\]/i, why: 'маршрут не найден или задан с ошибкой' },
  { kind: 'gsap-target', test: /GSAP target .* not found/i, why: 'анимация ссылается на элемент, которого нет' },
];

/** Записи консоли, которые выглядят дефектом: по одной на вид и текст, со счётчиком повторов. */
export function likelyDefects(entries = []) {
  const found = new Map();
  for (const entry of entries) {
    const text = String(entry?.text ?? entry?.message ?? '');
    const known = KNOWN_WARNINGS.find((item) => item.test.test(text));
    if (!known) continue;
    const short = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    const key = `${known.kind}|${short}`;
    const item = found.get(key) || { kind: known.kind, text: short, why: known.why, count: 0 };
    item.count += 1;
    found.set(key, item);
  }
  return [...found.values()];
}
