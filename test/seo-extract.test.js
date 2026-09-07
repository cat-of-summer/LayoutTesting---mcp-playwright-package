/**
 * Извлечение SEO-полей.
 *
 * Числа здесь взяты из fixtures/seo.html и намеренно жёсткие. Мягкая проверка вида «нашлось
 * хоть что-то» на таком коде бесполезна: экстрактор ломается не падением, а тихой недостачей —
 * селектор перестал совпадать, счётчик недосчитал, поле осталось null. Такое видно только по
 * конкретному ожидаемому значению.
 *
 * Отдельно закреплено то, что находки не должны ронять разбор: битый JSON-LD лежит в фикстуре
 * рядом с целым, и оба обязаны доехать до результата.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { DIRS } from '../src/config.js';
import { extractSeoFrom } from '../src/seo/extract.js';
import path from 'node:path';

const URL_UNDER_TEST = 'https://example.test/seo-page';

const html = await readFile(path.join(DIRS.fixtures, 'seo.html'), 'utf8');
const seo = extractSeoFrom(parseHTML(html).document, {
  url: URL_UNDER_TEST,
  status: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=60' },
});

test('документные поля', () => {
  assert.equal(seo.title.text, 'Справочник по котлам — образец страницы');
  assert.equal(seo.title.length, seo.title.text.length);
  assert.equal(seo.description.text, 'Образцовое описание страницы для проверки извлечения полей.');
  assert.equal(seo.keywords, 'котлы, справочник, образец');
  assert.equal(seo.lang, 'ru');
  assert.equal(seo.charset, 'utf-8');
  assert.ok(seo.viewport.includes('width=device-width'));
});

test('canonical опознаётся как саморефренс', () => {
  assert.equal(seo.canonical.href, URL_UNDER_TEST);
  assert.equal(seo.canonical.self, true);
});

/* Хвостовой слеш и якорь не должны превращать саморефренс в чужой адрес. */
test('саморефренс не зависит от хвостового слеша и якоря', () => {
  const again = extractSeoFrom(parseHTML(html).document, { url: URL_UNDER_TEST + '/#top', status: 200 });
  assert.equal(again.canonical.self, true);
});

test('hreflang собирается целиком, x-default виден', () => {
  assert.equal(seo.alternates.length, 3);
  assert.equal(seo.hasXDefault, true);
  assert.deepEqual(
    seo.alternates.map((a) => a.hreflang),
    ['ru', 'en', 'x-default'],
  );
});

test('пагинация и служебные ссылки головы', () => {
  assert.equal(seo.pagination.prev, 'https://example.test/seo-page?page=1');
  assert.equal(seo.pagination.next, 'https://example.test/seo-page?page=3');
  assert.equal(seo.manifest, 'https://example.test/site.webmanifest');
  assert.deepEqual(seo.icons, ['https://example.test/favicon.ico']);
});

test('открытый граф и twitter разложены по своим наборам', () => {
  assert.equal(seo.openGraph['og:title'], 'Справочник по котлам');
  assert.equal(seo.openGraph['og:type'], 'article');
  assert.equal(seo.twitter['twitter:card'], 'summary_large_image');
});

test('дерево заголовков: два h1 и пропущенный уровень', () => {
  assert.equal(seo.headings.byLevel.h1, 2);
  assert.equal(seo.headings.byLevel.h2, 2);
  assert.equal(seo.headings.multipleH1, true);
  assert.equal(seo.headings.missingH1, false);
  assert.deepEqual(
    seo.headings.skippedLevels.map((s) => s.after + '->' + s.found),
    ['h2->h4'],
  );
});

test('ссылки разделены на внутренние и внешние и посчитаны по признакам', () => {
  assert.equal(seo.links.internal, 4);
  assert.equal(seo.links.external, 2);
  assert.equal(seo.links.nofollow, 1);
  assert.equal(seo.links.sponsored, 1);
  assert.equal(seo.links.anchor, 1);
  assert.equal(seo.links.mailto, 1);
  assert.equal(seo.links.tel, 1);
  assert.equal(seo.links.emptyAnchor, 1);
  assert.equal(seo.links.unsafeBlank, 1);
});

/* Ссылка-картинка с осмысленным alt — не пустой анкор, и повтор адреса не задваивает список. */
test('картинка с alt считается анкором, дубли адресов схлопываются', () => {
  assert.ok(seo.internalLinks.includes('https://example.test/catalog'));
  assert.equal(seo.internalLinks.filter((u) => u.endsWith('/catalog')).length, 1);
});

