/**
 * Сверка макета с проектом.
 *
 * Стенд живёт в контейнере и файлов проекта не видит — read_project_file читает только сам стенд.
 * Зато проект доступен по сети: его страница и собранный CSS отдаются тем же nginx, что и
 * человеку. Этого хватает для главного вопроса «это уже есть в проекте?»:
 *
 *   - custom properties из собранного CSS — готовые токены;
 *   - правила с их свойствами — по набору свойств узнаётся уже свёрстанный компонент. Так прошлый
 *     агент руками выяснил, что строка поиска совпадает с .search-page__form: gap 12px, белый фон,
 *     радиус 20px, те же отступы;
 *   - текст SCSS, если агент его передал: $переменные в собранный CSS не попадают.
 */
import postcss from 'postcss';
import { gotoAndSettle, withSession } from '../browser/pool.js';
import { deltaE, parseColor, SAME_COLOR, SIMILAR_COLOR } from './analyze/common.js';

const MAX_SHEET_BYTES = 5 * 1024 * 1024;
const MAX_RULES = 20000;

/** Свойства, по которым узнаётся компонент. Остальное — шум: transition, cursor, z-index. */
const WATCHED = new Set([
  'color',
  'background',
  'background-color',
  'border',
  'border-color',
  'border-width',
  'border-radius',
  'gap',
  'row-gap',
  'column-gap',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'box-shadow',
  'width',
  'height',
  'min-height',
  'flex-direction',
  'align-items',
  'justify-content',
  'opacity',
]);

export function parseCss(text, source, into) {
  let root;
  try {
    root = postcss.parse(text);
  } catch (err) {
    into.errors.push({ source, error: err.message });
    return;
  }
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes/i.test(rule.parent.name)) return;
    const media = rule.parent?.type === 'atrule' && rule.parent.name === 'media' ? rule.parent.params : undefined;
    const decls = {};
    rule.each((node) => {
      if (node.type !== 'decl') return;
      const value = node.value.replace(/\s*!important\s*$/i, '').trim();
      if (node.prop.startsWith('--')) {
        into.vars.push({ name: node.prop, value, selector: rule.selector, source, ...(media ? { media } : {}) });
      } else if (WATCHED.has(node.prop)) {
        decls[node.prop] = value;
      }
    });
    if (Object.keys(decls).length && into.rules.length < MAX_RULES) {
      into.rules.push({ selector: rule.selector, decls, source, ...(media ? { media } : {}) });
    }
  });
}

export function parseScss(text, into) {
  for (const m of text.matchAll(/^\s*(\$[\w-]+)\s*:\s*([^;]+?)\s*(?:!default\s*)?;/gm)) {
    into.vars.push({ name: m[1], value: m[2].trim(), source: 'scss' });
  }
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*;/g)) {
    into.vars.push({ name: m[1], value: m[2].trim(), source: 'scss' });
  }
  /* $a: $b — один уровень ссылок раскрывается: в палитре так объявляют семантические цвета. */
  const byName = new Map(into.vars.map((v) => [v.name, v.value]));
  for (const v of into.vars) {
    const ref = /^\$[\w-]+$/.exec(v.value);
    if (ref && byName.has(ref[0])) v.value = byName.get(ref[0]);
  }
}

