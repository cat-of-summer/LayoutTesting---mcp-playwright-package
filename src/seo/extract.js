/**
 * Извлечение SEO-полей из документа.
 *
 * Одна функция обслуживает два мира: живую страницу в браузере и сохранённый HTML, разобранный
 * linkedom. Держать две реализации нельзя — они разъедутся на первой же правке, причём молча:
 * тесты гоняются над linkedom, а в бою чаще работает браузерная ветка.
 *
 * Отсюда три ограничения, нарушение которых ломает браузерную ветку, не уронив ни одного теста:
 *
 *   1. Функция самодостаточна. Никаких импортов и обращений к модульной области — в браузер
 *      уезжает только её собственный текст. Все помощники объявлены внутри, как это уже сделано
 *      в buildSnapshot (checks/snapshot.js).
 *   2. Документ приходит параметром, а не берётся из глобальной области. page.evaluate передаёт
 *      ровно один сериализуемый аргумент, и Document через него не проходит, поэтому в браузере
 *      вызов собирается строкой — см. seo/page.js. Глобальный document был бы удобнее, но тогда
 *      Node-ветке пришлось бы писать в globalThis, а при параллельном обходе это гонка.
 *   3. Никакого getComputedStyle и getBoundingClientRect: в linkedom их нет. SEO живёт в разметке,
 *      а не в отрисовке, так что ограничение бесплатное.
 *
 * HTTP-поля (статус, заголовки, редиректы) в документе отсутствуют и приходят в opts снаружи.
 */