test('картинки: отдельно нет alt, отдельно пустой alt', () => {
  assert.equal(seo.images.total, 5);
  assert.equal(seo.images.noAlt, 1);
  assert.equal(seo.images.emptyAlt, 1);
  assert.equal(seo.images.lazy, 1);
  assert.equal(seo.images.noDimensions, 2);
});

test('битый JSON-LD не роняет разбор и приезжает рядом с целым', () => {
  assert.equal(seo.structuredData.jsonLd.length, 2);
  const ok = seo.structuredData.jsonLd.filter((b) => b.ok);
  const bad = seo.structuredData.jsonLd.filter((b) => !b.ok);
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.deepEqual(ok[0].types, ['Article', 'Person']);
  assert.equal(ok[0].hasContext, true);
  assert.ok(bad[0].error);
});

test('микроданные и RDFa извлекаются', () => {
  assert.equal(seo.structuredData.microdata.length, 1);
  assert.equal(seo.structuredData.microdata[0].type, 'https://schema.org/Organization');
  assert.deepEqual(seo.structuredData.microdata[0].props, ['name', 'telephone']);
  assert.equal(seo.structuredData.rdfa[0].type, 'Person');
});

test('индексируемость: чистая страница проходит', () => {
  assert.equal(seo.indexable, true);
  assert.deepEqual(seo.reasons, []);
});

test('noindex, чужой canonical и не-200 попадают в причины', () => {
  const noindex = extractSeoFrom(parseHTML('<meta name="robots" content="noindex"><title>x</title>').document, {
    url: URL_UNDER_TEST,
    status: 200,
  });
  assert.equal(noindex.indexable, false);
  assert.match(noindex.reasons[0], /noindex/);

  const foreign = extractSeoFrom(parseHTML('<link rel="canonical" href="https://example.test/other">').document, {
    url: URL_UNDER_TEST,
    status: 200,
  });
  assert.equal(foreign.canonical.self, false);
  assert.equal(foreign.indexable, false);

  const notFound = extractSeoFrom(parseHTML('<title>нет</title>').document, { url: URL_UNDER_TEST, status: 404 });
  assert.equal(notFound.indexable, false);
  assert.match(notFound.reasons[0], /404/);
});

/* X-Robots-Tag живёт только в заголовке ответа: в документе его нет, и без opts он теряется. */
test('noindex из заголовка X-Robots-Tag учитывается наравне с метой', () => {
  const fromHeader = extractSeoFrom(parseHTML('<title>x</title>').document, {
    url: URL_UNDER_TEST,
    status: 200,
    headers: { 'x-robots-tag': 'noindex, nofollow' },
  });
  assert.equal(fromHeader.indexable, false);
  assert.equal(fromHeader.robots.xRobotsTag, 'noindex, nofollow');
});

test('HTTP-поля берутся из заголовков без учёта регистра', () => {
  assert.equal(seo.http.cacheControl, 'max-age=60');
  assert.match(seo.http.contentType, /text\/html/);
});

/* Без заголовков раздел http отсутствует целиком, а не заполняется пустышками: пустая строка
   в отчёте неотличима от «сервер не прислал заголовок». */
test('без заголовков раздел http равен null', () => {
  const bare = extractSeoFrom(parseHTML('<title>x</title>').document, { url: URL_UNDER_TEST });
  assert.equal(bare.http, null);
  assert.equal(bare.robots.xRobotsTag, null);
});

test('пустой документ не роняет извлечение', () => {
  const empty = extractSeoFrom(parseHTML('<html></html>').document, { url: URL_UNDER_TEST });
  assert.equal(empty.title.text, null);
  assert.equal(empty.headings.missingH1, true);
  assert.equal(empty.links.total, 0);
  assert.equal(empty.images.total, 0);
  assert.deepEqual(empty.structuredData.jsonLd, []);
});

/* base href меняет разрешение всех относительных адресов на странице. */
test('base href учитывается при разрешении относительных ссылок', () => {
  const doc = parseHTML(
    '<base href="https://cdn.example.test/sub/"><a href="page.html">x</a><img src="i.png">',
  ).document;
  const withBase = extractSeoFrom(doc, { url: URL_UNDER_TEST });
  assert.equal(withBase.finalUrl, 'https://cdn.example.test/sub/');
  assert.equal(withBase.links.external, 0);
  assert.equal(withBase.links.internal, 1);
  assert.equal(withBase.internalLinks[0], 'https://cdn.example.test/sub/page.html');
});