async function sheetsFromPage(url) {
  return withSession({ viewport: 'desktop' }, async (session) => {
    await gotoAndSettle(session, url, { stabilizePage: false });
    const found = await session.page.evaluate(() => ({
      links: [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map((link) => link.href),
      inline: [...document.querySelectorAll('style')].map((style) => style.textContent || '').filter(Boolean),
    }));
    const sheets = [];
    for (const href of found.links.slice(0, 30)) {
      try {
        const res = await session.context.request.get(href, { timeout: 20_000 });
        if (res.ok()) sheets.push({ source: href, text: (await res.text()).slice(0, MAX_SHEET_BYTES) });
      } catch {
        /* Недоступный файл стилей не повод бросать сверку: остальные сработают. */
      }
    }
    found.inline.forEach((text, i) => sheets.push({ source: `inline style ${i + 1}`, text }));
    return sheets;
  });
}

export async function loadProject({ url, css, scss } = {}, { fetchSheets = sheetsFromPage } = {}) {
  const project = { sources: [], vars: [], rules: [], errors: [] };
  if (url) {
    for (const sheet of await fetchSheets(url)) {
      parseCss(sheet.text, sheet.source, project);
      project.sources.push({ source: sheet.source, bytes: sheet.text.length });
    }
  }
  if (css) {
    parseCss(css, 'css', project);
    project.sources.push({ source: 'css', bytes: css.length });
  }
  if (scss) {
    parseScss(scss, project);
    project.sources.push({ source: 'scss', bytes: scss.length });
  }
  return project;
}

const pxValue = (value) => {
  const m = /^(-?[\d.]+)(px)?$/.exec(String(value).trim());
  return m ? Number(m[1]) : null;
};

/**
 * Декларация → сравнимые пары.
 *
 * padding: 10px 16px и padding-left: 16px должны совпадать с одной и той же фигмой, а
 * background: #fff center no-repeat — с background-color. Поэтому сокращения раскрываются, цвета
 * разбираются в {r,g,b,a}, пиксели — в числа.
 */
export function normalizeDecl(prop, value) {
  const v = String(value).trim();
  if (prop === 'background' || prop === 'background-color') {
    const color = parseColor(v.split(/\s+(?![^(]*\))/)[0]);
    return color ? [['background-color', color]] : [];
  }
  if (prop === 'color' || prop === 'border-color') {
    const color = parseColor(v);
    return color ? [[prop, color]] : [];
  }
  if (prop === 'padding') {
    const p = v.split(/\s+/).map(pxValue);
    if (p.some((x) => x === null)) return [];
    const [t, r = t, b = t, l = r] = p;
    return [
      ['padding-top', t],
      ['padding-right', r],
      ['padding-bottom', b],
      ['padding-left', l],
    ];
  }
  if (prop === 'gap') {
    const g = v.split(/\s+/).map(pxValue);
    if (g.some((x) => x === null)) return [];
    return [
      ['row-gap', g[0]],
      ['column-gap', g[1] ?? g[0]],
    ];
  }
  if (prop === 'border') {
    const width = pxValue(v.split(/\s+/)[0]);
    const color = parseColor(v.split(/\s+(?![^(]*\))/).at(-1));
    return [...(width !== null ? [['border-width', width]] : []), ...(color ? [['border-color', color]] : [])];
  }
  const numeric = pxValue(v);
  if (numeric !== null) return [[prop, numeric]];
  if (prop === 'font-family') return [[prop, v.split(',')[0].replace(/['"]/g, '').trim().toLowerCase()]];
  return [[prop, v.toLowerCase()]];
}

const expand = (decls) => {
  const out = new Map();
  for (const [prop, value] of decls) for (const [p, v] of normalizeDecl(prop, value)) out.set(p, v);
  return out;
};

function sameValue(a, b) {
  if (a && typeof a === 'object' && b && typeof b === 'object') return deltaE(a, b) < SAME_COLOR;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1;
  return a === b;
}

/**
 * Правила проекта, похожие на узел макета по набору свойств.
 *
 * Счёт — доля свойств узла, которые правило задаёт так же. Правило, задающее одно свойство,
 * совпадёт с чем угодно, поэтому нужно минимум три совпадения.
 */
export function matchRules(project, figmaDecls, { limit = 3, minMatched = 3, minScore = 0.5 } = {}) {
  const target = expand(figmaDecls);
  if (target.size < minMatched) return [];
  const scored = [];
  for (const rule of project.rules) {
    const theirs = expand(Object.entries(rule.decls));
    let matched = 0;
    const differs = [];
    for (const [prop, value] of target) {
      if (!theirs.has(prop)) continue;
      if (sameValue(value, theirs.get(prop))) matched += 1;
      else differs.push(prop);
    }
    const score = matched / target.size;
    if (matched >= minMatched && score >= minScore) {
      scored.push({ selector: rule.selector, score: Math.round(score * 100) / 100, matched, differs, ...(rule.media ? { media: rule.media } : {}) });
    }
  }
  return scored.sort((a, b) => b.score - a.score || b.matched - a.matched).slice(0, limit);
}

const COLOR_PROPS = ['color', 'background-color', 'background', 'border-color', 'border'];

/**
 * Где этот цвет уже есть в проекте.
 *
 * Переменная — лучший ответ: её и надо переиспользовать. Но в собранном CSS переменных часто нет
 * вовсе, а цвет разложен литералами по правилам — тогда ответом служат сами правила: значит, цвет
 * в проекте уже живёт, и заводить второй такой же токен незачем.
 */
export function matchColor(project, color) {
  const exact = [];
  const similar = [];
  for (const v of project.vars) {
    const theirs = parseColor(v.value);
    if (!theirs) continue;
    const distance = deltaE(color, theirs);
    if (distance < SAME_COLOR) exact.push(v.name);
    else if (distance < SIMILAR_COLOR) similar.push(`${v.name}: ${v.value}`);
  }

  const selectors = [];
  for (const rule of project.rules) {
    for (const prop of COLOR_PROPS) {
      const raw = rule.decls[prop];
      if (!raw) continue;
      const theirs = parseColor(prop === 'background' || prop === 'border' ? raw.split(/\s+(?![^(]*\))/).find((part) => parseColor(part)) ?? '' : raw);
      if (theirs && deltaE(color, theirs) < SAME_COLOR) {
        selectors.push(rule.selector);
        break;
      }
    }
    if (selectors.length >= 50) break;
  }

  return {
    exact: [...new Set(exact)],
    similar: [...new Set(similar)],
    selectors: [...new Set(selectors)].slice(0, 5),
    selectorCount: new Set(selectors).size,
  };
}

/** Переменные проекта с тем же размером: отступы, радиусы, кегли. */
export function matchLength(project, px) {
  return [...new Set(project.vars.filter((v) => pxValue(v.value) !== null && Math.abs(pxValue(v.value) - px) <= 0.5).map((v) => v.name))];
}

export function projectSummary(project) {
  return {
    sources: project.sources.map((s) => `${s.source} (${Math.round(s.bytes / 1024)} КБ)`),
    vars: project.vars.length,
    rules: project.rules.length,
    ...(project.errors.length ? { errors: project.errors } : {}),
  };
}
