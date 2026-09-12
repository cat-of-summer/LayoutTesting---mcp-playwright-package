/**
 * Прогон вёрстки контентом.
 *
 * Вёрстка ломается не на макете, а на реальном тексте: заголовок в три строки вместо одной,
 * фамилия без пробелов, пустое описание, двенадцать карточек вместо трёх, вертикальная картинка
 * вместо горизонтальной. В макете этого нет, и до боевого контента об этом никто не узнаёт.
 *
 * Проверка идёт по живой странице: содержимое подменяется, страница пересобирается, проверки
 * раскладки прогоняются заново, и в ответ уходит разница с исходным состоянием — только то, что
 * появилось от подмены. После каждого сценария содержимое возвращается на место, поэтому сессия
 * остаётся пригодной для дальнейшего разбора.
 */
import { layoutAudit } from './layout.js';

export const STRESS_SCENARIOS = ['text', 'lists', 'images', 'widths'];

/* Длинное слово без переносов: чаще всего вёрстку рвёт именно оно, а не длина текста. */
const LONG_WORD = 'Взаимопредупреждающий';

const ASPECT_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 300'><rect width='100' height='300' fill='%23cccccc'/></svg>",
  );

/** Категории, которые ломает именно контент. Контраст и мелкие тач-таргеты от текста не зависят. */
const CATEGORIES = ['documentOverflow', 'boxOverflow', 'overflowingElements', 'clippedText', 'overlaps', 'coveredText'];

function applyInPage(params) {
  const { kind, selectors, factor, items, word, src } = params;
  window.__ltStress = window.__ltStress || { text: [], html: [], img: [] };
  const store = window.__ltStress;

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const pick = () => {
    if (selectors && selectors.length) {
      return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible);
    }
    if (kind === 'images') return Array.from(document.images).filter(visible).slice(0, 20);
    if (kind === 'lists') {
      const out = [];
      for (const el of document.querySelectorAll('ul, ol, [class*="list"], [class*="items"], [class*="cards"], [class*="grid"]')) {
        const kids = Array.from(el.children).filter(visible);
        if (kids.length < 3) continue;
        const shapes = new Set(kids.map((kid) => `${kid.tagName}.${kid.className}`));
        if (shapes.size <= 2) out.push(el);
      }
      return out.slice(0, 10);
    }
    const out = [];
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,p,a,button,span,li,td,th,figcaption,label,dd,dt')) {
      if (!visible(el)) continue;
      const own = Array.from(el.childNodes).some((node) => node.nodeType === 3 && node.nodeValue.trim().length >= 8);
      if (own) out.push(el);
    }
    return out.slice(0, 40);
  };

  const targets = pick();
  let applied = 0;

  for (const el of targets) {
    if (kind === 'images') {
      store.img.push({ el, src: el.getAttribute('src'), srcset: el.getAttribute('srcset') });
      el.removeAttribute('srcset');
      el.setAttribute('src', src);
      applied += 1;
      continue;
    }
    if (kind === 'lists') {
      store.html.push({ el, html: el.innerHTML });
      const kids = Array.from(el.children);
      if (items <= 1) {
        for (const kid of kids.slice(Math.max(items, 0))) kid.remove();
      } else {
        const sample = kids[kids.length - 1];
        for (let i = kids.length; i < items; i += 1) el.appendChild(sample.cloneNode(true));
      }
      applied += 1;
      continue;
    }
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== 3 || !node.nodeValue.trim()) continue;
      store.text.push({ node, value: node.nodeValue });
      const base = node.nodeValue.trim();
      if (word) {
        node.nodeValue = `${base} ${word}`;
      } else if (!factor) {
        node.nodeValue = '';
      } else {
        let grown = base;
        while (grown.length < base.length * factor) grown += ` ${base}`;
        node.nodeValue = grown;
      }
      applied += 1;
    }
  }
  return { applied, targets: targets.length };
}

