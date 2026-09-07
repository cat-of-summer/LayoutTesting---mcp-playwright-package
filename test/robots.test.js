/**
 * robots.txt: от него зависит, постучимся ли мы туда, куда нас не звали.
 *
 * Ошибка здесь не видна в работе: обход идёт, страницы копятся, и то, что половина из них была
 * закрыта, выясняется в лучшем случае из чужих логов. Поэтому проверяются края, а не общий случай.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlDelayMs, groupFor, isAllowed, parseRobots, parseSitemap } from '../src/crawl/robots.js';

const UA = 'LayoutTestingBot/0.3';

test('простой запрет и разрешение', () => {
  const r = parseRobots('User-agent: *\nDisallow: /admin\nAllow: /admin/public');
  assert.equal(isAllowed(r, UA, 'https://a.test/admin/secret'), false);
  assert.equal(isAllowed(r, UA, 'https://a.test/catalog'), true);
});

/* Выигрывает самое длинное совпавшее правило — иначе Allow под общим Disallow не работает. */
test('длинное правило перебивает короткое', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\nAllow: /catalog/');
  assert.equal(isAllowed(r, UA, 'https://a.test/catalog/gas'), true);
  assert.equal(isAllowed(r, UA, 'https://a.test/about'), false);
});

test('при равной длине выигрывает Allow', () => {
  const r = parseRobots('User-agent: *\nDisallow: /page\nAllow: /page');
  assert.equal(isAllowed(r, UA, 'https://a.test/page'), true);
});

/*
 * Пустой Disallow — «не запрещено ничего». Перепутать его с отсутствующим значит либо закрыть
 * себе весь сайт, либо пойти обходить закрытый.
 */
test('пустой Disallow разрешает всё, Disallow: / запрещает всё', () => {
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), UA, 'https://a.test/x'), true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /'), UA, 'https://a.test/x'), false);
});

test('звёздочка и знак конца строки работают', () => {
  const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/private');
  assert.equal(isAllowed(r, UA, 'https://a.test/docs/file.pdf'), false);
  assert.equal(isAllowed(r, UA, 'https://a.test/docs/file.pdf?v=1'), true, '$ обязан требовать конец строки');
  assert.equal(isAllowed(r, UA, 'https://a.test/tmp/a/private'), false);
});

/* Точка в шаблоне — обычный символ. Без экранирования /a.pdf совпал бы с /axpdf. */
test('точка в шаблоне не совпадает с чем угодно', () => {
  const r = parseRobots('User-agent: *\nDisallow: /a.pdf');
  assert.equal(isAllowed(r, UA, 'https://a.test/axpdf'), true);
});

test('несколько User-agent подряд задают одну группу', () => {
  const r = parseRobots('User-agent: googlebot\nUser-agent: LayoutTestingBot\nDisallow: /closed');
  assert.equal(isAllowed(r, UA, 'https://a.test/closed'), false);
  assert.equal(groupFor(r, 'googlebot').disallow.length, 1);
});

/* Своя группа заменяет общую целиком: сайт, отдельно разрешивший что-то нам, не должен
   получить сверху ещё и запреты для всех. */
test('точная группа перебивает звёздочку, а не дополняет её', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: LayoutTestingBot\nDisallow: /admin');
  assert.equal(isAllowed(r, UA, 'https://a.test/catalog'), true);
  assert.equal(isAllowed(r, UA, 'https://a.test/admin'), false);
});

test('комментарии и пустые строки не мешают', () => {
  const r = parseRobots('# заметка\nUser-agent: *   # и тут\nDisallow: /x  # и тут\n\n');
  assert.equal(isAllowed(r, UA, 'https://a.test/x'), false);
});

test('sitemap собирается отдельно от групп', () => {
  const r = parseRobots('Sitemap: https://a.test/sitemap.xml\nUser-agent: *\nDisallow:');
  assert.deepEqual(r.sitemaps, ['https://a.test/sitemap.xml']);
});

/* Просьбу сайта замедлиться уважаем, но собственную паузу не уменьшаем. */
test('Crawl-delay может только увеличить паузу', () => {
  assert.equal(crawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 2'), UA, 500), 2000);
  assert.equal(crawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 0.1'), UA, 500), 500);
  assert.equal(crawlDelayMs(parseRobots('User-agent: *'), UA, 500), 500);
});

test('запрет учитывает строку запроса, а не только путь', () => {
  const r = parseRobots('User-agent: *\nDisallow: /*?sort=');
  assert.equal(isAllowed(r, UA, 'https://a.test/catalog?sort=price'), false);
  assert.equal(isAllowed(r, UA, 'https://a.test/catalog'), true);
});

// ---------- sitemap ----------

test('обычная карта разбирается', async () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://a.test/</loc><lastmod>2026-01-02</lastmod></url>
    <url><loc>https://a.test/catalog</loc></url>
  </urlset>`;
  const map = await parseSitemap(xml);
  assert.equal(map.isIndex, false);
  assert.equal(map.total, 2);
  assert.equal(map.entries[0].lastmod, '2026-01-02');
});

/* Индексная карта отличается корневым тегом, и спутать их значит принять список карт
   за список страниц. */
test('индексная карта опознаётся', async () => {
  const xml = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://a.test/sitemap-1.xml</loc></sitemap>
    <sitemap><loc>https://a.test/sitemap-2.xml</loc></sitemap>
  </sitemapindex>`;
  const map = await parseSitemap(xml);
  assert.equal(map.isIndex, true);
  assert.equal(map.total, 2);
});

test('карта без адресов не роняет разбор', async () => {
  assert.equal((await parseSitemap('<urlset></urlset>')).total, 0);
  assert.equal((await parseSitemap('')).total, 0);
});
