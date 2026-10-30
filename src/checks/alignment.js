/**
 * Выпадение из ряда: линии, на которых стоят однотипные соседи, и элемент, который на них не лёг.
 *
 * Четыре .Box свойств стояли в ряд: у трёх общий низ, четвёртый — tristate без подписи — короче.
 * Флекс с align-items: flex-start, ни вылета, ни наложения: layout_audit молчал, агент на скриншоте
 * разницу не заметил. Глаз видит такое как «ряд рваный», и ровно это здесь ищется — без макета,
 * по самой странице. Сравнение с Figma (findRowAlign, findParallels) — отдельная история.
 *
 * Точность держится на группе: симметрия осмысленна только у повторяющегося компонента — дети
 * одного родителя с одной подписью (тег и первый класс). Кнопка и селект в одном тулбаре в одну
 * группу не попадают. Линия — кромка, на которой стоит большинство группы; выпадение из линии
 * большинства и есть находка. Все находки — повод посмотреть глазами, а не дефект.
 */

function collectAlignment(options) {
  const { include = null, exclude = null, maxItems = 30, tolerance = 1, nearMiss = 12 } = options;

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

  const label = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const round = (value) => Math.round(value);
  const box = (r) => ({ x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) });

  /* Подпись компонента: тег и первый класс, без классов — тег и роль. */
  const signature = (el) => {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    const role = el.getAttribute('role');
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : role ? `[role=${role}]` : '');
  };

  const parseColor = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const opaque = (value) => {
    const c = parseColor(value);
    return c && c.a > 0.1 ? c : null;
  };
  const backgroundOf = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const c = opaque(getComputedStyle(node).backgroundColor);
      if (c) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  /*
   * Видимая рамка: без неё разная высота соседей глазу не видна. Две текстовые колонки разной
   * длины — норма, две карточки с рамкой и разным низом — рваный ряд.
   */
  const framed = (el, style) => {
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    if (sides.some((s) => parseFloat(style[`border${s}Width`]) > 0 && style[`border${s}Style`] !== 'none' && opaque(style[`border${s}Color`]))) return true;
    if (style.boxShadow && style.boxShadow !== 'none') return true;
    if (style.backgroundImage && style.backgroundImage !== 'none') return true;
    const own = opaque(style.backgroundColor);
    if (!own || !el.parentElement) return false;
    const under = backgroundOf(el.parentElement);
    return Math.abs(own.r - under.r) + Math.abs(own.g - under.g) + Math.abs(own.b - under.b) > 12;
  };

  /* Видимая площадь с учётом обрезающих предков: клоны карусели за рамкой в ряд не входят. */
  const clipped = (el, rect) => {
    let { top, left, right, bottom } = rect;
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const r = node.getBoundingClientRect();
      if (s.overflowX !== 'visible') {
        left = Math.max(left, r.left);
        right = Math.min(right, r.right);
      }
      if (s.overflowY !== 'visible') {
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      }
      if (right - left <= 0 || bottom - top <= 0) return false;
    }
    return true;
  };

  /* Ячейка сетки на несколько дорожек выше или шире соседей по замыслу. */
  const spans = (style) => {
    const lines = [
      [style.gridRowStart, style.gridRowEnd],
      [style.gridColumnStart, style.gridColumnEnd],
    ];
    return lines.some(([start, end]) => {
      if (/span\s+([2-9]|\d{2,})/.test(start) || /span\s+([2-9]|\d{2,})/.test(end)) return true;
      const a = parseInt(start, 10);
      const b = parseInt(end, 10);
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) > 1;
    });
  };

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
  const dropped = (el) =>
    (exclude || []).some((sel) => {
      try {
        return Boolean(el.closest(sel));
      } catch {
        return false;
      }
    });
  const inScope = new Set();
  const parents = [];
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (inScope.has(el) || dropped(el)) continue;
      inScope.add(el);
      if (el instanceof HTMLElement && el.childElementCount >= 2) parents.push(el);
    }
  }

  /* Дети по раскладке: display: contents прозрачен, его дети — соседи по ряду. */
  const flowKids = (parent) => {
    const out = [];
    for (const kid of parent.children) {
      if (getComputedStyle(kid).display === 'contents') out.push(...flowKids(kid));
      else out.push(kid);
    }
    return out;
  };

  const records = new Map();
  const record = (el) => {
    if (records.has(el)) return records.get(el);
    let out = null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const usable =
      el instanceof HTMLElement &&
      style.display !== 'none' &&
      style.display !== 'inline' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      style.position !== 'absolute' &&
      style.position !== 'fixed' &&
      rect.width >= 8 &&
      rect.height >= 8 &&
      clipped(el, rect);
    if (usable) {
      let frame = null;
      out = {
        el,
        style,
        sig: signature(el),
        r: {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          cx: rect.left + rect.width / 2,
          cy: rect.top + rect.height / 2,
        },
        get framed() {
          if (frame === null) frame = framed(el, style);
          return frame;
        },
      };
    }
    records.set(el, out);
    return out;
  };

  const need = (m) => (m <= 2 ? m : m === 3 ? 2 : m <= 5 ? m - 1 : Math.ceil((2 * m) / 3));

  /*
   * Расхождение меньше двух пикселей — шум: дробные метрики шрифта, подстановка шрифта для другой
   * письменности, центрирование нечётной ширины. Такое глазом не видно, а находок давало бы много.
   */
  const MIN_DELTA = Math.max(2, tolerance + 1);

  /*
   * Линия большинства по ключу: значение, в пределах tolerance от которого лежит больше всех.
   * Окно по отсортированным значениям: колонка из тысячи строк списка не должна стоить n².
   */
  const cluster = (items, key) => {
    const sorted = [...items].sort((a, b) => a.r[key] - b.r[key]);
    let best = null;
    let lo = 0;
    let hi = 0;
    for (const it of sorted) {
      const v = it.r[key];
      while (sorted[lo].r[key] < v - tolerance) lo += 1;
      while (hi < sorted.length && sorted[hi].r[key] <= v + tolerance) hi += 1;
      if (!best || hi - lo > best.hi - best.lo) best = { lo, hi };
    }
    if (!best || best.hi - best.lo < need(items.length)) return null;
    const on = sorted.slice(best.lo, best.hi);
    return { at: on[Math.floor(on.length / 2)].r[key], on, set: new Set(on) };
  };

  /*
   * Ряды (dir = row): соседи, разнесённые по x и перекрытые по y хотя бы наполовину меньшего.
   * Колонки (dir = column) — то же с осями наоборот. Сетка 3×2 даёт два ряда и три колонки.
   */
  const AXES = {
    row: { lead: 'top', mid: 'cy', tail: 'bottom', size: 'height', a0: 'left', a1: 'right' },
    column: { lead: 'left', mid: 'cx', tail: 'right', size: 'width', a0: 'top', a1: 'bottom' },
  };
  const bands = (items, dir) => {
    const { lead, tail, size, a0, a1 } = AXES[dir];
    const sorted = [...items].sort((p, q) => p.r[lead] - q.r[lead] || p.r[a0] - q.r[a0]);
    const out = [];
    for (const it of sorted) {
      const band = out.find((members) => {
        const ref = members[0];
        const overlap = Math.min(ref.r[tail], it.r[tail]) - Math.max(ref.r[lead], it.r[lead]);
        if (overlap < 0.5 * Math.min(ref.r[size], it.r[size])) return false;
        return members.every((m) => m.r[a1] <= it.r[a0] + tolerance || it.r[a1] <= m.r[a0] + tolerance);
      });
      if (band) band.push(it);
      else out.push([it]);
    }
    return out.filter((band) => band.length >= 2).map((band) => band.sort((p, q) => p.r[a0] - q.r[a0]));
  };

  const EDGE = { top: 'верх', bottom: 'низ', cy: 'центр по вертикали', left: 'левая кромка', right: 'правая кромка', cx: 'центр по горизонтали' };
  const findings = [];
  const flagged = new Set();
  const checked = { groups: 0, rows: 0, columns: 0 };

  const neighbors = (line, it) => line.on.filter((o) => o !== it).slice(0, 3).map((o) => cssPath(o.el));
  const report = (kind, it, { edge, line, delta, members, parent, hint, weak = false }) => {
    flagged.add(it.el);
    findings.push({
      kind,
      selector: cssPath(it.el),
      ...(label(it.el) ? { text: label(it.el) } : {}),
      box: box(it.r),
      edge,
      delta: round(delta),
      line: { at: round(line.at), on: line.on.length, of: members.length, neighbors: neighbors(line, it) },
      group: { parent: cssPath(parent), signature: it.sig, n: members.length },
      ...(weak ? { weak: true } : {}),
      hint,
      severity: Math.abs(delta) * members.length * (weak ? 0.5 : 1),
    });
  };

  /* Тянется ли большинство колонки на всю ширину родителя: только тогда узкий элемент — выпадение. */
  const stretched = (parent, line) => {
    const s = getComputedStyle(parent);
    const content = parent.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0);
    return line.on.every((o) => Math.abs(o.r.width - content) <= 2);
  };

  const analyzeBand = (band, dir, parent) => {
    const { lead, mid, tail, size } = AXES[dir];
    const m = band.length;
    const sig = band[0].sig;
    const T = cluster(band, lead);
    const C = cluster(band, mid);
    const B = cluster(band, tail);

    if (m === 2) {
      /* Пара: кто из двух неправ, не сказать — слабая подсказка, и только про высоту ряда. */
      if (dir !== 'row' || !T || B || C || !band.every((it) => it.framed)) return;
      const [a, b] = band;
      const short = a.r.height < b.r.height ? a : b;
      const other = short === a ? b : a;
      const delta = short.r.bottom - other.r.bottom;
      if (Math.abs(delta) < MIN_DELTA) return;
      report('unevenPair', short, {
        edge: EDGE.bottom,
        line: { at: other.r.bottom, on: [other] },
        delta,
        members: band,
        parent,
        weak: true,
        hint: `Два ${sig} рядом: верх общий, низ разный на ${round(Math.abs(delta))}px. Если это равноправные карточки — ряд выглядит рваным (align-items: stretch у ${cssPath(parent)}); если высота от контента задумана — пропустить.`,
      });
      return;
    }

    /* Весь ряд на одном центре, а верх не общий — выравнивание по центру задумано (выделенный тариф). */
    if (C && C.on.length === m && !(T && T.on.length === m)) return;

    /* Линия из невидимых кромок глазу не видна: у вкладок без рамки низ активной с ними не сравнить. */
    const seen = (line) => line.on.every((o) => o.framed);
    for (const it of band) {
      if (flagged.has(it.el)) continue;
      const window = Math.min(nearMiss, it.r[size] * 0.25);
      const offLead = T && !T.set.has(it) ? it.r[lead] - T.at : null;
      const offTail = B && !B.set.has(it) ? it.r[tail] - B.at : null;
      const sizeKind = dir === 'row' ? 'rowHeight' : 'columnWidth';
      const sizeOk = dir === 'row' || Boolean(B && stretched(parent, B));
      const near = (edge, line, delta) =>
        report('nearMiss', it, {
          edge: EDGE[edge],
          line,
          delta,
          members: band,
          parent,
          hint: `${EDGE[edge]} в ${round(Math.abs(delta))}px от линии ${round(line.at)}px, на которой стоят ${line.on.length} из ${m} ${sig}. Почти-совпадение обычно случайно: лишний margin, padding или border, другой box-sizing. Проверьте глазами.`,
        });
      const sized = (edge, line, delta) =>
        report(sizeKind, it, {
          edge: EDGE[edge],
          line,
          delta,
          members: band,
          parent,
          hint:
            dir === 'row'
              ? `${sig} в ряду из ${m}: у ${line.on.length} ${EDGE[edge]} на ${round(line.at)}px, у этого — на ${round(Math.abs(delta))}px ${delta < 0 ? 'выше' : 'ниже'}: по высоте блок ${it.r.height < line.on[0].r.height ? 'меньше' : 'больше'} соседей, ряд рваный. Типовая причина — align-items: flex-start/start у ${cssPath(parent)} или align-self у элемента; если высоты должны совпадать — stretch.`
              : `${sig} в колонке из ${m}: у ${line.on.length} ${EDGE[edge]} на ${round(line.at)}px, у этого — в ${round(Math.abs(delta))}px от неё, хотя соседи растянуты на всю ширину. Проверьте align-items/justify-self, max-width или inline-block у элемента.`,
        });

      if (offLead !== null && Math.abs(offLead) >= MIN_DELTA) {
        /* Ведущая кромка (верх, левая) видна и без рамки — по ней читается начало текста. */
        if (Math.abs(offLead) <= window) near(lead, T, offLead);
        else if (B && B.set.has(it) && it.framed && seen(T) && sizeOk) sized(lead, T, offLead);
        continue;
      }
      if (offTail === null || Math.abs(offTail) < MIN_DELTA || !it.framed || !seen(B)) continue;
      if (T) {
        if (sizeOk) sized(tail, B, offTail);
      } else if (Math.abs(offTail) <= window) near(tail, B, offTail);
    }
  };

  /*
   * Вложенные элементы карточек ряда: «Подробнее» у двух на одной линии, у третьей — выше.
   *
   * Линия большинства сама по себе ничего не значит: у одинаковых карточек потомки совпадают
   * просто потому, что над ними одинаковый контент. Находка — только когда над элементами
   * большинства контент разной высоты, а они всё равно на одной линии: её держит вёрстка
   * (margin-top: auto, subgrid, фиксированная высота), и у выпавшего она не сработала.
   */
  const pathsOf = (root) => {
    const out = new Map();
    const walk = (el, path, depth) => {
      if (depth > 4) return;
      const seen = new Map();
      for (const kid of el.children) {
        const sig = signature(kid);
        const index = seen.get(sig) || 0;
        seen.set(sig, index + 1);
        const p = `${path} > ${sig}:${index}`;
        out.set(p, kid);
        walk(kid, p, depth + 1);
      }
    };
    walk(root, '', 1);
    return out;
  };
  const prevBottom = (el) => {
    for (let node = el.previousElementSibling; node; node = node.previousElementSibling) {
      const rec = record(node);
      if (rec) return rec.r.bottom;
    }
    const parent = el.parentElement;
    const s = getComputedStyle(parent);
    return parent.getBoundingClientRect().top + (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.paddingTop) || 0);
  };
  const analyzeInner = (band, parent) => {
    const cards = band.filter((it) => !flagged.has(it.el));
    if (cards.length < 3) return;
    const maps = cards.map((it) => pathsOf(it.el));
    const common = [...maps[0].keys()].filter((p) => maps.every((map) => map.has(p))).sort((a, b) => a.split(' > ').length - b.split(' > ').length);
    const done = [];
    for (const path of common) {
      if (done.some((p) => path.startsWith(`${p} > `))) continue;
      const items = maps.map((map) => record(map.get(path)));
      if (items.some((it) => !it)) continue;
      for (const key of ['bottom', 'top']) {
        const line = cluster(items, key);
        if (!line || line.on.length === items.length) continue;
        const above = line.on.map((it) => prevBottom(it.el));
        if (Math.max(...above) - Math.min(...above) <= tolerance) continue;
        const outliers = items.filter((it) => !line.set.has(it) && Math.abs(it.r[key] - line.at) >= MIN_DELTA && !flagged.has(it.el));
        if (!outliers.length) continue;
        for (const it of outliers) {
          const delta = it.r[key] - line.at;
          report('innerAlign', it, {
            edge: EDGE[key],
            line,
            delta,
            members: items,
            parent,
            hint: `${it.sig} в ${line.on.length} из ${items.length} карточках ${band[0].sig} стоит на линии «${EDGE[key]} ${round(line.at)}px», хотя контент над ним разной высоты — линию держит вёрстка (margin-top: auto, subgrid, фиксированная высота). Здесь он на ${round(Math.abs(delta))}px ${delta < 0 ? 'выше' : 'ниже'}: у этой карточки прижатие не сработало.`,
          });
        }
        done.push(path);
        break;
      }
    }
  };

  for (const parent of parents) {
    const groups = new Map();
    for (const kid of flowKids(parent)) {
      if (!inScope.has(kid)) continue;
      const rec = record(kid);
      if (!rec || spans(rec.style)) continue;
      groups.set(rec.sig, [...(groups.get(rec.sig) || []), rec]);
    }
    for (const items of groups.values()) {
      if (items.length < 2) continue;
      checked.groups += 1;
      for (const band of bands(items, 'row')) {
        checked.rows += 1;
        analyzeBand(band, 'row', parent);
        if (band.length >= 3) analyzeInner(band, parent);
      }
      for (const band of bands(items, 'column')) {
        if (band.length < 3) continue;
        checked.columns += 1;
        analyzeBand(band, 'column', parent);
      }
    }
  }

  findings.sort((a, b) => b.severity - a.severity);
  const counts = { rowHeight: 0, columnWidth: 0, nearMiss: 0, innerAlign: 0, unevenPair: 0 };
  for (const f of findings) counts[f.kind] += 1;
  return {
    total: findings.length,
    counts,
    checked,
    findings: findings.slice(0, maxItems).map(({ severity, ...rest }) => rest),
  };
}

export const ALIGNMENT_KINDS = ['rowHeight', 'columnWidth', 'nearMiss', 'innerAlign', 'unevenPair'];

export async function alignmentAudit(page, { include = null, exclude = null, maxItems = 30, tolerance = 1, nearMiss = 12 } = {}) {
  return page.evaluate(collectAlignment, { include, exclude, maxItems, tolerance, nearMiss });
}