function restoreInPage() {
  const store = window.__ltStress;
  if (!store) return 0;
  let restored = 0;
  for (const entry of store.text.reverse()) {
    entry.node.nodeValue = entry.value;
    restored += 1;
  }
  for (const entry of store.html.reverse()) {
    entry.el.innerHTML = entry.html;
    restored += 1;
  }
  for (const entry of store.img.reverse()) {
    if (entry.src === null) entry.el.removeAttribute('src');
    else entry.el.setAttribute('src', entry.src);
    if (entry.srcset) entry.el.setAttribute('srcset', entry.srcset);
    restored += 1;
  }
  window.__ltStress = { text: [], html: [], img: [] };
  return restored;
}

const settle = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const keyOf = (category, issue) => `${category}|${issue.selector || ''}|${issue.child || ''}|${issue.a?.selector || ''}`;

/** Что появилось от подмены. Всё, что на странице ломалось и до неё, к прогону отношения не имеет. */
function addedIssues(baseline, after) {
  const known = new Set();
  for (const [category, list] of Object.entries(baseline.issues || {})) {
    if (Array.isArray(list)) for (const issue of list) known.add(keyOf(category, issue));
  }
  const added = [];
  for (const [category, list] of Object.entries(after.issues || {})) {
    if (!Array.isArray(list)) {
      if (category === 'documentOverflow' && list && !baseline.issues?.documentOverflow) added.push({ category, ...list });
      continue;
    }
    for (const issue of list) if (!known.has(keyOf(category, issue))) added.push({ category, ...issue });
  }
  return added;
}

function plan({ factor, items, word = LONG_WORD }) {
  return {
    text: [
      { name: `текст ×${factor}`, params: { kind: 'text', factor } },
      { name: 'длинное слово без переносов', params: { kind: 'text', word } },
      { name: 'пустой текст', params: { kind: 'text', factor: 0 } },
    ],
    lists: [
      { name: `список до ${items} элементов`, params: { kind: 'lists', items } },
      { name: 'список из одного элемента', params: { kind: 'lists', items: 1 } },
    ],
    images: [
      { name: 'вертикальная картинка', params: { kind: 'images', src: ASPECT_IMAGE } },
      { name: 'битая картинка', params: { kind: 'images', src: '/lt-missing-image.png' } },
    ],
  };
}

export async function runStress(
  page,
  {
    scenarios = STRESS_SCENARIOS,
    selectors = null,
    factor = 3,
    items = 12,
    widths = [320, 375, 414, 768, 1024, 1280, 1440],
    maxItems = 20,
  } = {},
) {
  const audit = () => layoutAudit(page, { maxItems: maxItems * 2, categories: CATEGORIES });
  const baseline = await audit();
  const steps = plan({ factor, items });
  const results = [];

  for (const scenario of scenarios) {
    for (const step of steps[scenario] || []) {
      const applied = await page.evaluate(applyInPage, { selectors, ...step.params });
      await settle(page);
      const after = await audit();
      const added = addedIssues(baseline, after);
      await page.evaluate(restoreInPage);
      await settle(page);
      results.push({
        scenario: step.name,
        applied: applied.applied,
        targets: applied.targets,
        found: added.length,
        issues: added.slice(0, maxItems),
      });
    }
  }

  let widthReport = null;
  if (scenarios.includes('widths')) {
    const original = page.viewportSize() || { width: 1440, height: 900 };
    const checked = [];
    let firstBreak = null;
    for (const width of widths) {
      await page.setViewportSize({ width, height: original.height });
      await settle(page);
      const report = await audit();
      const added = addedIssues(baseline, report);
      checked.push({ width, found: added.length, categories: [...new Set(added.map((issue) => issue.category))] });
      if (!firstBreak && added.length) firstBreak = { width, issues: added.slice(0, 5) };
    }
    await page.setViewportSize(original);
    await settle(page);
    widthReport = { from: original.width, checked, ...(firstBreak ? { firstBreak } : {}) };
  }

  return {
    baseline: { total: baseline.total, counts: baseline.counts },
    scenarios: results,
    ...(widthReport ? { widths: widthReport } : {}),
    note: 'Показано только то, что появилось от подмены: что ломалось до неё, ищите обычным layout_audit.',
  };
}
