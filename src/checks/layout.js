/**
 * Эвристики вёрстки: то, что видно глазом на скриншоте, но здесь возвращается
 * текстом с селекторами — агенту дешевле читать и сразу понятно, что чинить.
 */

function collectLayoutIssues(options) {
  const { minTarget, contrastRatio, maxItems: shownMax, categories, include, exclude, frozen, inkMargin = 8, overlapIgnore = null, outsideTotal: OUTSIDE_TOTAL = [] } = options;
  /*
   * Потолок сбора и потолок показа — разные числа.
   *
   * Раньше сбор останавливался на maxItems, и счётчик считался по обрезанному списку: в сводке
   * по ширинам, где maxItems равен 10, мобильная страница с 26 мелкими тач-таргетами получала
   * tinyTargets: 10 — ровно столько же, сколько десктоп. Масштаб беды пропадал. Теперь собирается
   * до COLLECT_CAP, счётчик честный, а в ответ идёт первые shownMax.
   */
  const COLLECT_CAP = 500;
  const maxItems = Math.max(shownMax, COLLECT_CAP);

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

  /*
   * Зона нажатия с учётом ::before и ::after.
   *
   * Точку пагинации в 12px дотягивают до 24px псевдоэлементом с inset: -6px — и она кликабельна
   * на всей площади, а getBoundingClientRect об этом не знает. Абсолютно спозиционированный
   * псевдоэлемент восстанавливается по его top/right/bottom/left/width/height относительно
   * коробки элемента; всё остальное (статичные, inline) зону не расширяет.
   */
  const effectiveTarget = (el, rect) => {
    let x0 = rect.left;
    let y0 = rect.top;
    let x1 = rect.right;
    let y1 = rect.bottom;
    const extendedBy = [];
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (!ps || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
      if (ps.position !== 'absolute' && ps.position !== 'fixed') continue;
      const num = (value) => {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
      };
      const left = num(ps.left);
      const right = num(ps.right);
      const top = num(ps.top);
      const bottom = num(ps.bottom);
      const w = num(ps.width);
      const h = num(ps.height);
      const px0 = left !== null ? rect.left + left : right !== null && w !== null ? rect.right - right - w : rect.left;
      const px1 = right !== null ? rect.right - right : w !== null ? px0 + w : rect.right;
      const py0 = top !== null ? rect.top + top : bottom !== null && h !== null ? rect.bottom - bottom - h : rect.top;
      const py1 = bottom !== null ? rect.bottom - bottom : h !== null ? py0 + h : rect.bottom;
      if (px1 - px0 <= 0 || py1 - py0 <= 0) continue;
      if (px0 < x0 || py0 < y0 || px1 > x1 || py1 > y1) extendedBy.push(pseudo);
      x0 = Math.min(x0, px0);
      y0 = Math.min(y0, py0);
      x1 = Math.max(x1, px1);
      y1 = Math.max(y1, py1);
    }
    return { w: x1 - x0, h: y1 - y0, extendedBy, bounds: { left: x0, top: y0, right: x1, bottom: y1 } };
  };
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
      if (/^(img|picture|video|canvas|svg)$/i.test(under.tagName)) return under;
      const s = getComputedStyle(under);
      if (s.backgroundImage && s.backgroundImage.includes('url(')) return true;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0.5) return false;
    }
    return false;
  };

  /**
   * Чернила картинки под текстом: доля непрозрачных пикселей <img> под строками текста.
   *
   * Подписи «Преимуществ» пересекали прозрачную PNG-схему на 285×65 px, и textOverImage говорил
   * то же, что про текст над пустым углом той же картинки: рамка на рамке. Прозрачное поле PNG —
   * не фон под текстом, а сама схема — да. Считается по строкам (getClientRects текстовых узлов),
   * а не по рамке блока: пустое поле блока разбавляло долю. Картинка с чужого домена без CORS
   * пиксели не отдаёт: тогда ink: null и вердикт глазами.
   *
   * Маска картинки строится один раз — альфа-канал уменьшенной копии и интегральная таблица по
   * нему, — и любой прямоугольник проверяется за O(1). На этом держится подбор clearance: сотни
   * проб масштаба и сдвига на находку.
   */
  const masks = new Map();
  const inkMask = (img) => {
    if (masks.has(img)) return masks.get(img);
    let mask = null;
    if (img && img.tagName === 'IMG' && img.complete && img.naturalWidth) {
      const frame = img.getBoundingClientRect();
      const k = Math.min(1, 400 / Math.max(frame.width, frame.height, 1));
      const w = Math.max(1, Math.round(frame.width * k));
      const h = Math.max(1, Math.round(frame.height * k));
      /* object-fit: картинка не обязательно растянута на всю рамку. */
      const fit = getComputedStyle(img).objectFit;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      let scale = null;
      if (fit === 'contain') scale = Math.min(frame.width / nw, frame.height / nh);
      else if (fit === 'cover') scale = Math.max(frame.width / nw, frame.height / nh);
      else if (fit === 'none') scale = 1;
      else if (fit === 'scale-down') scale = Math.min(1, frame.width / nw, frame.height / nh);
      const cw = scale ? nw * scale : frame.width;
      const ch = scale ? nh * scale : frame.height;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, ((frame.width - cw) / 2) * k, ((frame.height - ch) / 2) * k, cw * k, ch * k);
        const data = ctx.getImageData(0, 0, w, h).data;
        const sat = new Int32Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y += 1) {
          let row = 0;
          for (let x = 0; x < w; x += 1) {
            if (data[(y * w + x) * 4 + 3] > 25) row += 1;
            sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
          }
        }
        mask = { frame, k, w, h, sat };
      } catch {
        mask = null;
      }
    }
    masks.set(img, mask);
    return mask;
  };

  /* Чернила в прямоугольнике экрана: ink — пикселей маски, area — площадь пересечения с картинкой. */
  const inkIn = (mask, r) => {
    const { frame, k, w, h, sat } = mask;
    const x0 = Math.max(0, Math.floor((r.left - frame.left) * k));
    const y0 = Math.max(0, Math.floor((r.top - frame.top) * k));
    const x1 = Math.min(w, Math.ceil((r.right - frame.left) * k));
    const y1 = Math.min(h, Math.ceil((r.bottom - frame.top) * k));
    if (x1 <= x0 || y1 <= y0) return { ink: 0, area: 0 };
    const at = (x, y) => sat[y * (w + 1) + x];
    return { ink: at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0), area: (x1 - x0) * (y1 - y0) };
  };

  /* Строки собственного текста элемента; без них — его рамка. */
  const textLines = (el, rect) => {
    const out = [];
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        if (line.width > 1 && line.height > 1) out.push({ left: line.left, top: line.top, right: line.right, bottom: line.bottom });
      }
    }
    return out.length ? out : [{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
  };

  const inkUnder = (img, lines) => {
    const mask = inkMask(img);
    if (!mask) return null;
    let ink = 0;
    let area = 0;
    for (const line of lines) {
      const part = inkIn(mask, line);
      ink += part.ink;
      area += part.area;
    }
    return area ? Math.round((ink / area) * 100) / 100 : 0;
  };

  /**
   * Насколько развести текст и картинку: минимальное уменьшение картинки к её центру и минимальный
   * сдвиг в каждую сторону, при которых под строками с отступом margin чернил не больше 1%.
   *
   * Без этого находка говорила только «пересекается», а масштаб схемы «Преимуществ» (чисто с 0.92)
   * считали руками: рисовали картинку в canvas и проверяли пиксели под строками.
   */
  const clearanceOf = (img, lines, margin) => {
    const mask = inkMask(img);
    if (!mask) return null;
    const { frame } = mask;
    const padded = lines.map((line) => ({ left: line.left - margin, top: line.top - margin, right: line.right + margin, bottom: line.bottom + margin }));
    const clean = (map) =>
      padded.every((line) => {
        const r = map(line);
        /* Доля — от площади строки, а не пересечения: строка, задевшая картинку краем, чиста. */
        const full = (r.right - r.left) * (r.bottom - r.top) * mask.k * mask.k;
        return inkIn(mask, r).ink <= Math.max(0.5, full * 0.01);
      });
    const cx = frame.left + frame.width / 2;
    const cy = frame.top + frame.height / 2;
    let scale = null;
    for (let step = 99; step >= 50; step -= 1) {
      const s = step / 100;
      /* Уменьшенная картинка под строкой — то же, что строка, растянутая от центра исходной. */
      const map = (r) => ({ left: cx + (r.left - cx) / s, right: cx + (r.right - cx) / s, top: cy + (r.top - cy) / s, bottom: cy + (r.bottom - cy) / s });
      if (clean(map)) {
        scale = s;
        break;
      }
    }
    const shiftBy = (dx, dy, limit) => {
      for (let d = 2; d <= limit; d += 2) {
        if (clean((r) => ({ left: r.left - dx * d, right: r.right - dx * d, top: r.top - dy * d, bottom: r.bottom - dy * d }))) return d;
      }
      return null;
    };
    return {
      margin,
      scale,
      shift: {
        left: shiftBy(-1, 0, frame.width / 2),
        right: shiftBy(1, 0, frame.width / 2),
        up: shiftBy(0, -1, frame.height / 2),
        down: shiftBy(0, 1, frame.height / 2),
      },
    };
  };

  const clearanceText = (clearance) => {
    if (!clearance) return '';
    const words = { left: 'влево', right: 'вправо', up: 'вверх', down: 'вниз' };
    const shifts = Object.entries(clearance.shift)
      .filter(([, value]) => value !== null)
      .sort((a, b) => a[1] - b[1]);
    const parts = [
      ...(clearance.scale !== null ? [`scale ${clearance.scale} к центру`] : []),
      ...(shifts.length ? [`сдвиге картинки ${words[shifts[0][0]]} на ${shifts[0][1]}px`] : []),
    ];
    return parts.length
      ? `; с отступом ${clearance.margin}px от строк чисто при ${parts.join(' или ')}`
      : `; в пределах scale 0.5 и сдвига на полкартинки чисто с отступом ${clearance.margin}px не становится — разводите вёрсткой`;
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
    contentOverflow: [],
    controlOverlaps: [],
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
  const TARGETS = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [onclick]';
  const CONTROLS =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"]';
  const targets = [];
  const tinyCandidates = [];
  const controls = [];
  let textBlocks = 0;

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

    if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1)) textBlocks += 1;
    if (el.matches(CONTROLS)) controls.push({ el, style, rect });

    // Тач-таргеты меньше порога — по WCAG 2.2 «Target Size (Minimum)». Решение — после обхода:
    // исключение Spacing судит по соседним целям, а они ещё не собраны.
    if (el.matches(TARGETS) && !isScreenReaderOnly(el, style, rect)) {
      const small = rect.width < minTarget || rect.height < minTarget;
      const effective = small ? effectiveTarget(el, rect) : null;
      const target = { el, style, rect, effective, bounds: effective ? effective.bounds : rect };
      targets.push(target);
      if (effective && (effective.w < minTarget || effective.h < minTarget)) tinyCandidates.push(target);
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
        /* Две точки из трёх — уже половина строки под чужим слоем; три из трёх требовали
           закрытия целиком, и подпись, закрытая снизу, проходила чистой. */
        if (coveredCount >= 2) {
          issues.coveredText.push({
            selector: cssPath(el),
            text: ownText.slice(0, 60),
            coveredBy: cssPath(cover),
            box: box(rect),
            why:
              coveredCount === points.length
                ? 'во всех пробных точках сверху лежит непрозрачный элемент — текст не виден'
                : 'в двух пробных точках из трёх сверху лежит непрозрачный элемент — текст закрыт частично',
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
        const lines = overImage && overImage !== true ? textLines(el, rect) : null;
        const ink = lines ? inkUnder(overImage, lines) : null;
        /* Текст над прозрачным полем PNG — не над картинкой: чернил под ним нет. */
        if (overImage && ink !== 0 && issues.textOverImage.length < maxItems) {
          const clearance = ink > 0.05 ? clearanceOf(overImage, lines, inkMargin) : null;
          issues.textOverImage.push({
            selector: cssPath(el),
            text: ownText.slice(0, 60),
            color: style.color,
            fontSize: style.fontSize,
            ink,
            ...(overImage !== true ? { image: cssPath(overImage) } : {}),
            ...(clearance ? { clearance } : {}),
            why:
              ink === null
                ? 'текст поверх изображения — контраст числом не измерить, проверьте глазами на скриншоте'
                : ink > 0.05
                  ? `текст лежит на нарисованной части картинки (${Math.round(ink * 100)}% пикселей под строками непрозрачны) — разведите текст и картинку или проверьте, что так в макете${clearanceText(clearance)}`
                  : 'под текстом почти прозрачная часть картинки — скорее всего, читается',
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

  /*
   * Мелкие цели и исключения WCAG 2.5.8.
   *
   * Флажок Primer 16×16 с подписью давал 16–18 находок на страницу, и все они валили page_ready,
   * хотя критерий их не требует. Три исключения из текста критерия:
   *   - подпись: клик по связанному label активирует контрол, и зона нажатия — объединение;
   *   - строка текста: ссылка внутри предложения (Inline);
   *   - промежуток: круг диаметром minTarget с центром в цели не задевает другие цели и круги
   *     других мелких целей (Spacing).
   * Прошедшие по исключению не пропадают молча — их число в tinyTargetsExempt с разбивкой.
   */
  const tinyExempt = { label: 0, inline: 0, spacing: 0 };
  const tinySpaced = [];
  {
    const union = (a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    const labelsOf = (el) =>
      Array.from(el.labels || []).filter((l) => {
        const r = l.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    for (const target of targets) {
      target.labels = labelsOf(target.el);
      for (const l of target.labels) target.bounds = union(target.bounds, l.getBoundingClientRect());
    }
    const small = new Set(tinyCandidates);
    const r = minTarget / 2;
    const center = (b) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
    const distToRect = (p, b) => Math.hypot(Math.max(b.left - p.x, 0, p.x - b.right), Math.max(b.top - p.y, 0, p.y - b.bottom));
    const sentence = (el, style) =>
      el.tagName === 'A' &&
      style.display === 'inline' &&
      Array.from(el.parentElement?.childNodes || []).some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1);

    for (const target of tinyCandidates) {
      const { el, style, rect, effective, bounds, labels } = target;
      const w = bounds.right - bounds.left;
      const h = bounds.bottom - bounds.top;
      if (labels.length && w >= minTarget && h >= minTarget) {
        tinyExempt.label += 1;
        continue;
      }
      if (sentence(el, style)) {
        tinyExempt.inline += 1;
        continue;
      }
      const c = center(bounds);
      const crowded = targets.find((other) => {
        if (other === target || other.el.contains(el) || el.contains(other.el)) return false;
        if (distToRect(c, other.bounds) < r) return true;
        if (!small.has(other)) return false;
        const oc = center(other.bounds);
        return Math.hypot(c.x - oc.x, c.y - oc.y) < minTarget;
      });
      /*
       * Флажок с подписью, прошедший по промежутку, — штатный компонент, его не показываем. Голая
       * мелкая цель с промежутком критерию тоже не нарушает, но крестик модалки 15×15 агенту
       * видеть стоит: такие идут в конец списка с exempt и в счёт не входят.
       */
      if (!crowded && labels.length) {
        tinyExempt.label += 1;
        continue;
      }
      if (!crowded) {
        tinyExempt.spacing += 1;
        if (tinySpaced.length < maxItems) {
          tinySpaced.push({
            selector: cssPath(el),
            text: label(el),
            box: box(rect),
            minRequired: minTarget,
            ...(effective.extendedBy.length
              ? { effective: { w: Math.round(effective.w), h: Math.round(effective.h) }, extendedBy: effective.extendedBy }
              : {}),
            exempt: 'spacing',
          });
        }
        continue;
      }
      if (issues.tinyTargets.length >= maxItems) continue;
      issues.tinyTargets.push({
        selector: cssPath(el),
        text: label(el),
        box: box(rect),
        minRequired: minTarget,
        ...(effective.extendedBy.length
          ? { effective: { w: Math.round(effective.w), h: Math.round(effective.h) }, extendedBy: effective.extendedBy }
          : {}),
        ...(labels.length ? { withLabel: { w: Math.round(w), h: Math.round(h) } } : {}),
        tooClose: cssPath(crowded.el),
      });
    }
  }
  const tinyCounted = issues.tinyTargets.length;
  issues.tinyTargets = [...issues.tinyTargets, ...tinySpaced];

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
   * Текст, вылезший из своего контейнера под соседа.
   *
   * На /news/detail подпись figcaption вылезала из своей figure — высота строки сетки считалась
   * по картинке, — и картинки следующей строки закрывали подписи «[1]», «[2]». Проба по
   * диагонали текста этого не видела: закрыта только выступающая полоса, а не весь текст. Здесь
   * точки ставятся именно в выступающую часть. Элементы ниже сгиба прокручиваются к себе —
   * elementsFromPoint видит только экран, — и прокрутка потом возвращается.
   */
  if (issues.coveredText.length < maxItems) {
    const inlineOnly = (el) => Array.from(el.children).every((child) => getComputedStyle(child).display.startsWith('inline'));
    const hasText = (el) => (el.textContent || '').trim().length > 1 && inlineOnly(el);
    const known = new Set(issues.coveredText.map((item) => item.selector));
    const candidates = [];
    for (const { el, style, rect } of visible) {
      if (candidates.length >= 30) break;
      if (style.position === 'absolute' || style.position === 'fixed' || !hasText(el)) continue;
      let host = el.parentElement;
      while (host && getComputedStyle(host).display.startsWith('inline')) host = host.parentElement;
      if (!host || host === document.body) continue;
      const hs = getComputedStyle(host);
      if (hs.overflowX !== 'visible' || hs.overflowY !== 'visible') continue;
      const hr = host.getBoundingClientRect();
      const out = { bottom: rect.bottom - hr.bottom, top: hr.top - rect.top, right: rect.right - hr.right, left: hr.left - rect.left };
      const side = Object.entries(out).sort((a, b) => b[1] - a[1])[0];
      if (side[1] <= 2) continue;
      candidates.push({ el, host, side: side[0], depth: side[1] });
    }
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    for (const { el, host, side, depth } of candidates) {
      if (issues.coveredText.length >= maxItems) break;
      let rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > vh) {
        window.scrollTo(scrollX, Math.max(0, window.scrollY + rect.top - vh / 3));
        rect = el.getBoundingClientRect();
      }
      const hr = host.getBoundingClientRect();
      /* Полоса, торчащая за край контейнера, — в ней и ставятся точки. */
      const strip =
        side === 'bottom'
          ? { left: rect.left, right: rect.right, top: Math.max(rect.top, hr.bottom), bottom: rect.bottom }
          : side === 'top'
            ? { left: rect.left, right: rect.right, top: rect.top, bottom: Math.min(rect.bottom, hr.top) }
            : side === 'right'
              ? { left: Math.max(rect.left, hr.right), right: rect.right, top: rect.top, bottom: rect.bottom }
              : { left: rect.left, right: Math.min(rect.right, hr.left), top: rect.top, bottom: rect.bottom };
      const y = (strip.top + strip.bottom) / 2;
      const x = (strip.left + strip.right) / 2;
      const points = side === 'bottom' || side === 'top'
        ? [0.2, 0.5, 0.8].map((k) => [strip.left + (strip.right - strip.left) * k, y])
        : [0.2, 0.5, 0.8].map((k) => [x, strip.top + (strip.bottom - strip.top) * k]);
      let cover = null;
      for (const [px, py] of points) {
        if (px < 0 || py < 0 || px > vw || py > vh) continue;
        const stack = document.elementsFromPoint(px, py);
        const top = stack[0];
        if (!top || top === el || el.contains(top) || top.contains(el)) continue;
        const ts = getComputedStyle(top);
        const bg = parseColor(ts.backgroundColor);
        if (/^(img|video|canvas|iframe|svg|picture)$/i.test(top.tagName) || (bg && bg.a > 0.9) || ts.backgroundImage.includes('url(')) {
          cover = top;
          break;
        }
      }
      const selector = cssPath(el);
      if (cover && !known.has(selector)) {
        issues.coveredText.push({
          selector,
          text: label(el),
          coveredBy: cssPath(cover),
          container: cssPath(host),
          box: box(rect),
          reason: 'вышел за контейнер',
          why: `текст вылез из ${cssPath(host)} на ${Math.round(depth)}px (${side}) и попал под ${cssPath(cover)} — высота контейнера не учитывает текст`,
        });
      }
    }
    window.scrollTo(scrollX, scrollY);
  }

  /*
   * Содержимое вылезло за свой блок.
   *
   * Это не то же самое, что вылет за viewport: карточка остаётся на месте, а из неё торчит
   * заголовок в три строки — или не торчит, потому что обрезан. Такое находится только при
   * сравнении ребёнка с коробкой родителя, и именно этим ломается вёрстка при длинном контенте.
   * Абсолютные и фиксированные дети не в счёт: их вынесли за край нарочно.
   */
  /*
   * Две корзины, и бюджет у каждой свой.
   *
   * Раньше список был один, и потолок maxItems тратился до того, как настоящий вылет отделялся
   * от намеренного клипа: на странице с бегущей строкой и каруселью пятьдесят ожидаемых записей
   * набирались первыми по порядку обхода, сбор останавливался, а counts.boxOverflow после
   * вычитания клипов показывал ноль. То есть отчёт говорил «вылетов нет» ровно там, где они
   * были, — и заметить это было нечем. Сортировка «клипы в конец» стояла после сбора и помочь
   * уже не могла.
   */
  /* Коробка, у которой вылет детей виден глазом: она обрезает, окрашена или обведена. */
  const painted = (style) =>
    /hidden|clip|auto|scroll/.test(style.overflow + style.overflowX + style.overflowY) ||
    style.backgroundImage !== 'none' ||
    !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor) ||
    parseFloat(style.borderTopWidth) > 0 ||
    parseFloat(style.borderBottomWidth) > 0 ||
    parseFloat(style.borderLeftWidth) > 0 ||
    parseFloat(style.borderRightWidth) > 0;
  /* Детей такой коробки разбирает boxOverflow; contentOverflow берёт остальные. */
  const boxChecked = (style, rect) => painted(style) && rect.width >= 16 && rect.height >= 16;
  const overflowReal = [];
  const overflowClipped = [];
  for (const { el, style, rect } of visible) {
    if (overflowReal.length >= maxItems && overflowClipped.length >= maxItems) break;
    const clips = /hidden|clip|auto|scroll/.test(style.overflow + style.overflowX + style.overflowY);
    if (!boxChecked(style, rect)) continue;

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
      const bucket = clips ? overflowClipped : overflowReal;
      if (bucket.length >= maxItems) continue;
      bucket.push({
        selector: cssPath(el),
        child: cssPath(child),
        text: label(child),
        box: box(rect),
        overflowPx: Object.fromEntries(Object.entries(out).filter(([, value]) => value > 1)),
        /* Обрезано или торчит — чинится по-разному: первое прячет контент, второе ломает соседей. */
        clipped: clips,
      });
    }
  }

  /*
   * Намеренные клипы — бегущая строка, свёрнутый аккордеон, карусель — живут в том же списке,
   * но в общий счёт не идут и стоят после настоящих вылетов: иначе они на каждом прогоне
   * забивают отчёт, и настоящая находка тонет среди ожидаемых.
   */
  issues.boxOverflow = [...overflowReal, ...overflowClipped];
  const clippedOverflow = overflowClipped.length;

  /*
   * Содержимое шире своего блока при overflow: visible.
   *
   * Кнопка в ячейке с width: 1% ужималась до паддингов (28px), а подпись шириной 72px рисовалась
   * поверх соседней ячейки — и отчёт молчал: clippedText ждёт overflow: hidden, boxOverflow
   * сравнивает только детей-элементов окрашенной коробки, а у прозрачной кнопки или у текста прямо
   * в ней такого сравнения нет. Здесь мерится то, что нарисовано: строки собственного текста и
   * дети в потоке против рамки блока. scrollWidth не годится — он включает абсолютных потомков.
   *
   * Отрицательный margin ребёнка — замысел (ряд сетки шире контейнера на гаттеры): сторона, на
   * которую ребёнок вынесен своим margin, не считается. Вылет, который срезает обрезающий предок,
   * глазом не виден и тоже не считается.
   *
   * Что лежит под вылетом, проверяется пробой: вылет поверх соседа — дефект, вылет в пустое поле
   * своего же предка — повод посмотреть. Вторые считаются отдельно в contentOverflowFree.
   */
  const contentFound = [];
  {
    const px = (v) => parseFloat(v) || 0;
    const REPLACED = /^(svg|img|input|select|textarea|iframe|video|canvas|picture|object|embed|br|hr|button)$/i;
    /* Текст, спрятанный приёмом замены картинкой: text-indent: -9999px, нулевой шрифт, прозрачный цвет. */
    const hiddenText = (style) => parseFloat(style.textIndent) < -99 || parseFloat(style.fontSize) === 0 || parseColor(style.color)?.a === 0;
    for (const { el, style, rect } of visible) {
      if (contentFound.length >= maxItems) break;
      if (el === document.body || /^(inline|contents)$/.test(style.display)) continue;
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') continue;
      if (isScreenReaderOnly(el, style, rect)) continue;
      /* У кнопки своя строка не мерится Range — её содержимое разбирается по её детям ниже,
         а голый текст кнопки — через scroll-размеры, которые у кнопки не включают абсолютных. */
      if (REPLACED.test(el.tagName) && el.tagName !== 'BUTTON') continue;

      const out = { top: 0, right: 0, bottom: 0, left: 0 };
      let cause = null;
      /* Допуск — порог, а в ответ идёт настоящий вылет: иначе 40px выглядели бы как 36. */
      const take = (r, tolX, tolY, by) => {
        const sides = { top: rect.top - r.top, right: r.right - rect.right, bottom: r.bottom - rect.bottom, left: rect.left - r.left };
        for (const [side, value] of Object.entries(sides)) {
          const tol = side === 'top' || side === 'bottom' ? tolY : tolX;
          if (value > tol && value > out[side]) {
            out[side] = value;
            cause = cause || by;
          }
        }
      };

      /* Строки текста: по вертикали прямоугольник строки выше line-height на поля шрифта, и бейдж
         с height меньше строки "вылезал" бы на пару пикселей. Настоящий вылет — лишняя строка
         целиком, он больше трети её высоты. */
      if (el.tagName === 'BUTTON') {
        const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());
        if (hasOwnText && el.scrollWidth > el.clientWidth + 2) {
          const extra = el.scrollWidth - el.clientWidth;
          take({ left: rect.left - extra / 2, right: rect.right + extra / 2, top: rect.top, bottom: rect.bottom }, 2, 0, 'текст');
        }
      } else if (!hiddenText(style)) {
        for (const node of el.childNodes) {
          if (node.nodeType !== 3 || !node.nodeValue.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const line of range.getClientRects()) {
            if (line.width > 1 && line.height > 1) take(line, 2, Math.max(2, line.height * 0.35), 'текст');
          }
        }
      }

      /* Дети в потоке — если их не разбирает boxOverflow. */
      if (!boxChecked(style, rect)) {
        for (const child of el.children) {
          const cs = getComputedStyle(child);
          if (cs.position === 'absolute' || cs.position === 'fixed' || cs.float !== 'none' || cs.transform !== 'none') continue;
          const cr = child.getBoundingClientRect();
          if (!isVisible(child, cs, cr)) continue;
          /* Сторона, вынесенная отрицательным margin, считается по margin-боксу. */
          const neg = (v) => Math.min(0, px(v));
          take(
            { left: cr.left - neg(cs.marginLeft), right: cr.right + neg(cs.marginRight), top: cr.top - neg(cs.marginTop), bottom: cr.bottom + neg(cs.marginBottom) },
            2,
            2,
            cssPath(child),
          );
        }
      }

      const worst = Math.max(out.top, out.right, out.bottom, out.left);
      if (worst <= 0) continue;
      /* Вылет, срезанный обрезающим предком, не виден. */
      const extent = { left: rect.left - out.left, right: rect.right + out.right, top: rect.top - out.top, bottom: rect.bottom + out.bottom };
      const seen = clippedRect(el, { ...extent, x: extent.left, y: extent.top, width: extent.right - extent.left, height: extent.bottom - extent.top });
      if (!seen) continue;
      const shown = {
        top: Math.round(Math.min(out.top, rect.top - seen.top)),
        right: Math.round(Math.min(out.right, seen.right - rect.right)),
        bottom: Math.round(Math.min(out.bottom, seen.bottom - rect.bottom)),
        left: Math.round(Math.min(out.left, rect.left - seen.left)),
      };
      if (Math.max(shown.top, shown.right, shown.bottom, shown.left) <= 0) continue;
      contentFound.push({ el, rect, out: shown, cause });
    }

    /* Проба под вылетом — по образцу второго прохода coveredText: прокрутка к элементу и обратно. */
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    for (const [i, item] of contentFound.entries()) {
      if (i >= 30) {
        item.neighbour = undefined;
        continue;
      }
      let rect = item.el.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > vh) {
        window.scrollTo(scrollX, Math.max(0, window.scrollY + rect.top - vh / 3));
        rect = item.el.getBoundingClientRect();
      }
      const side = Object.entries(item.out).sort((a, b) => b[1] - a[1])[0][0];
      const d = item.out[side];
      const strip =
        side === 'right'
          ? { left: rect.right, right: rect.right + d, top: rect.top, bottom: rect.bottom }
          : side === 'left'
            ? { left: rect.left - d, right: rect.left, top: rect.top, bottom: rect.bottom }
            : side === 'bottom'
              ? { left: rect.left, right: rect.right, top: rect.bottom, bottom: rect.bottom + d }
              : { left: rect.left, right: rect.right, top: rect.top - d, bottom: rect.top };
      const points = [0.25, 0.5, 0.75].map((k) =>
        side === 'left' || side === 'right'
          ? [(strip.left + strip.right) / 2, strip.top + (strip.bottom - strip.top) * k]
          : [strip.left + (strip.right - strip.left) * k, (strip.top + strip.bottom) / 2],
      );
      let neighbour = null;
      let probed = false;
      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x > vw || y > vh) continue;
        probed = true;
        const other = document.elementsFromPoint(x, y).find((node) => node !== item.el && !item.el.contains(node) && !node.contains(item.el));
        if (other) {
          neighbour = other;
          break;
        }
      }
      item.neighbour = probed ? neighbour : undefined;
    }
    window.scrollTo(scrollX, scrollY);
  }
  const contentOver = [];
  const contentFree = [];
  /* Текст, вылезший из контейнера под соседа, уже назван в coveredText — второй раз не нужен. */
  const coveredHosts = new Set(issues.coveredText.map((item) => item.container).filter(Boolean));
  for (const { el, rect, out, cause, neighbour } of contentFound) {
    if (coveredHosts.has(cssPath(el))) continue;
    const control = el.matches(CONTROLS) ? null : el.closest(CONTROLS);
    const entry = {
      selector: cssPath(el),
      text: label(el),
      box: box(rect),
      overflowPx: Object.fromEntries(Object.entries(out).filter(([, value]) => value > 0)),
      cause,
      ...(control ? { control: cssPath(control) } : {}),
      overNeighbour: neighbour === undefined ? null : neighbour ? cssPath(neighbour) : false,
    };
    (neighbour === null ? contentFree : contentOver).push(entry);
  }
  issues.contentOverflow = [...contentOver, ...contentFree];

  /*
   * Пересечения контролов — между собой и с текстом.
   *
   * overlaps берёт только соседей в потоке с position: static у одного родителя: кнопки Primer
   * (position: relative) в соседних ячейках таблицы туда не попадают никогда. Здесь пары — любые
   * видимые контролы и строки текста, не вложенные друг в друга и лежащие в одном слое.
   *
   * Слой — ближайший предок с absolute, fixed или sticky либо открытое меню, диалог, подсказка.
   * Выпадающее меню поверх кнопок страницы — замысел, а не наложение. Иконка или подпись внутри
   * поля ввода (целиком в его рамке) и стопка с отрицательным margin (аватары, группа кнопок со
   * слитыми рамками) — тоже замысел. Остальное исключается через overlapIgnore.
   */
  {
    const layerCache = new Map();
    const layerOf = (el) => {
      const chain = [];
      let node = el;
      let layer = null;
      while (node && node !== document.body && node !== document.documentElement) {
        if (layerCache.has(node)) {
          layer = layerCache.get(node);
          break;
        }
        chain.push(node);
        const s = getComputedStyle(node);
        if (
          /^(absolute|fixed|sticky)$/.test(s.position) ||
          node.tagName === 'DIALOG' ||
          node.hasAttribute('popover') ||
          /^(dialog|alertdialog|menu|listbox|tooltip)$/.test(node.getAttribute('role') || '')
        ) {
          layer = node;
          break;
        }
        node = node.parentElement;
      }
      /* Узлы выше найденного слоя к нему не относятся — кэшируем только цепочку до него. */
      for (const n of chain) {
        if (n === layer) {
          layerCache.set(n, n);
          break;
        }
        layerCache.set(n, layer);
      }
      return layer;
    };
    const ignored = (el) =>
      el.closest('[aria-hidden="true"]') ||
      (overlapIgnore || []).some((sel) => {
        try {
          return Boolean(el.closest(sel));
        } catch {
          return false;
        }
      });
    const FIELD = /^(INPUT|SELECT|TEXTAREA)$/;
    const items = [];
    const controlSet = new Set(controls.map((c) => c.el));
    for (const { el, style, rect } of controls) {
      if (style.position === 'fixed' || isScreenReaderOnly(el, style, rect) || ignored(el)) continue;
      const parts = (style.display === 'inline' ? Array.from(el.getClientRects()) : [rect]).map((r) => clippedRect(el, r)).filter(Boolean);
      if (parts.length) items.push({ el, style, parts, control: true });
    }
    /* Строку режет и собственная рамка: строки за line-clamp Range отдаёт, хотя их не видно. */
    const ownClip = (el, style, r) => {
      if (style.overflowX === 'visible' && style.overflowY === 'visible') return r;
      const b = el.getBoundingClientRect();
      const left = b.left + (parseFloat(style.borderLeftWidth) || 0);
      const top = b.top + (parseFloat(style.borderTopWidth) || 0);
      const c = {
        left: style.overflowX === 'visible' ? r.left : Math.max(r.left, left),
        right: style.overflowX === 'visible' ? r.right : Math.min(r.right, left + el.clientWidth),
        top: style.overflowY === 'visible' ? r.top : Math.max(r.top, top),
        bottom: style.overflowY === 'visible' ? r.bottom : Math.min(r.bottom, top + el.clientHeight),
      };
      return c.right - c.left > 1 && c.bottom - c.top > 1 ? { ...c, width: c.right - c.left, height: c.bottom - c.top } : null;
    };
    for (const { el, style, rect } of visible) {
      if (controlSet.has(el) || style.position === 'fixed' || ignored(el)) continue;
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1)) continue;
      const lines = [];
      for (const node of el.childNodes) {
        if (node.nodeType !== 3 || !node.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const line of range.getClientRects()) {
          if (line.width > 1 && line.height > 1) {
            const own = ownClip(el, style, line);
            const seen = own && clippedRect(el, own);
            if (seen) lines.push(seen);
          }
        }
      }
      if (lines.length) items.push({ el, style, parts: lines, control: false });
    }

    const CELL = 200;
    const buckets = new Map();
    for (const [index, item] of items.entries()) {
      const u = item.parts.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), item.parts[0]);
      item.union = u;
      for (let cx = Math.floor(u.left / CELL); cx <= Math.floor(u.right / CELL); cx += 1) {
        for (let cy = Math.floor(u.top / CELL); cy <= Math.floor(u.bottom / CELL); cy += 1) {
          const key = `${cx}:${cy}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(index);
        }
      }
    }
    const area = (r) => (r.right - r.left) * (r.bottom - r.top);
    const negMargin = (style, a, b) => Math.max(0, -(parseFloat(style[a]) || 0), -(parseFloat(style[b]) || 0));
    const inside = (inner, outer) => {
      const ox = Math.min(inner.right, outer.right) - Math.max(inner.left, outer.left);
      const oy = Math.min(inner.bottom, outer.bottom) - Math.max(inner.top, outer.top);
      return ox > 0 && oy > 0 && (ox * oy) / Math.max(1, area(inner)) >= 0.9;
    };
    /*
     * Строка с text-overflow: ellipsis. У обрезанной inline-ссылки в ней Chrome отдаёт лишний
     * фрагмент поверх соседней ссылки (сообщения коммитов на GitHub), хотя на экране они идут
     * подряд. Внутри одной такой строки пары не сравниваются.
     */
    const ellipsisLine = (el) => {
      let node = el;
      while (node && getComputedStyle(node).display === 'inline') node = node.parentElement;
      return node && getComputedStyle(node).textOverflow === 'ellipsis' ? node : null;
    };
    const done = new Set();
    outer: for (const list of buckets.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const [ia, ib] = list[i] < list[j] ? [list[i], list[j]] : [list[j], list[i]];
          const a = items[ia];
          const b = items[ib];
          if (!a.control && !b.control) continue;
          const key = `${ia}:${ib}`;
          if (done.has(key)) continue;
          done.add(key);
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          if (layerOf(a.el) !== layerOf(b.el)) continue;
          const line = ellipsisLine(a.el);
          if (line && line === ellipsisLine(b.el)) continue;
          if ((FIELD.test(a.el.tagName) && inside(b.union, a.union)) || (FIELD.test(b.el.tagName) && inside(a.union, b.union))) continue;
          let best = null;
          for (const ra of a.parts) {
            for (const rb of b.parts) {
              const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
              const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
              /* Строки текста выше line-height на поля шрифта: соседние строки задевают друг друга
                 на пару пикселей по вертикали, и это не наложение. */
              const minH = Math.min(ra.bottom - ra.top, rb.bottom - rb.top);
              if (ox > 2 && oy > Math.max(2, minH * 0.35) && (!best || ox * oy > best.ox * best.oy)) best = { ox, oy };
            }
          }
          if (!best) continue;
          if (a.control && b.control) {
            const nx = Math.max(negMargin(a.style, 'marginLeft', 'marginRight'), negMargin(b.style, 'marginLeft', 'marginRight'));
            const ny = Math.max(negMargin(a.style, 'marginTop', 'marginBottom'), negMargin(b.style, 'marginTop', 'marginBottom'));
            if ((nx > 0 && best.ox <= nx + 1) || (ny > 0 && best.oy <= ny + 1)) continue;
          }
          const smaller = Math.min(area(a.union), area(b.union)) || 1;
          issues.controlOverlaps.push({
            a: { selector: cssPath(a.el), text: label(a.el), box: box(a.el.getBoundingClientRect()), kind: a.control ? 'control' : 'text' },
            b: { selector: cssPath(b.el), text: label(b.el), box: box(b.el.getBoundingClientRect()), kind: b.control ? 'control' : 'text' },
            overlapPx: { w: Math.round(best.ox), h: Math.round(best.oy) },
            share: Math.round(Math.min(1, (best.ox * best.oy) / smaller) * 100) / 100,
          });
          if (issues.controlOverlaps.length >= maxItems) break outer;
        }
      }
    }
  }

  const counts = Object.fromEntries(
    Object.entries(issues).map(([k, v]) => [k, Array.isArray(v) ? v.length : v ? 1 : 0]),
  );
  counts.boxOverflow -= clippedOverflow;
  if (clippedOverflow) counts.boxOverflowClipped = clippedOverflow;
  counts.tinyTargets = tinyCounted;
  counts.contentOverflow -= contentFree.length;
  if (contentFree.length) counts.contentOverflowFree = contentFree.length;
  const exemptTotal = tinyExempt.label + tinyExempt.inline + tinyExempt.spacing;
  if (exemptTotal) counts.tinyTargetsExempt = exemptTotal;
  const countsCapped = Object.entries(issues)
    .filter(([, v]) => Array.isArray(v) && v.length >= COLLECT_CAP)
    .map(([k]) => k);
  for (const [key, value] of Object.entries(issues)) {
    if (Array.isArray(value) && value.length > shownMax) issues[key] = value.slice(0, shownMax);
  }

  /*
   * Движение на странице.
   *
   * Сессия по умолчанию глушит переходы и анимации ради стабильных снимков, и все проверки идут по
   * неподвижной странице. Аккордеон, дёргающийся при открытии, и слайдер, который не листает, на
   * таком снимке неотличимы от исправных. Считаем по правилам стилей, а не по computed-значениям:
   * заморозка обнуляет длительности, и по элементам движение уже не видно.
   */
  let motion = null;
  if (frozen) {
    let rules = 0;
    let keyframes = 0;
    const scan = (list) => {
      for (const rule of Array.from(list || [])) {
        if (rule.type === 7 /* KEYFRAMES_RULE */) keyframes += 1;
        else if (rule.style) {
          const s = rule.style;
          if (/!important/.test(rule.cssText) && /caret-color: transparent/.test(rule.cssText)) continue;
          const moving = (value) => value && value.split(',').some((part) => parseFloat(part) > 0);
          if (moving(s.transitionDuration) || (s.animationName && s.animationName !== 'none')) rules += 1;
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
    const widgets = document.querySelectorAll('[aria-expanded], [aria-controls], details, dialog, [role="tab"], .swiper, [class*="slider"], [class*="carousel"]').length;
    if (rules || keyframes || widgets) {
      motion = {
        frozen: true,
        rules,
        keyframes,
        interactive: widgets,
        note: 'Страница проверена неподвижной: переходы и анимации заморожены. Раскрытие, листание, hover и интро этими проверками не видны — откройте сессию с animations: "allow" и прогоните interaction_audit: он сам нажмёт и наведёт и скажет, что не среагировало и за сколько. Точечно — browser_act.',
      };
    }
  }

  // Счётчики нужны всегда: по ним видно, что категория непустая, даже когда
  // подробности по ней не запрашивали.
  const wanted = Array.isArray(categories) && categories.length ? new Set(categories) : null;
  const shown = wanted
    ? Object.fromEntries(Object.entries(issues).filter(([k]) => wanted.has(k)))
    : issues;

  /*
   * Полнота разбора.
   *
   * Ноль находок по странице, которая ещё не дорисовалась, выглядит так же, как ноль по здоровой:
   * отчёт не отличал "проверил и не нашёл" от "проверять было нечего". Теперь ответ всегда несёт,
   * сколько узлов разобрано, и состояние страницы, а признаки недорисованной — отдельным warning.
   */
  /* Ленивая картинка ниже экрана и не должна быть загружена — это не признак недорисованной страницы. */
  const pendingImages = Array.from(document.images).filter((img) => inScope.has(img) && !img.complete && img.loading !== 'lazy').length;
  const pageState = {
    readyState: document.readyState,
    fonts: document.fonts ? document.fonts.status : null,
    pendingImages,
    bodyHeight: Math.round(document.body ? document.body.scrollHeight : 0),
  };
  const checked = { nodes: all.length, visible: visible.length, textBlocks, controls: controls.length };
  const unfinished = [
    /* Порог — почти пустая страница, а не маленькая: история Storybook из кнопки тоже страница. */
    ...(visible.length < 3 ? [`видимых узлов всего ${visible.length}`] : []),
    ...(document.readyState !== 'complete' ? [`document.readyState = ${document.readyState}`] : []),
    ...(pageState.fonts === 'loading' ? ['шрифты ещё грузятся'] : []),
    ...(pendingImages ? [`картинок в загрузке: ${pendingImages}`] : []),
  ];

  return {
    viewport: { width: vw, height: vh },
    total: Object.entries(counts)
      .filter(([k]) => !OUTSIDE_TOTAL.includes(k))
      .reduce((a, [, b]) => a + b, 0),
    counts,
    checked,
    pageState,
    ...(unfinished.length
      ? { warning: `Отчёт может быть по недорисованной странице: ${unfinished.join('; ')}. Ноль находок тогда ничего не значит — дождитесь загрузки (browser_act wait) и повторите.` }
      : {}),
    ...(exemptTotal ? { exempt: { tinyTargets: tinyExempt } } : {}),
    ...(countsCapped.length ? { countsCapped: `Сбор остановлен на ${COLLECT_CAP}: ${countsCapped.join(', ')} — настоящее число больше.` } : {}),
    ...(motion ? { motion } : {}),
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
  'contentOverflow',
  'controlOverlaps',
  'deadZIndex',
];

/*
 * Счётчики рядом с категориями, которые в total не входят: намеренные клипы, вылет в пустое поле
 * своего предка и мелкие цели, прошедшие по исключению WCAG. Они в ответе ради масштаба, а не как
 * находки.
 */
export const OUTSIDE_TOTAL = ['boxOverflowClipped', 'contentOverflowFree', 'tinyTargetsExempt'];

export async function layoutAudit(
  page,
  { minTarget = 24, contrastRatio = 4.5, maxItems = 50, categories = null, include = null, exclude = null, frozen = false, inkMargin = 8, overlapIgnore = null } = {},
) {
  return page.evaluate(collectLayoutIssues, {
    minTarget,
    contrastRatio,
    maxItems,
    categories,
    include,
    exclude,
    frozen,
    inkMargin,
    overlapIgnore,
    outsideTotal: OUTSIDE_TOTAL,
  });
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
        // Закреплённый стендом элемент: opacity, visibility и transform у него не из CSS страницы.
        const pinned = el.hasAttribute('data-lt-pinned');
        const placeholder = el.hasAttribute('data-lt-placeholder');
        return {
          box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          scroll: { scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight },
          styles: Object.fromEntries(wanted.map((p) => [p, style.getPropertyValue(p)])),
          ...(pinned
            ? {
                overriddenByStand: ['opacity', 'visibility', 'transform'],
                overriddenNote:
                  'Элемент закреплён стендом в замороженной сессии (data-lt-pinned): эти значения перебиты инлайном с !important и не отражают CSS страницы. В сессии с animations: "allow" этого нет.',
              }
            : {}),
          ...(placeholder ? { placeholderByStand: 'src подменён заглушкой стенда: исходник не загрузился' } : {}),
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

/**
 * Тот же аудит на нескольких ширинах окна — сводкой, а не по вызову на ширину.
 *
 * Две макетные точки проверяли по одной сессии на каждую, а промежуточные не открывали вовсе:
 * на 1068px боковая колонка уходила за экран, и это увидели только после сдачи. Здесь окно
 * переставляется по списку и возвращается к исходному; по каждой ширине — счётчики и первые
 * находки, отдельно worst — где хуже всего.
 */
/*
 * Порядок, в котором находки попадают в короткую выжимку ширины. Раньше выжимка шла по порядку
 * категорий в отчёте, и coveredText с textOverImage, стоящие в конце, отрезались всегда: подпись
 * под картинкой соседней строки оставалась в счётчике, а в ответе её не было.
 */
const TOP_ORDER = ['documentOverflow', 'overlaps', 'controlOverlaps', 'coveredText', 'contentOverflow', 'clippedText', 'textOverImage', 'brokenImages', 'boxOverflow', 'tinyTargets'];

/** По одной находке из каждой категории по кругу, с серьёзных: восемь строк на ширину. */
export function topIssues(report, limit = 8) {
  const lists = Object.entries(report.issues || {})
    .filter(([, value]) => Array.isArray(value) && value.length)
    .sort(([a], [b]) => rank(a) - rank(b));
  const out = [];
  for (let round = 0; round < 3 && out.length < limit; round += 1) {
    for (const [category, list] of lists) {
      if (list[round] && out.length < limit) out.push({ category, ...list[round] });
    }
  }
  return out;
}
const rank = (category) => {
  const index = TOP_ORDER.indexOf(category);
  return index === -1 ? TOP_ORDER.length : index;
};

/** Выжимка отчёта по одной ширине: то же, что кладёт в byWidth прогон по ширинам. */
export const widthSummary = (report) => ({
  total: report.total,
  counts: report.counts,
  checked: report.checked,
  ...(report.warning ? { warning: report.warning } : {}),
  top: topIssues(report),
  ...(report.motion ? { motion: report.motion } : {}),
});

export async function layoutAuditAcrossWidths(page, widths, options = {}) {
  const original = page.viewportSize() || { width: 1440, height: 900 };
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const byWidth = {};
  const worst = [];
  try {
    for (const width of [...new Set(widths)].sort((a, b) => a - b)) {
      await page.setViewportSize({ width, height: original.height });
      await settle();
      const report = await layoutAudit(page, { ...options, maxItems: Math.min(options.maxItems || 50, 10) });
      byWidth[width] = widthSummary(report);
      worst.push({ width, total: report.total });
    }
  } finally {
    await page.setViewportSize(original);
    await settle();
  }
  worst.sort((a, b) => b.total - a.total);
  return {
    widths: Object.keys(byWidth).map(Number),
    byWidth,
    worst: worst.slice(0, 3),
    note: 'По каждой ширине — счётчики и первые находки; полный список по одной ширине — обычный layout_audit в сессии нужной ширины. Окно возвращено к исходному размеру.',
  };
}
