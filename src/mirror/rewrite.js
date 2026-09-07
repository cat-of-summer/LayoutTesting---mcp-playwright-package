/**
 * Переписывание ссылок в сохранённой странице.
 *
 * Работа идёт по DOM (linkedom), а не регулярками по тексту. Регулярка тут выглядит проще ровно
 * до первого href="?a=1&amp;b=2": подставив в него путь, она порвёт экранирование, vnu покажет
 * ошибки, которых на исходном сайте не было, и SEO-разбор зеркала начнёт путать проблемы сайта
 * с багами переписывателя. setAttribute экранирует сам.
 *
 * CSS разбирается postcss по той же причине: в url() бывают кавычки трёх видов, data:-URI с
 * base64-скобками и @import без url() вовсе.
 */
import postcss from 'postcss';

/**
 * Атрибуты, в которых живут адреса.
 *
 * data-src и data-srcset здесь обязательны, а не «на всякий случай»: у ленивых картинок настоящий
 * адрес лежит именно там, и зеркало без них выходит с пустыми рамками вместо половины иллюстраций.
 */
export const URL_ATTRS = [
  ['img', 'src'],
  ['img', 'data-src'],
  ['img', 'srcset'],
  ['img', 'data-srcset'],
  ['source', 'src'],
  ['source', 'srcset'],
  ['source', 'data-srcset'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['script', 'src'],
  ['link', 'href'],
  ['use', 'xlink:href'],
  ['use', 'href'],
  ['object', 'data'],
  ['embed', 'src'],
];

const SRCSET_ATTRS = new Set(['srcset', 'data-srcset']);

/*
 * Двоеточие в имени атрибута (xlink:href у SVG) — часть имени, но в селекторе оно разделяет
 * псевдокласс. Без экранирования querySelectorAll бросает «Attribute selector didn't terminate»,
 * и падает не только linkedom: браузер на таком селекторе тоже отказывается работать.
 */
const attrSelector = (tag, attr) => `${tag}[${attr.replace(/:/g, '\\:')}]`;

/** srcset — это список «адрес дескриптор», и переписывать надо каждый адрес, сохранив дескрипторы. */
export function mapSrcset(value, map) {
  return String(value)
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const space = trimmed.search(/\s/);
      const url = space === -1 ? trimmed : trimmed.slice(0, space);
      const descriptor = space === -1 ? '' : trimmed.slice(space);
      const next = map(url);
      return (next === null || next === undefined ? url : next) + descriptor;
    })
    .filter(Boolean)
    .join(', ');
}

/** Переписывает url() и @import внутри таблицы стилей. */
export function rewriteCss(css, map) {
  const root = postcss.parse(css);

  root.walkDecls((decl) => {
    if (decl.value.indexOf('url(') === -1) return;
    decl.value = decl.value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, url) => {
      // data: и blob: никуда не ведут — их трогать нечем и незачем.
      if (/^(data|blob):/i.test(url)) return whole;
      const next = map(url);
      return next === null || next === undefined ? whole : `url(${quote}${next}${quote})`;
    });
  });

  root.walkAtRules('import', (rule) => {
    rule.params = rule.params.replace(/(['"])([^'"]+)\1/, (whole, quote, url) => {
      const next = map(url);
      return next === null || next === undefined ? whole : `${quote}${next}${quote}`;
    });
  });

  return root.toString();
}

/**
 * Переписывает документ на месте.
 *
 * map получает исходный адрес и возвращает локальный путь либо null — «оставить как было».
 * Оставлять как было приходится часто: ссылка ведёт на страницу, которой в архиве нет, и
 * сломанная ссылка тут хуже ведущей наружу.
 */
export function rewriteDocument(doc, { mapAsset, mapPage, scripts = 'strip', passport = null } = {}) {
  const stats = { attrs: 0, css: 0, scriptsRemoved: 0, integrityRemoved: 0, links: 0 };

  for (const [tag, attr] of URL_ATTRS) {
    for (const el of doc.querySelectorAll(attrSelector(tag, attr))) {
      const value = el.getAttribute(attr);
      if (!value) continue;

      if (SRCSET_ATTRS.has(attr)) {
        el.setAttribute(attr, mapSrcset(value, mapAsset));
        stats.attrs += 1;
        continue;
      }

      const next = mapAsset(value);
      if (next !== null && next !== undefined) {
        el.setAttribute(attr, next);
        stats.attrs += 1;
      }
    }
  }

  // Ссылки на другие страницы — отдельной картой: они ведут на соседние сохранённые копии.
  for (const el of doc.querySelectorAll('a[href]')) {
    const next = mapPage(el.getAttribute('href'));
    if (next !== null && next !== undefined) {
      el.setAttribute('href', next);
      stats.links += 1;
    }
  }

  for (const el of doc.querySelectorAll('style')) {
    if (!el.textContent) continue;
    el.textContent = rewriteCss(el.textContent, mapAsset);
    stats.css += 1;
  }

  for (const el of doc.querySelectorAll('[style]')) {
    const value = el.getAttribute('style');
    if (!value || value.indexOf('url(') === -1) continue;
    // Значение атрибута — не полноценная таблица стилей, оборачиваем в правило и снимаем обёртку.
    el.setAttribute('style', rewriteCss(`a{${value}}`, mapAsset).replace(/^a\{|\}$/g, ''));
    stats.css += 1;
  }

  /* SRI считается по исходному файлу. После переписывания хэш не сойдётся, и браузер откажется
     грузить ресурс молча — зеркало останется без стилей без единой ошибки в консоли. */
  for (const el of doc.querySelectorAll('[integrity]')) {
    el.removeAttribute('integrity');
    stats.integrityRemoved += 1;
  }

  /* Метаредирект уводит с сохранённой копии через несколько секунд. Снимаем content, а не сам
     тег: удалить целиком — значит скрыть от отчёта, что редирект на странице был. */
  for (const el of doc.querySelectorAll('meta[http-equiv]')) {
    if (String(el.getAttribute('http-equiv')).toLowerCase() === 'refresh') el.removeAttribute('content');
  }

  /*
   * Скрипты по умолчанию вырезаются. На локальной копии они бесполезны и вредны разом: аналитика
   * стучит в сеть, от которой мы и уходили, а роутер SPA переписывает адрес и показывает вместо
   * сохранённой страницы пустой каркас. Разметку JSON-LD при этом сохраняем — это данные.
   */
  if (scripts === 'strip') {
    for (const el of doc.querySelectorAll('script')) {
      if (String(el.getAttribute('type') || '').toLowerCase() === 'application/ld+json') continue;
      el.remove();
      stats.scriptsRemoved += 1;
    }
  }

  if (passport && doc.head) {
    doc.head.insertBefore(doc.createComment(` ${passport} `), doc.head.firstChild);
  }

  return stats;
}
