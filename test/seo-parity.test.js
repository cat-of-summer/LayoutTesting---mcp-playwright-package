/**
 * Главный инвариант SEO-извлечения: обе ветки дают одно и то же.
 *
 * Экстрактор один, но исполняется в двух разных мирах — в браузере он уезжает туда текстом
 * функции, в Node работает над деревом linkedom. Сломать браузерную ветку можно молча: достаточно
 * добавить внутрь функции импорт или обращение к модульной области, и все остальные тесты, которые
 * гоняются над linkedom, останутся зелёными. Этот тест — единственное место, где такая поломка
 * видна.
 *
 * Сравнивается не весь результат: часть полей обязана различаться, и это не дефект.
 * content.htmlLength считается по сериализации документа, а браузер нормализует разметку — дописывает
 * tbody, закрывает теги, выбрасывает комментарии. Поэтому сверяется всё, что относится к смыслу
 * страницы, и не сверяются длины разметки.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIRS } from '../src/config.js';
import { seoFromHtml, seoFromPage } from '../src/seo/page.js';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

/* Один и тот же адрес для обеих веток: иначе относительные ссылки разрешатся по-разному
   и расхождение будет говорить о постановке теста, а не о коде. */
const PAGE_URL = 'https://example.test/seo-page';

/** Поля, которые несут смысл страницы и обязаны совпадать до знака. */
const meaningful = (seo) => ({
  title: seo.title,
  description: seo.description,
  keywords: seo.keywords,
  lang: seo.lang,
  charset: seo.charset,
  viewport: seo.viewport,
  robots: seo.robots,
  canonical: seo.canonical,
  alternates: seo.alternates,
  hasXDefault: seo.hasXDefault,
  pagination: seo.pagination,
  manifest: seo.manifest,
  icons: seo.icons,
  openGraph: seo.openGraph,
  twitter: seo.twitter,
  headings: seo.headings,
  links: seo.links,
  internalLinks: seo.internalLinks,
  externalLinks: seo.externalLinks,
  images: seo.images,
  structuredData: seo.structuredData,
  indexable: seo.indexable,
  reasons: seo.reasons,
});

test('браузерная ветка и linkedom дают одинаковый результат', options, async () => {
  const { chromium } = await import('playwright');
  const file = path.join(DIRS.fixtures, 'seo.html');
  const html = await readFile(file, 'utf8');

  const fromHtml = await seoFromHtml(html, { url: PAGE_URL, status: 200 });

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(file).href);
    const fromPage = await seoFromPage(page, { url: PAGE_URL, status: 200 });

    assert.deepEqual(meaningful(fromPage), meaningful(fromHtml));

    /* Отдельно — что браузерная ветка вообще что-то извлекла. deepEqual двух пустых объектов
       тоже прошёл бы, и такой тест ничего бы не значил. */
    assert.equal(fromPage.title.text, 'Справочник по котлам — образец страницы');
    assert.equal(fromPage.headings.byLevel.h1, 2);
    assert.equal(fromPage.structuredData.jsonLd.length, 2);
  } finally {
    await browser.close();
  }
});

/*
 * Страница с Content-Security-Policy без unsafe-eval. Вызов собирается строкой именно поэтому:
 * new Function внутри страницы здесь падает, а Runtime.evaluate — нет. Проверка стоит того, чтобы
 * существовать: переписать вызов на «более чистый» page.evaluate(fn) кажется улучшением ровно до
 * встречи с таким сайтом.
 */
test('извлечение работает под CSP без unsafe-eval', options, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'" },
        body: '<!doctype html><html lang="ru"><head><title>Под CSP</title></head><body><h1>Заголовок</h1></body></html>',
      }),
    );
    await page.goto('https://csp.example.test/');

    const seo = await seoFromPage(page, { url: PAGE_URL, status: 200 });
    assert.equal(seo.title.text, 'Под CSP');
    assert.equal(seo.headings.byLevel.h1, 1);
  } finally {
    await browser.close();
  }
});
