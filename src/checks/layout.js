/**
 * Эвристики вёрстки: то, что видно глазом на скриншоте, но здесь возвращается
 * текстом с селекторами — агенту дешевле читать и сразу понятно, что чинить.
 */

function collectLayoutIssues(options) {
  const { minTarget, contrastRatio, maxItems, categories, include, exclude } = options;

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

  /**
   * Адрес картинки для отчёта. Инлайн-картинка приезжает сюда целиком: страница
   * с двумя-тремя десятками data:-URI раздувала ответ до мегабайта, и он переставал
   * помещаться в лимит — отчёт пропадал ровно там, где было что показать.
   */
  const shortSrc = (img) => {
    const src = img.currentSrc || img.src || '';
    if (!src) return '(пусто)';
    if (src.startsWith('data:')) {
      const head = src.slice(0, src.indexOf(',') + 1) || 'data:';
      return `${head}…(${Math.round(src.length / 1024)} КБ)`;
    }
    return src.length > 200 ? `${src.slice(0, 200)}…` : src;
  };

  const isVisible = (el, style, rect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    Number(style.opacity) !== 0;

  /**
   * Приём «скрыто визуально, доступно скринридеру»: крошечная коробка с clip.
   * Такой узел обрезан намеренно и обрезанным текстом не считается.
   */
  const isScreenReaderOnly = (el, style, rect) =>
    (rect.width <= 2 && rect.height <= 2) ||
    (style.clipPath && style.clipPath !== 'none') ||
    (style.clip && style.clip !== 'auto');

  /**
   * Слайдеры и карусели шире своей рамки намеренно — рамка их и обрезает.
   *
   * Обход останавливается на body: `body { overflow-x: hidden }` — самый ходовой способ
   * убрать горизонтальную полосу, не убирая её причину. Считать его намеренной рамкой
   * значило бы разом объявить намеренной всю страницу и отдать пустой отчёт ровно там,
   * где имя виновника нужнее всего.
   */
  const insideScrollClip = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return true;
      node = node.parentElement;
    }
    return false;
  };

  /**
   * Прямоугольник, в котором элемент реально может быть виден: его собственная коробка,
   * пересечённая с client-боксами всех обрезающих предков.
   *
   * Нужен там, где мы судим по координатам. Уехавшая за край скролл-контейнера строка
   * списка сохраняет getBoundingClientRect() внутри экрана, хотя на экране её нет, и
   * проба точкой попадает в то, что нарисовано поверх — обычно в подвал. Без этой
   * поправки клип принимается за перекрытие.
   *
   * Возвращает null, если видимой площади не осталось.
   */
  const clippedRect = (el, rect) => {
    let top = rect.top;
    let left = rect.left;
    let right = rect.right;
    let bottom = rect.bottom;

    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        // Содержимое обрезается по client-боксу: он начинается за рамкой и не включает
        // полосу прокрутки, которая тоже закрывает содержимое.
        const r = node.getBoundingClientRect();
        const clientLeft = r.left + (parseFloat(s.borderLeftWidth) || 0);
        const clientTop = r.top + (parseFloat(s.borderTopWidth) || 0);
        if (s.overflowX !== 'visible') {
          left = Math.max(left, clientLeft);
          right = Math.min(right, clientLeft + node.clientWidth);
        }
        if (s.overflowY !== 'visible') {
          top = Math.max(top, clientTop);
          bottom = Math.min(bottom, clientTop + node.clientHeight);
        }
        if (right - left <= 0 || bottom - top <= 0) return null;
      }
      node = node.parentElement;
    }

    return { top, left, right, bottom, width: right - left, height: bottom - top };
  };

  /**
   * Под текстом может лежать изображение — и как CSS-фон, и отдельным <img>
   * под абсолютным позиционированием. В обоих случаях численный контраст
   * посчитать нельзя: сравнивать пришлось бы с пикселями фотографии.
   */
  const backgroundIsImage = (el, rect) => {
    let node = el;
    while (node && node.nodeType === 1) {
      const s = getComputedStyle(node);
      // Градиент — не фотография: по нему контраст всё ещё можно оценить.
      if (s.backgroundImage && s.backgroundImage.includes('url(')) return true;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0.5) break;
      node = node.parentElement;
    }
    // elementsFromPoint видит только текущий экран. Для элементов ниже сгиба
    // точка попала бы в чужой узел, поэтому там судим только по CSS-фону.
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (x < 0 || x > vw || y < 0 || y > vh) return false;

    const stack = document.elementsFromPoint(x, y);
    const self = stack.indexOf(el);
    if (self === -1) return false; // элемент чем-то перекрыт — судить не о чем

    for (const under of stack.slice(self + 1)) {
      if (/^(img|picture|video|canvas|svg)$/i.test(under.tagName)) return true;
      const s = getComputedStyle(under);
      if (s.backgroundImage && s.backgroundImage.includes('url(')) return true;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0.5) return false;
    }
    return false;
  };

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
    boxOverflow: [],
    overflowingElements: [],
    overlaps: [],
    clippedText: [],
    brokenImages: [],
    imagesWithoutDimensions: [],
    tinyTargets: [],
    lowContrast: [],
    textOverImage: [],
    coveredText: [],
    deadZIndex: [],
  };

  const docEl = document.documentElement;
  if (docEl.scrollWidth > docEl.clientWidth + 1) {
    issues.documentOverflow = {
      scrollWidth: docEl.scrollWidth,
      clientWidth: docEl.clientWidth,
      overflowBy: docEl.scrollWidth - docEl.clientWidth,
    };
  }

  /*
   * Область разбора.
   *
   * Без include берём всё тело — так было и раньше. С include проверяются только
   * перечисленные блоки вместе с их содержимым: шапка и подвал на странице те же, что вчера,
   * и их мелкие тач-таргеты с низким контрастом перебивают собой то, ради чего разбор и
   * затевали. exclude отрезает ветки уже внутри выбранного.
   *
   * Счётчики считаются по этому же набору: смысл сужения в том, чтобы уходили и подробности,
   * и числа, иначе в ответе остаётся тот же шум, только без имён.
   */
  const roots = include && include.length
    ? include.flatMap((sel) => {
        try {
          return Array.from(document.querySelectorAll(sel));
        } catch {
          return [];
        }
      })
    : document.body
      ? [document.body]
      : [];

  const seen = new Set();
  const picked = [];
  for (const root of roots) {
    // Сам указанный блок тоже проверяется — в отличие от body, который узлом разбора не был.
    if (include && include.length && !seen.has(root)) {
      seen.add(root);
      picked.push(root);
    }
    for (const el of root.querySelectorAll('*')) {
      if (seen.has(el)) continue;
      seen.add(el);
      picked.push(el);
    }
  }

  const dropped = (el) =>
    (exclude || []).some((sel) => {
      try {
        return Boolean(el.closest(sel));
      } catch {
        return false;
      }
    });

  const all = exclude && exclude.length ? picked.filter((el) => !dropped(el)) : picked;
  const inScope = new Set(all);
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
      if ((right > vw + 1 || rect.x < -1) && !insideScrollClip(el)) {
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
      if (hasOwnText && hidesOverflow && !isScreenReaderOnly(el, style, rect)) {
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

    // z-index на неспозиционированном элементе не действует — правка, которая
    // выглядит сделанной, но ничего не меняет. Ложных срабатываний тут нет:
    // исключение одно, элементы flex/grid-контейнера.
    if (issues.deadZIndex.length < maxItems && style.zIndex !== 'auto' && style.position === 'static') {
      const parent = el.parentElement;
      const flexItem = parent && /flex|grid/.test(getComputedStyle(parent).display);
      if (!flexItem) {
        issues.deadZIndex.push({
          selector: cssPath(el),
          zIndex: style.zIndex,
          why: 'z-index применяется только к позиционированным элементам и к элементам flex/grid-контейнера',
        });
      }
    }

    // Текст, закрытый непрозрачным слоем. Частый исход правки оверлеев и «шапок».
    if (issues.coveredText.length < maxItems) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.nodeValue.trim())
        .join(' ')
        .trim();
      // Судим по видимой части: у элемента, обрезанного своим скролл-контейнером,
      // координаты остаются экранными, и проба попала бы в чужой узел.
      const visibleRect = ownText.length > 1 ? clippedRect(el, rect) : null;
      const onScreen =
        visibleRect &&
        visibleRect.top >= 0 &&
        visibleRect.left >= 0 &&
        visibleRect.bottom <= vh &&
        visibleRect.right <= vw;
      if (onScreen && visibleRect.width > 4 && visibleRect.height > 4) {
        const r = visibleRect;
        // Точки разнесены и по вертикали: на одной горизонтали любая широкая плашка
        // накрывает все три разом, и узкое перекрытие не отличить от сплошного.
        const points = [
          [r.left + r.width * 0.15, r.top + r.height * 0.25],
          [r.left + r.width * 0.5, r.top + r.height * 0.5],
          [r.left + r.width * 0.85, r.top + r.height * 0.75],
        ];
        let cover = null;
        let coveredCount = 0;
        for (const [x, y] of points) {
          const stack = document.elementsFromPoint(x, y);
          const top = stack[0];
          // Элемента нет в стеке вовсе — его закрывает не слой, а обрезка предком
          // либо он вынесен из потока отрисовки. Это не перекрытие текста.
          if (!top || top === el || el.contains(top) || !stack.includes(el)) continue;
          // pointer-events: none поднимает наверх предка самого элемента —
          // собственный фон перекрытием не считается.
          if (top.contains(el)) continue;
          const ts = getComputedStyle(top);
          const bg = parseColor(ts.backgroundColor);
          const opaque =
            /^(img|video|canvas|iframe)$/i.test(top.tagName) ||
            (bg && bg.a > 0.9) ||
            (ts.backgroundImage && ts.backgroundImage.includes('url('));
          if (opaque) {
            coveredCount += 1;
            cover = cover || top;
          }
        }
        if (coveredCount === points.length) {
          issues.coveredText.push({
            selector: cssPath(el),
            text: ownText.slice(0, 60),
            coveredBy: cssPath(cover),
            box: box(rect),
            why: 'во всех пробных точках сверху лежит непрозрачный элемент — текст не виден',
          });
        }
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
        const overImage = backgroundIsImage(el, rect);
        if (overImage && issues.textOverImage.length < maxItems) {
          issues.textOverImage.push({
            selector: cssPath(el),
            text: ownText.slice(0, 60),
            color: style.color,
            fontSize: style.fontSize,
            why: 'текст поверх изображения — контраст числом не измерить, проверьте глазами на скриншоте',
          });
        }
        const fg = overImage ? null : parseColor(style.color);
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
    // Картинки живут отдельным списком документа, поэтому сужение применяем к ним явно.
    if (!inScope.has(img)) continue;
    const rect = img.getBoundingClientRect();
    /*
     * Подменённая заглушкой картинка грузится, и по naturalWidth её уже не отличить от
     * нормальной. Но подмена — приём для сравнения вёрстки, а не способ убрать проблему
     * из отчёта: метку ставит стабилизация, и находкой такая картинка остаётся.
     */
    const stubbed = img.dataset && 'ltPlaceholder' in img.dataset;
    if ((stubbed || (img.complete && img.naturalWidth === 0)) && issues.brokenImages.length < maxItems) {
      issues.brokenImages.push({
        selector: cssPath(img),
        src: shortSrc(img),
        alt: img.getAttribute('alt'),
        box: box(rect),
        ...(stubbed ? { placeholder: true, note: 'подменена заглушкой ради сравнимой вёрстки' } : {}),
      });
    }
    const style = getComputedStyle(img);
    // Судим по атрибутам и aspect-ratio: computed height у загруженной картинки
    // всегда конкретные пиксели, по нему «размер задан» не отличить.
    const sized =
      (img.hasAttribute('width') && img.hasAttribute('height')) ||
      (style.aspectRatio && style.aspectRatio !== 'auto');
    if (!sized && rect.width > 0 && issues.imagesWithoutDimensions.length < maxItems) {
      issues.imagesWithoutDimensions.push({
        selector: cssPath(img),
        src: shortSrc(img),
        box: box(rect),
        why: 'нет width/height и aspect-ratio — источник сдвига layout при загрузке',
      });
    }
  }

  // Наложения ищем только среди соседей в потоке: элемент поверх другого
  // через absolute/fixed — обычно замысел, а не поломка.
  // И только между носителями текста: текст поверх картинки — приём вёрстки,
  // а вот текст поверх текста читать нельзя, и это всегда дефект.
  const hasText = (el) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1);
  const inFlow = visible.filter(
    ({ el, style, rect }) =>
      style.position === 'static' &&
      style.float === 'none' &&
      rect.width > 8 &&
      rect.height > 8 &&
      el.parentElement &&
      hasText(el),
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

  /*
   * Содержимое вылезло за свой блок.
   *
   * Это не то же самое, что вылет за viewport: карточка остаётся на месте, а из неё торчит
   * заголовок в три строки — или не торчит, потому что обрезан. Такое находится только при
   * сравнении ребёнка с коробкой родителя, и именно этим ломается вёрстка при длинном контенте.
   * Абсолютные и фиксированные дети не в счёт: их вынесли за край нарочно.
   */
  for (const { el, style, rect } of visible) {
    if (issues.boxOverflow.length >= maxItems) break;
    const clips = /hidden|clip|auto|scroll/.test(style.overflow + style.overflowX + style.overflowY);
    const painted =
      clips ||
      style.backgroundImage !== 'none' ||
      !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor) ||
      parseFloat(style.borderTopWidth) > 0 ||
      parseFloat(style.borderBottomWidth) > 0 ||
      parseFloat(style.borderLeftWidth) > 0 ||
      parseFloat(style.borderRightWidth) > 0;
    if (!painted || rect.width < 16 || rect.height < 16) continue;

    for (const child of el.children) {
      const childStyle = getComputedStyle(child);
      if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
      const childRect = child.getBoundingClientRect();
      if (!isVisible(child, childStyle, childRect)) continue;
      const out = {
        top: Math.round(rect.top - childRect.top),
        right: Math.round(childRect.right - rect.right),
        bottom: Math.round(childRect.bottom - rect.bottom),
        left: Math.round(rect.left - childRect.left),
      };
      const worst = Math.max(out.top, out.right, out.bottom, out.left);
      if (worst <= 1) continue;
      issues.boxOverflow.push({
        selector: cssPath(el),
        child: cssPath(child),
        text: label(child),
        box: box(rect),
        overflowPx: Object.fromEntries(Object.entries(out).filter(([, value]) => value > 1)),
        /* Обрезано или торчит — чинится по-разному: первое прячет контент, второе ломает соседей. */
        clipped: clips,
      });
      if (issues.boxOverflow.length >= maxItems) break;
    }
  }

  const counts = Object.fromEntries(
    Object.entries(issues).map(([k, v]) => [k, Array.isArray(v) ? v.length : v ? 1 : 0]),
  );

  // Счётчики нужны всегда: по ним видно, что категория непустая, даже когда
  // подробности по ней не запрашивали.
  const wanted = Array.isArray(categories) && categories.length ? new Set(categories) : null;
  const shown = wanted
    ? Object.fromEntries(Object.entries(issues).filter(([k]) => wanted.has(k)))
    : issues;

  return {
    viewport: { width: vw, height: vh },
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    ...(wanted ? { categories: [...wanted] } : {}),
    /* Сужение показываем в ответе: иначе пустой отчёт по опечатке в селекторе не отличить
       от пустого отчёта по здоровой странице. */
    ...(include?.length || exclude?.length
      ? { scope: { ...(include?.length ? { include, nodes: all.length } : {}), ...(exclude?.length ? { exclude } : {}) } }
      : {}),
    issues: shown,
  };
}

