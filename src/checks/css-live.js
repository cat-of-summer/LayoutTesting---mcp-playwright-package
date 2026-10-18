/**
 * CSS живой страницы: переменные, которые никто не читает, значения по умолчанию библиотеки и
 * цвета состояний вне палитры макета.
 *
 * air-datepicker темизировали угадыванием имён переменных: --adp-background-color-in-range у
 * библиотеки — переменная только для дней другого месяца, --adp-cell-background-color-in-range
 * не задали, а --adp-color-selected придумали — такой нет, библиотека жёстко ставит color: #fff.
 * Итог: выбранная дата белым по #E7EB70, диапазон — синий по умолчанию. stylelint по файлам
 * проекта этого не видит: ошибка не в синтаксисе, а в том, что объявление ни с чем не связано.
 * Здесь разбираются все таблицы страницы вместе — свои и библиотечные.
 *
 * Там же — ховеры, придуманные самим агентом: стрелки новостей загорались #81F989, которого в
 * состояниях макета нет вовсе.
 */
import postcss from 'postcss';
import { deltaE, parseColor } from '../figma/analyze/common.js';

/* Селекторы состояний: в них цвет должен быть из палитры состояний макета. */
const STATE_SELECTOR = /:hover|:focus|:active|:checked|\.(is-)?(active|selected|current|open|checked)\b|\[aria-(selected|current|pressed|expanded)/i;
/* Селекторы библиотечных состояний, где переменная по умолчанию видна сразу. */
const LIBRARY_STATE = /selected|active|range|hover|focus|current|checked|disabled|today/i;
const COLOR_PROPS = /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-decoration-color|caret-color)$/;
const COLOR_IN_VALUE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;

/** Таблицы стилей страницы: текст правил, а для чужого домена — сам файл. */
async function pageSheets(page) {
  const sheets = await page.evaluate(() =>
    Array.from(document.styleSheets).map((sheet, index) => {
      /* Стили, которые вставил сам стенд (заморозка движения, полосы прокрутки, inject), — не CSS страницы. */
      const node = sheet.ownerNode;
      if (node && node.getAttributeNames && node.getAttributeNames().some((name) => name.startsWith('data-lt'))) return { index, href: null, text: null, stand: true };
      try {
        return { index, href: sheet.href, text: Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n') };
      } catch {
        return { index, href: sheet.href, text: null };
      }
    }),
  );
  for (const sheet of sheets) {
    if (sheet.stand || sheet.text !== null || !sheet.href) continue;
    sheet.text = await page.request
      .get(sheet.href, { timeout: 10_000 })
      .then((res) => (res.ok() ? res.text() : ''))
      .catch(() => '');
  }
  const inline = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[style*="--"], [style*="var("]'))
      .slice(0, 200)
      .map((el) => `[data-inline-style] { ${el.getAttribute('style')} }`)
      .join('\n'),
  );
  if (inline) sheets.push({ index: sheets.length, href: null, inline: true, text: inline });
  return sheets;
}

const sheetName = (sheet) => (sheet.inline ? 'style=""' : sheet.href ? sheet.href.replace(/^https?:\/\/[^/]+/, '') : `<style> №${sheet.index + 1}`);
const prefixOf = (name) => (/^--([a-z0-9]+)-/i.exec(name) || [])[1] || null;

/** Разобрать таблицы: объявления и чтения переменных, правила состояний. */
export function analyzeSheets(sheets) {
  const declared = new Map();
  const read = new Map();
  const stateRules = [];
  for (const sheet of sheets) {
    if (!sheet.text) continue;
    let root;
    try {
      root = postcss.parse(sheet.text);
    } catch {
      continue;
    }
    const name = sheetName(sheet);
    root.walkDecls((decl) => {
      const selector = decl.parent?.selector || '';
      if (decl.prop.startsWith('--')) {
        const list = declared.get(decl.prop) || [];
        list.push({ sheet: name, selector, value: decl.value });
        declared.set(decl.prop, list);
      }
      for (const match of decl.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const list = read.get(match[1]) || [];
        list.push({ sheet: name, selector, prop: decl.prop });
        read.set(match[1], list);
      }
      if (STATE_SELECTOR.test(selector) && COLOR_PROPS.test(decl.prop)) stateRules.push({ sheet: name, selector, prop: decl.prop, value: decl.value });
    });
  }
  return { declared, read, stateRules };
}

/* Ближайшее имя среди читаемых: подсказка, какую переменную, вероятно, имели в виду. */
function nearest(name, candidates) {
  const words = new Set(name.replace(/^--/, '').split('-'));
  let best = null;
  let score = 0;
  for (const other of candidates) {
    if (other === name) continue;
    const common = other.replace(/^--/, '').split('-').filter((word) => words.has(word)).length;
    if (common > score) {
      best = other;
      score = common;
    }
  }
  return score >= 2 ? best : null;
}

/** Разрешить var(--x) по объявлениям :root — один уровень, этого хватает для токенов. */
function resolveVars(value, declared) {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (all, name, fallback) => {
    const root = (declared.get(name) || []).find((entry) => /^(:root|html|body)$/.test(entry.selector.trim()));
    return root ? root.value : fallback || all;
  });
}

