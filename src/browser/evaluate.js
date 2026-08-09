/**
 * Исполнение произвольного JS на странице.
 *
 * Агент присылает то выражение, то тело функции, и различать их по подстроке
 * `return` нельзя: она встречается и внутри выражения — в колбэке `.map(function(p){return p})`,
 * в IIFE, да просто в строке `'.return'`. Такое выражение, объявленное телом, отдаёт
 * undefined, и вызов молча возвращает пустой ответ.
 *
 * Поэтому пробуем разобрать как выражение, и только на синтаксической ошибке — как тело.
 */

export const wrapExpression = (src) => `(async () => (${src}))()`;
export const wrapBody = (src) => `(async () => { ${src} })()`;

const isSyntaxError = (err) => /SyntaxError|Unexpected token|Illegal return/i.test(err?.message || '');

/** Значение, которое не переживёт сериализацию, описываем словами, а не роняем вызов. */
const DESCRIBE = `
  const t = typeof __lt_value;
  if (__lt_value === null) return { type: 'null', value: null };
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'function') return { type: 'function', value: String(__lt_value).slice(0, 300) };
  if (__lt_value instanceof Element) return { type: 'Element', value: __lt_value.outerHTML.slice(0, 2000) };
  if (__lt_value instanceof Node) return { type: __lt_value.constructor.name, value: String(__lt_value.textContent || '').slice(0, 500) };
  if (t === 'object') {
    try { JSON.stringify(__lt_value); } catch (e) { return { type: 'object', value: String(__lt_value), note: 'объект не сериализуется: ' + e.message }; }
    if (__lt_value instanceof Error) return { type: 'Error', value: __lt_value.message };
  }
  return { type: t, value: __lt_value };
`;

const source = (wrap, src) => `(async () => { const __lt_value = await ${wrap(src)}; ${DESCRIBE} })()`;

/**
 * Исполняется строкой через page.evaluate, а не через new Function внутри страницы:
 * Runtime.evaluate не подпадает под CSP страницы, а `new Function` под `script-src`
 * без `unsafe-eval` падает.
 */
export async function evaluateOnPage(page, expression) {
  let mode = 'expression';
  let result;
  try {
    result = await page.evaluate(source(wrapExpression, expression));
  } catch (err) {
    if (!isSyntaxError(err)) throw err;
    mode = 'body';
    result = await page.evaluate(source(wrapBody, expression));
  }

  if (result?.type === 'undefined') {
    return {
      mode,
      type: 'undefined',
      value: null,
      note: 'Выражение ничего не вернуло. Если вы прислали тело функции, добавьте return.',
    };
  }
  return { mode, ...result };
}