export const AUDIT_CATEGORIES = [
  'documentOverflow',
  'boxOverflow',
  'overflowingElements',
  'overlaps',
  'clippedText',
  'brokenImages',
  'imagesWithoutDimensions',
  'tinyTargets',
  'lowContrast',
  'textOverImage',
  'coveredText',
  'deadZIndex',
];

export async function layoutAudit(
  page,
  { minTarget = 24, contrastRatio = 4.5, maxItems = 50, categories = null, include = null, exclude = null } = {},
) {
  return page.evaluate(collectLayoutIssues, { minTarget, contrastRatio, maxItems, categories, include, exclude });
}

/** Дамп вычисленных стилей — «почему этот блок не там, где я жду». */
export async function computedStyles(page, selector, props, { pseudo = null, all = false, maxItems = 20 } = {}) {
  return page.evaluate(
    ({ selector, props, pseudo, all, maxItems }) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (!nodes.length) return { found: false, selector, pseudo };

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
              'background-color', 'background-image', 'text-overflow', 'white-space',
              'transform', 'opacity', 'visibility', 'pointer-events',
              // Без content псевдоэлемент не отличить от несуществующего.
              ...(pseudo ? ['content'] : []),
            ];

      const dump = (el) => {
        const style = getComputedStyle(el, pseudo || undefined);
        const rect = el.getBoundingClientRect();
        return {
          box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          scroll: { scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight },
          styles: Object.fromEntries(wanted.map((p) => [p, style.getPropertyValue(p)])),
        };
      };

      const base = { found: true, selector, pseudo: pseudo || null, count: nodes.length };
      // Псевдоэлемента может не быть вовсе: content: none — значит правило не сработало.
      if (pseudo && getComputedStyle(nodes[0], pseudo).content === 'none') {
        base.note = `Псевдоэлемент ${pseudo} не создаётся: content: none.`;
      }
      if (!all) {
        if (nodes.length > 1) base.note = `${base.note ? `${base.note} ` : ''}Совпадений ${nodes.length}, показан первый — передайте all: true для остальных.`;
        return { ...base, ...dump(nodes[0]) };
      }
      return { ...base, matches: nodes.slice(0, maxItems).map(dump) };
    },
    { selector, props, pseudo, all, maxItems },
  );
}
