/**
 * Боксы элементов до и после действия.
 *
 * Сверка с макетом сравнивает страницу с кадром, но не два состояния страницы между собой.
 * Шапка, которая при открытом меню уезжает на 60px, в кадре меню нарисована так же криво, и
 * сравнение «меню ↔ кадр меню» такой сдвиг не видит. Здесь — прямой ответ на вопрос «что
 * сдвинулось, хотя не должно»: якоря снимаются до действия и после того, как страница затихла.
 */

/**
 * Боксы по селекторам в координатах документа: первый видимый элемент на селектор.
 * Невидимый или отсутствующий элемент — null: для сравнения это «пропал», а не «сдвинулся».
 */
export function measureBoxes(page, selectors) {
  return page.evaluate((list) => {
    const out = {};
    for (const selector of list) {
      let found = null;
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch {
        out[selector] = { error: 'неверный селектор' };
        continue;
      }
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
        found = {
          x: Math.round((rect.left + scrollX) * 10) / 10,
          y: Math.round((rect.top + scrollY) * 10) / 10,
          w: Math.round(rect.width * 10) / 10,
          h: Math.round(rect.height * 10) / 10,
          /* Липкое и фиксированное живёт в координатах окна: сдвиг прокрутки для него не сдвиг. */
          fixed: style.position === 'fixed' || style.position === 'sticky',
          viewport: { x: Math.round(rect.left * 10) / 10, y: Math.round(rect.top * 10) / 10 },
        };
        break;
      }
      out[selector] = found;
    }
    return out;
  }, selectors);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Дождаться, пока боксы якорей перестанут меняться: два одинаковых замера подряд через кадр.
 * Переход меню длится сотни миллисекунд, и замер сразу после клика ловил бы середину анимации.
 */
export async function settleBoxes(page, selectors, { timeout = 1500, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let last = await measureBoxes(page, selectors);
  while (Date.now() < deadline) {
    await page.waitForTimeout(interval);
    const next = await measureBoxes(page, selectors);
    if (same(last, next)) return { boxes: next, settled: true };
    last = next;
  }
  return { boxes: last, settled: false };
}

/**
 * Разница двух замеров. Для fixed и sticky сравниваются координаты окна, для остальных —
 * документа. Порог — в пикселях, по умолчанию 1: субпиксельное округление сдвигом не считается.
 */
export function diffBoxes(before, after, { threshold = 1 } = {}) {
  const moved = [];
  const vanished = [];
  const appeared = [];
  const invalid = [];
  let stable = 0;
  for (const selector of Object.keys(before)) {
    const a = before[selector];
    const b = after[selector];
    if (a?.error || b?.error) {
      invalid.push(selector);
      continue;
    }
    if (a && !b) {
      vanished.push(selector);
      continue;
    }
    if (!a && b) {
      appeared.push(selector);
      continue;
    }
    if (!a && !b) continue;
    const fixed = a.fixed && b.fixed;
    const pa = fixed ? a.viewport : a;
    const pb = fixed ? b.viewport : b;
    const delta = {
      dx: Math.round((pb.x - pa.x) * 10) / 10,
      dy: Math.round((pb.y - pa.y) * 10) / 10,
      dw: Math.round((b.w - a.w) * 10) / 10,
      dh: Math.round((b.h - a.h) * 10) / 10,
    };
    if (Object.values(delta).some((v) => Math.abs(v) > threshold)) {
      moved.push({
        selector,
        ...Object.fromEntries(Object.entries(delta).filter(([, v]) => Math.abs(v) > threshold)),
        before: { x: pa.x, y: pa.y, w: a.w, h: a.h },
        after: { x: pb.x, y: pb.y, w: b.w, h: b.h },
      });
    } else {
      stable += 1;
    }
  }
  return {
    stable,
    ...(moved.length ? { moved } : {}),
    ...(vanished.length ? { vanished } : {}),
    ...(appeared.length ? { appeared } : {}),
    ...(invalid.length ? { invalid } : {}),
  };
}
