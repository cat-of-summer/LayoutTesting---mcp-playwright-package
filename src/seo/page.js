/**
 * Две ветки вызова экстрактора: живая страница и сохранённый HTML.
 *
 * Экстрактор один на оба мира (см. seo/extract.js), и весь фокус в том, как передать ему документ.
 * page.evaluate принимает ровно один сериализуемый аргумент, а Document через сериализацию не
 * проходит — поэтому в браузере вызов собирается строкой из текста самой функции.
 *
 * Строка, а не функция, здесь ещё и обязательна по другой причине, записанной в докблоке
 * browser/evaluate.js: строка исполняется через Runtime.evaluate и под CSP страницы не подпадает,
 * тогда как new Function внутри страницы падает без unsafe-eval.
 */
import { extractSeoFrom } from './extract.js';

/** SEO-поля живой страницы. */
export async function seoFromPage(page, facts = {}) {
  const opts = { url: page.url(), ...facts };
  const source = `(${extractSeoFrom.toString()})(document, ${JSON.stringify(opts)})`;
  return page.evaluate(source);
}

/** SEO-поля сохранённого HTML — без браузера и без единого сетевого запроса. */
export async function seoFromHtml(html, opts = {}) {
  // Импорт ленивый: linkedom нужен только этой ветке, а браузерная работает и без него.
  const { parseHTML } = await import('linkedom');
  return extractSeoFrom(parseHTML(html).document, opts);
}