export function extractSeoFrom(doc, opts = {}) {
  const { url = '', status = null, headers = null, redirects = [] } = opts;

  const attr = (el, name) => (el && el.getAttribute(name)) || null;
  const txt = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const all = (sel) => Array.from(doc.querySelectorAll(sel));
  const nonEmpty = (obj) => (obj && Object.keys(obj).length ? obj : null);

  const base = (() => {
    const href = attr(doc.querySelector('base[href]'), 'href');
    if (!href) return url;
    try {
      return new URL(href, url || undefined).href;
    } catch {
      return url;
    }
  })();

  const abs = (href) => {
    if (!href) return null;
    try {
      return new URL(href, base || undefined).href;
    } catch {
      return null;
    }
  };

  /* HTTP не различает регистр заголовков, а источники различают: ищем без учёта регистра. */
  const header = (name) => {
    if (!headers) return null;
    const want = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === want) return headers[key];
    }
    return null;
  };

  // ---------- meta ----------

  const metaName = {};
  const metaProperty = {};
  const metaHttpEquiv = {};
  for (const el of all('meta')) {
    const content = el.getAttribute('content');
    if (content === null) continue;
    const n = attr(el, 'name');
    const p = attr(el, 'property');
    const h = attr(el, 'http-equiv');
    if (n) metaName[n.toLowerCase()] = content;
    if (p) metaProperty[p.toLowerCase()] = content;
    if (h) metaHttpEquiv[h.toLowerCase()] = content;
  }

  const withPrefix = (bag, prefix) => {
    const out = {};
    for (const key of Object.keys(bag)) {
      if (key.indexOf(prefix) === 0) out[key] = bag[key];
    }
    return out;
  };

  const charsetMeta = attr(doc.querySelector('meta[charset]'), 'charset');
  const charsetHeader = (metaHttpEquiv['content-type'] || '').match(/charset=([\w-]+)/i);
  const charset = charsetMeta || (charsetHeader ? charsetHeader[1] : null);

  // ---------- индексация ----------

  const robotsMeta = metaName.robots || null;
  const googlebot = metaName.googlebot || null;
  const xRobotsTag = header('x-robots-tag');
  const directives = [robotsMeta, googlebot, xRobotsTag]
    .filter(Boolean)
    .join(',')
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const canonicalRaw = attr(doc.querySelector('link[rel~="canonical"]'), 'href');
  const canonical = abs(canonicalRaw);

  /* Сравниваем адреса без якоря и хвостового слеша: иначе саморефренс не опознаётся у половины сайтов. */
  const normalize = (value) => {
    if (!value) return null;
    try {
      const parsed = new URL(value);
      parsed.hash = '';
      return parsed.href.replace(/\/$/, '');
    } catch {
      return value;
    }
  };
  const selfCanonical = canonical === null ? null : normalize(canonical) === normalize(url);

  const alternates = all('link[rel~="alternate"][hreflang]').map((el) => ({
    hreflang: attr(el, 'hreflang'),
    href: abs(attr(el, 'href')),
  }));

  // ---------- заголовки h1..h6 ----------

  const outline = all('h1, h2, h3, h4, h5, h6').map((el) => ({
    level: Number(el.tagName[1]),
    text: txt(el).slice(0, 200),
  }));
  const byLevel = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  for (const item of outline) byLevel['h' + item.level] += 1;

  /* Пропуск уровня — это h2, за которым сразу h4. Ломает и оглавление, и разбор страницы роботом. */
  const skippedLevels = [];
  for (let i = 1; i < outline.length; i += 1) {
    if (outline[i].level - outline[i - 1].level > 1) {
      skippedLevels.push({
        after: 'h' + outline[i - 1].level,
        found: 'h' + outline[i].level,
        text: outline[i].text,
      });
    }
  }

  // ---------- ссылки ----------

  const sameHost = (a, b) => {
    try {
      return new URL(a).host === new URL(b).host;
    } catch {
      return false;
    }
  };

  const links = {
    total: 0,
    internal: 0,
    external: 0,
    nofollow: 0,
    sponsored: 0,
    ugc: 0,
    emptyAnchor: 0,
    unsafeBlank: 0,
    mailto: 0,
    tel: 0,
    anchor: 0,
  };
  const internalLinks = [];
  const externalLinks = [];

  for (const el of all('a[href]')) {
    const raw = attr(el, 'href');
    links.total += 1;
    if (/^mailto:/i.test(raw)) {
      links.mailto += 1;
      continue;
    }
    if (/^tel:/i.test(raw)) {
      links.tel += 1;
      continue;
    }
    if (raw.charAt(0) === '#') {
      links.anchor += 1;
      continue;
    }

    const href = abs(raw);
    if (!href) continue;

    const rel = (attr(el, 'rel') || '').toLowerCase();
    if (rel.indexOf('nofollow') >= 0) links.nofollow += 1;
    if (rel.indexOf('sponsored') >= 0) links.sponsored += 1;
    if (rel.indexOf('ugc') >= 0) links.ugc += 1;

    /* Картинка с осмысленным alt — тоже анкор: такая ссылка не пустая. */
    if (!txt(el) && !el.querySelector('img[alt]:not([alt=""])')) links.emptyAnchor += 1;
    if (attr(el, 'target') === '_blank' && rel.indexOf('noopener') < 0 && rel.indexOf('noreferrer') < 0) {
      links.unsafeBlank += 1;
    }

    if (base && sameHost(href, base)) {
      links.internal += 1;
      if (internalLinks.indexOf(href) < 0) internalLinks.push(href);
    } else {
      links.external += 1;
      if (externalLinks.indexOf(href) < 0) externalLinks.push(href);
    }
  }

  // ---------- картинки ----------

  const images = { total: 0, noAlt: 0, emptyAlt: 0, noDimensions: 0, lazy: 0 };
  const noAltSample = [];
  for (const el of all('img')) {
    images.total += 1;
    const alt = el.getAttribute('alt');
    if (alt === null) {
      images.noAlt += 1;
      if (noAltSample.length < 10) noAltSample.push(abs(attr(el, 'src') || attr(el, 'data-src')));
    } else if (!alt.trim()) {
      images.emptyAlt += 1;
    }
    if (!attr(el, 'width') || !attr(el, 'height')) images.noDimensions += 1;
    if ((attr(el, 'loading') || '').toLowerCase() === 'lazy') images.lazy += 1;
  }

  // ---------- микроразметка ----------

  const jsonLd = [];
  for (const el of all('script[type="application/ld+json"]')) {
    const raw = String(el.textContent || '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      /*
       * Типы собираются со всего дерева, а не только с корня и @graph. Вложенность здесь несёт
       * смысл: Product с Offer и AggregateRating внутри — это три разных типа разметки, и отчёт,
       * знающий только про Product, умалчивает ровно о том, ради чего разметку и ставили.
       * Глубина ограничена: JSON.parse циклов не даёт, но чужая разметка бывает очень глубокой.
       */
      const types = [];
      const collect = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 12) return;
        if (Array.isArray(node)) {
          for (const item of node) collect(item, depth + 1);
          return;
        }
        if (node['@type']) types.push.apply(types, [].concat(node['@type']));
        for (const key of Object.keys(node)) {
          if (key !== '@type' && key !== '@context') collect(node[key], depth + 1);
        }
      };
      nodes.forEach((node) => collect(node, 0));
      jsonLd.push({
        ok: true,
        types,
        hasContext: nodes.some((n) => n && n['@context']),
        data: parsed,
      });
    } catch (err) {
      // Битый JSON-LD — рядовая находка, а не повод уронить разбор всей страницы.
      jsonLd.push({ ok: false, error: String((err && err.message) || err), excerpt: raw.slice(0, 200) });
    }
  }

  const microdata = all('[itemscope]').map((el) => ({
    type: attr(el, 'itemtype'),
    props: Array.from(el.querySelectorAll('[itemprop]'))
      .slice(0, 50)
      .map((p) => attr(p, 'itemprop'))
      .filter(Boolean),
  }));

  const rdfa = all('[typeof]').map((el) => ({
    type: attr(el, 'typeof'),
    props: Array.from(el.querySelectorAll('[property]'))
      .slice(0, 50)
      .map((p) => attr(p, 'property'))
      .filter(Boolean),
  }));

  // ---------- содержимое ----------

  const bodyText = txt(doc.body);
  const words = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const htmlLength = doc.documentElement && doc.documentElement.outerHTML ? doc.documentElement.outerHTML.length : 0;

  const title = txt(doc.querySelector('title'));
  const description = metaName.description || null;
  const firstH1 = outline.filter((h) => h.level === 1)[0];

  // ---------- индексируемость ----------

  const reasons = [];
  if (directives.indexOf('noindex') >= 0 || directives.indexOf('none') >= 0) {
    reasons.push('noindex в robots-мете или заголовке X-Robots-Tag');
  }
  if (status !== null && status !== 200) reasons.push('статус ответа ' + status);
  if (canonical && selfCanonical === false) reasons.push('canonical указывает на другой адрес: ' + canonical);

  return {
    url,
    finalUrl: base,
    status,
    redirects,

    title: { text: title || null, length: title.length },
    description: { text: description, length: description ? description.length : 0 },
    keywords: metaName.keywords || null,

    lang: attr(doc.documentElement, 'lang'),
    dir: attr(doc.documentElement, 'dir') || 'ltr',
    charset,
    viewport: metaName.viewport || null,
    metaRefresh: metaHttpEquiv.refresh || null,

    robots: { meta: robotsMeta, googlebot, xRobotsTag, directives },
    canonical: { href: canonical, raw: canonicalRaw, self: selfCanonical },
    alternates,
    hasXDefault: alternates.some((a) => String(a.hreflang || '').toLowerCase() === 'x-default'),
    pagination: {
      prev: abs(attr(doc.querySelector('link[rel~="prev"]'), 'href')),
      next: abs(attr(doc.querySelector('link[rel~="next"]'), 'href')),
    },
    amphtml: abs(attr(doc.querySelector('link[rel~="amphtml"]'), 'href')),
    manifest: abs(attr(doc.querySelector('link[rel~="manifest"]'), 'href')),
    icons: all('link[rel~="icon"], link[rel~="apple-touch-icon"]').map((el) => abs(attr(el, 'href'))),

    openGraph: nonEmpty(withPrefix(metaProperty, 'og:')),
    twitter: nonEmpty(Object.assign({}, withPrefix(metaName, 'twitter:'), withPrefix(metaProperty, 'twitter:'))),

    headings: {
      byLevel,
      missingH1: byLevel.h1 === 0,
      multipleH1: byLevel.h1 > 1,
      skippedLevels,
      outline: outline.slice(0, 100),
    },

    links,
    internalLinks,
    externalLinks: externalLinks.slice(0, 100),

    images: Object.assign({}, images, { noAltSample }),

    structuredData: { jsonLd, microdata, rdfa },

    content: {
      words,
      textLength: bodyText.length,
      htmlLength,
      textRatio: htmlLength ? Math.round((bodyText.length / htmlLength) * 1000) / 1000 : 0,
      firstH1: firstH1 ? firstH1.text : null,
    },

    http: headers
      ? {
          contentType: header('content-type'),
          cacheControl: header('cache-control'),
          hsts: header('strict-transport-security'),
          contentEncoding: header('content-encoding'),
        }
      : null,

    indexable: reasons.length === 0,
    reasons,
  };
}