export function cssFindings({ declared, read, stateRules }, { palette = null, maxItems = 30 } = {}) {
  const readNames = [...read.keys()];

  /* Объявлена, но не читается никем: опечатка в имени или переменная, которой у библиотеки нет. */
  const unusedCustomProperty = [...declared.entries()]
    .filter(([name]) => !read.has(name))
    .map(([name, where]) => ({
      name,
      declaredIn: `${where[0].sheet} ${where[0].selector}`.trim(),
      ...(nearest(name, readNames) ? { didYouMean: nearest(name, readNames) } : {}),
    }))
    /* Переменные с префиксом чужой библиотеки — первыми: это и есть угаданные имена. */
    .sort((a, b) => Number(Boolean(b.didYouMean)) - Number(Boolean(a.didYouMean)));

  /*
   * Значение по умолчанию библиотеки. Префикс считается библиотечным, если переменные с ним
   * читаются в одной таблице, а переопределены хотя бы раз в другой: значит, тему задавали, и
   * незаданная переменная состояния — пропуск, а не решение.
   */
  const libraryDefault = [];
  const byPrefix = new Map();
  for (const [name, uses] of read) {
    const prefix = prefixOf(name);
    if (!prefix) continue;
    const entry = byPrefix.get(prefix) || { reads: new Map(), sheets: new Map() };
    entry.reads.set(name, uses);
    for (const use of uses) entry.sheets.set(use.sheet, (entry.sheets.get(use.sheet) || 0) + 1);
    byPrefix.set(prefix, entry);
  }
  for (const [prefix, entry] of byPrefix) {
    const library = [...entry.sheets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const overridden = [...declared.entries()].filter(([name, where]) => prefixOf(name) === prefix && where.some((w) => w.sheet !== library));
    if (!overridden.length) continue;
    const userNames = new Set(overridden.map(([name]) => name));
    for (const [name, uses] of entry.reads) {
      if (userNames.has(name)) continue;
      const stateUse = uses.find((use) => use.sheet === library && LIBRARY_STATE.test(use.selector));
      if (!stateUse) continue;
      const def = (declared.get(name) || []).find((w) => w.sheet === library);
      libraryDefault.push({ name, readIn: stateUse.selector, prop: stateUse.prop, ...(def ? { libraryValue: def.value } : {}), library });
    }
  }

  /* Цвета правил состояний вне палитры состояний макета. */
  const stateColorOffPalette = [];
  if (palette?.length) {
    const colors = palette.map((entry) => ({ ...entry, rgb: parseColor(entry.value) })).filter((entry) => entry.rgb);
    for (const rule of stateRules) {
      const value = resolveVars(rule.value, declared);
      for (const raw of value.match(COLOR_IN_VALUE) || []) {
        const rgb = parseColor(raw);
        if (!rgb || rgb.a < 0.05) continue;
        const near = colors.reduce((best, entry) => {
          const distance = deltaE({ ...rgb, a: 1 }, { ...entry.rgb, a: 1 });
          return !best || distance < best.distance ? { entry, distance } : best;
        }, null);
        if (near && near.distance < 5) continue;
        stateColorOffPalette.push({
          selector: rule.selector,
          prop: rule.prop,
          color: raw,
          sheet: rule.sheet,
          ...(near ? { closest: `${near.entry.name} ${near.entry.value}` } : {}),
        });
      }
    }
  }

  const cap = (list) => list.slice(0, maxItems);
  return {
    counts: {
      unusedCustomProperty: unusedCustomProperty.length,
      libraryDefault: libraryDefault.length,
      ...(palette ? { stateColorOffPalette: stateColorOffPalette.length } : {}),
    },
    ...(unusedCustomProperty.length ? { unusedCustomProperty: cap(unusedCustomProperty) } : {}),
    ...(libraryDefault.length ? { libraryDefault: cap(libraryDefault) } : {}),
    ...(stateColorOffPalette.length ? { stateColorOffPalette: cap(stateColorOffPalette) } : {}),
  };
}

/** Проверка CSS по открытой странице. palette — statePalette из figma_tokens или null. */
export async function lintLiveCss(page, { palette = null, maxItems = 30 } = {}) {
  const sheets = await pageSheets(page);
  const findings = cssFindings(analyzeSheets(sheets), { palette, maxItems });
  return {
    url: page.url(),
    sheets: sheets.filter((sheet) => sheet.text && !sheet.inline).length,
    ...findings,
    note:
      'unusedCustomProperty — объявлена, но не читается ни одним правилом страницы (переменные, которые читает только JS, сюда тоже попадут); didYouMean — похожая переменная, которую правила читают. ' +
      'libraryDefault — тему библиотеки задавали, а эта переменная её состояния осталась по умолчанию. ' +
      (palette ? 'stateColorOffPalette — цвет в правиле состояния, которого нет среди цветов состояний макета (figma_tokens.stateColors).' : 'С figma — ещё и цвета правил :hover, :focus, .is-active против палитры состояний макета.'),
  };
}
