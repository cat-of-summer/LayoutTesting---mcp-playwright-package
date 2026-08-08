/**
 * Эвристики вёрстки: то, что видно глазом на скриншоте, но здесь возвращается
 * текстом с селекторами — агенту дешевле читать и сразу понятно, что чинить.
 */

function collectLayoutIssues(options) {
  const { minTarget, contrastRatio, maxItems } = options;

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

  const label = (el) => (el.innerText || el.textContent || '').trim().slice(0, 80);
  const box = (r) => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  });

  const isVisible = (el, style, rect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    Number(style.opacity) !== 0;

  const parseColor = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const luminance = ({ r, g, b }) => {
    const f = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const effectiveBackground = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.5) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const contrast = (fg, bg) => {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const issues = {
    documentOverflow: null,
    overflowingElements: [],
    overlaps: [],
    clippedText: [],
    brokenImages: [],
    imagesWithoutDimensions: [],
    tinyTargets: [],
    lowContrast: [],
  };

  const docEl = document.documentElement;
  if (docEl.scrollWidth > docEl.clientWidth + 1) {
    issues.documentOverflow = {
      scrollWidth: docEl.scrollWidth,
      clientWidth: docEl.clientWidth,
      overflowBy: docEl.scrollWidth - docEl.clientWidth,
    };
  }

  const all = Array.from(document.body ? document.body.querySelectorAll('*') : []);
  const visible = [];
  const overflowing = [];

  for (const el of all) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, style, rect)) continue;
    visible.push({ el, style, rect });

    // Горизонтальный вылет за viewport — самая частая поломка адаптива.
    {
      const right = rect.x + rect.width;
      if (right > vw + 1 || rect.x < -1) {
        overflowing.push({
          el,
          selector: cssPath(el),
          text: label(el),
          box: box(rect),
          right,
          overflowRight: Math.round(Math.max(0, right - vw)),
          overflowLeft: Math.round(Math.max(0, -rect.x)),
        });
      }
    }

    // Обрезанный текст: контент не влезает в собственную коробку.
    if (issues.clippedText.length < maxItems) {
      const hidesOverflow = /hidden|clip|auto|scroll/.test(style.overflow + style.overflowX + style.overflowY);
      const hasOwnText = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.nodeValue.trim().length > 0,
      );
      if (hasOwnText && hidesOverflow) {
        const clippedX = el.scrollWidth > el.clientWidth + 1;
        const clippedY = el.scrollHeight > el.clientHeight + 1;
        if (clippedX || clippedY) {
          issues.clippedText.push({
            selector: cssPath(el),
            text: label(el),
            box: box(rect),
            axis: clippedX && clippedY ? 'both' : clippedX ? 'x' : 'y',
            hiddenPx: clippedX
              ? el.scrollWidth - el.clientWidth
              : el.scrollHeight - el.clientHeight,
            hasTitle: el.hasAttribute('title'),
            ellipsis: style.textOverflow === 'ellipsis',
          });
        }
      }
    }

    // Тач-таргеты меньше порога — по WCAG 2.2 «Target Size (Minimum)».
    if (issues.tinyTargets.length < maxItems) {
      const interactive =
        el.matches('a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]') &&
        !el.matches('input[type="hidden"]');
      if (interactive && (rect.width < minTarget || rect.height < minTarget)) {
        issues.tinyTargets.push({
          selector: cssPath(el),
          text: label(el),
          box: box(rect),
          minRequired: minTarget,
        });
      }
    }

    // Контраст текста: считаем только для узлов с собственным текстом.
    if (issues.lowContrast.length < maxItems) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.nodeValue.trim())
        .join('')
        .trim();
      if (ownText.length > 1) {
        const fg = parseColor(style.color);
        if (fg && fg.a > 0.5) {
          const bg = effectiveBackground(el);
          const ratio = contrast(fg, bg);
          const size = parseFloat(style.fontSize) || 16;
          const bold = Number(style.fontWeight) >= 700;
          const large = size >= 24 || (size >= 18.66 && bold);
          const required = large ? 3 : contrastRatio;
          if (ratio < required) {
            issues.lowContrast.push({
              selector: cssPath(el),
              text: ownText.slice(0, 60),
              ratio: Math.round(ratio * 100) / 100,
              required,
              color: style.color,
              background: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
              fontSize: style.fontSize,
            });
          }
        }
      }
    }
  }

  // Предок и потомок вылезают на одну и ту же величину — виноват кто-то один.
  // Оставляем самого глубокого: он и есть источник, остальные лишь растянуты им.
  const overflowSet = new Set(overflowing.map((o) => o.el));
  issues.overflowingElements = overflowing
    .filter((o) => {
      const parent = o.el.parentElement;
      if (!parent || !overflowSet.has(parent)) return true;
      const parentRight = parent.getBoundingClientRect().right;
      return Math.abs(parentRight - o.right) > 1;
    })
    .sort((a, b) => b.overflowRight + b.overflowLeft - (a.overflowRight + a.overflowLeft))
    .slice(0, maxItems)
    .map(({ el, right, ...rest }) => rest);

  for (const img of Array.from(document.images)) {
    const rect = img.getBoundingClientRect();
    if (img.complete && img.naturalWidth === 0) {
      issues.brokenImages.push({
        selector: cssPath(img),
        src: img.currentSrc || img.src || '(пусто)',
        alt: img.getAttribute('alt'),
        box: box(rect),
      });
    }
    const style = getComputedStyle(img);
    // Судим по атрибутам и aspect-ratio: computed height у загруженной картинки
    // всегда конкретные пиксели, по нему «размер задан» не отличить.
    const sized =
      (img.hasAttribute('width') && img.hasAttribute('height')) ||
      (style.aspectRatio && style.aspectRatio !== 'auto');
    if (!sized && rect.width > 0) {
      issues.imagesWithoutDimensions.push({
        selector: cssPath(img),
        src: img.currentSrc || img.src || '(пусто)',
        box: box(rect),
        why: 'нет width/height и aspect-ratio — источник сдвига layout при загрузке',
      });
    }
  }

  // Наложения ищем только среди соседей в потоке: элемент поверх другого
  // через absolute/fixed — обычно замысел, а не поломка.
  const inFlow = visible.filter(
    ({ el, style, rect }) =>
      style.position === 'static' &&
      style.float === 'none' &&
      rect.width > 8 &&
      rect.height > 8 &&
      el.parentElement,
  );
  const byParent = new Map();
  for (const item of inFlow) {
    const list = byParent.get(item.el.parentElement) || [];
    list.push(item);
    byParent.set(item.el.parentElement, list);
  }
  outer: for (const list of byParent.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (ox > 2 && oy > 2) {
          const area = ox * oy;
          const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
          if (area / smaller > 0.12) {
            issues.overlaps.push({
              a: { selector: cssPath(a.el), text: label(a.el), box: box(a.rect) },
              b: { selector: cssPath(b.el), text: label(b.el), box: box(b.rect) },
              overlapPx: { w: Math.round(ox), h: Math.round(oy) },
              share: Math.round((area / smaller) * 100) / 100,
            });
            if (issues.overlaps.length >= maxItems) break outer;
          }
        }
      }
    }
  }

  const counts = Object.fromEntries(
    Object.entries(issues).map(([k, v]) => [k, Array.isArray(v) ? v.length : v ? 1 : 0]),
  );
  return {
    viewport: { width: vw, height: vh },
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    issues,
  };
}

export async function layoutAudit(page, { minTarget = 24, contrastRatio = 4.5, maxItems = 50 } = {}) {
  return page.evaluate(collectLayoutIssues, { minTarget, contrastRatio, maxItems });
}

/** Дамп вычисленных стилей — «почему этот блок не там, где я жду». */
export async function computedStyles(page, selector, props) {
  return page.evaluate(
    ({ selector, props }) => {
      const el = document.querySelector(selector);
      if (!el) return { found: false, selector };
      const style = getComputedStyle(el);
      const wanted =
        props && props.length
          ? props
          : [
              'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
              'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
              'margin', 'padding', 'border', 'box-sizing', 'overflow',
              'flex', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap',
              'grid-template-columns', 'grid-template-rows', 'grid-area',
              'font-family', 'font-size', 'font-weight', 'line-height', 'color',
              'background-color', 'text-overflow', 'white-space', 'transform', 'opacity',
            ];
      const rect = el.getBoundingClientRect();
      return {
        found: true,
        selector,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        scroll: { scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight },
        styles: Object.fromEntries(wanted.map((p) => [p, style.getPropertyValue(p)])),
      };
    },
    { selector, props },
  );
}
