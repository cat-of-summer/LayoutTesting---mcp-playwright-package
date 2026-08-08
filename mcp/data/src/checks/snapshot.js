/**
 * Текстовый слепок страницы: роли, имена и селекторы.
 * Агенту он обходится на порядок дешевле скриншота, и по нему сразу можно кликать —
 * каждая строка несёт готовый селектор.
 */

function buildSnapshot({ maxNodes, maxDepth, interactiveOnly }) {
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const map = {
      a: el.hasAttribute('href') ? 'link' : 'generic',
      button: 'button',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      img: 'img', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
      aside: 'complementary', form: 'form', table: 'table', ul: 'list', ol: 'list', li: 'listitem',
      select: 'combobox', textarea: 'textbox', label: 'label', dialog: 'dialog', section: 'region',
    };
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', search: 'searchbox' }[type] || 'textbox';
    }
    return map[tag] || null;
  };

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const target = document.getElementById(labelledby);
      if (target) return (target.innerText || '').trim();
    }
    if (el.tagName === 'IMG') return (el.getAttribute('alt') ?? '(нет alt)').trim();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (id) return (id.innerText || '').trim();
      return (el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
    }
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue.trim())
      .join(' ')
      .trim();
    if (own) return own.slice(0, 100);
    return (el.innerText || '').trim().slice(0, 100);
  };

  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
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

  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'searchbox', 'tab', 'menuitem', 'option']);
  const lines = [];
  let truncated = false;

  const walk = (el, depth) => {
    if (lines.length >= maxNodes) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (el.getAttribute('aria-hidden') === 'true') return;

    const role = roleOf(el);
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;

    if (role && role !== 'generic' && visible) {
      const keep = !interactiveOnly || INTERACTIVE.has(role);
      if (keep) {
        const name = nameOf(el);
        const extras = [];
        if (el.disabled) extras.push('disabled');
        if (el.checked) extras.push('checked');
        if (role === 'heading') extras.push(`level=${el.tagName[1] || el.getAttribute('aria-level') || '?'}`);
        if (el.tagName === 'A' && el.getAttribute('href')) extras.push(`href=${el.getAttribute('href').slice(0, 60)}`);
        lines.push({
          depth,
          role,
          name,
          selector: cssPath(el),
          box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          extras,
        });
      }
    }

    for (const child of el.children) walk(child, depth + 1);
  };

  if (document.body) walk(document.body, 0);

  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.getAttribute('lang'),
    dir: document.documentElement.getAttribute('dir') || 'ltr',
    truncated,
    nodes: lines,
  };
}

export async function pageSnapshot(page, { maxNodes = 200, maxDepth = 25, interactiveOnly = false } = {}) {
  const result = await page.evaluate(buildSnapshot, { maxNodes, maxDepth, interactiveOnly });
  const text = result.nodes
    .map((n) => {
      const indent = '  '.repeat(Math.min(n.depth, 12));
      const extras = n.extras.length ? ` [${n.extras.join(', ')}]` : '';
      return `${indent}${n.role} "${n.name}"${extras}  —  ${n.selector}`;
    })
    .join('\n');
  return { ...result, text };
}
