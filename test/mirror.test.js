/**
 * Переписывание ссылок и хранилище ресурсов зеркала.
 *
 * Зеркало ломается тихо: страница открывается, но без стилей, или с пустыми рамками вместо
 * картинок, или уводит на боевой сайт через секунду после открытия. Ни одна из этих поломок не
 * даёт исключения, поэтому каждая закреплена случаем.
 *
 * Браузер не нужен: rewrite работает над деревом linkedom, а putAsset — над буфером.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { assetName, extensionFor, putAsset } from '../src/mirror/assets.js';
import { mapSrcset, rewriteCss, rewriteDocument } from '../src/mirror/rewrite.js';
import { normalizeUrl, pageIdFor, sameSite, tryNormalize } from '../src/crawl/url.js';

const toLocal = (map) => (value) => map[value] ?? null;

// ---------- адреса ----------

test('якорь и метки кампаний схлопываются, порядок параметров не важен', () => {
  const a = normalizeUrl('https://Example.test/page?b=2&utm_source=mail&a=1#top');
  const b = normalizeUrl('https://example.test/page?a=1&b=2');
  assert.equal(a, b);
});

test('одинаковые адреса дают один pageId, разные — разные', () => {
  assert.equal(pageIdFor('https://example.test/a?x=1#f'), pageIdFor('https://example.test/a?x=1'));
  assert.notEqual(pageIdFor('https://example.test/a'), pageIdFor('https://example.test/b'));
});

/* Хвостовой слеш и регистр пути не трогаем: для сервера это разные адреса, и решать ему. */
test('регистр пути и хвостовой слеш сохраняются', () => {
  assert.notEqual(normalizeUrl('https://example.test/A'), normalizeUrl('https://example.test/a'));
  assert.notEqual(normalizeUrl('https://example.test/a/'), normalizeUrl('https://example.test/a'));
});

test('мусорный href не роняет разбор', () => {
  assert.equal(tryNormalize('javascript:void(0)', 'https://example.test/'), 'javascript:void(0)');
  assert.equal(tryNormalize('   ', undefined), null);
});

test('поддомен считается тем же сайтом, чужой хост — нет', () => {
  assert.equal(sameSite('https://example.test/a', 'https://www.example.test/b'), true);
  assert.equal(sameSite('https://shop.example.test/a', 'https://example.test/b'), true);
  assert.equal(sameSite('https://example.test/a', 'https://other.test/b'), false);
});

// ---------- ресурсы ----------

test('расширение берётся из Content-Type, а не из адреса', () => {
  assert.equal(extensionFor('https://example.test/style', 'text/css; charset=utf-8'), 'css');
  assert.equal(extensionFor('https://example.test/x.css?v=3', ''), 'css');
  assert.equal(extensionFor('https://example.test/unknown', ''), 'bin');
});

test('одинаковое содержимое по разным адресам даёт одно имя', () => {
  const body = Buffer.from('body{color:red}');
  const a = assetName(body, 'https://cdn1.test/a.css', 'text/css');
  const b = assetName(body, 'https://cdn2.test/b.css?v=9', 'text/css');
  assert.equal(a.file, b.file);
});

test('повторная укладка не пишет файл заново', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-assets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const body = Buffer.from('body{color:red}');
  const first = await putAsset(dir, body, { url: 'https://a.test/x.css', contentType: 'text/css' });
  const second = await putAsset(dir, body, { url: 'https://b.test/y.css', contentType: 'text/css' });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.rel, second.rel);
  /* Шардинг по двум первым символам хэша: иначе каталог вырастает в десятки тысяч файлов. */
  assert.match(first.rel, /^assets\/[0-9a-f]{2}\/[0-9a-f]{40}\.css$/);
});

// ---------- srcset и CSS ----------

test('srcset переписывается по адресам, дескрипторы сохраняются', () => {
  const out = mapSrcset('a.png 1x, b.png 2x', toLocal({ 'a.png': 'X.png', 'b.png': 'Y.png' }));
  assert.equal(out, 'X.png 1x, Y.png 2x');
});

test('несопоставленный адрес в srcset остаётся прежним', () => {
  assert.equal(mapSrcset('a.png 480w, b.png 960w', toLocal({ 'a.png': 'X.png' })), 'X.png 480w, b.png 960w');
});

test('url() переписывается при любых кавычках, data: не трогается', () => {
  const css = "a{background:url(x.png)}b{background:url('x.png')}c{background:url(\"x.png\")}d{background:url(data:image/gif;base64,R0lGOD)}";
  const out = rewriteCss(css, toLocal({ 'x.png': 'L.png' }));
  assert.equal(out.match(/L\.png/g).length, 3);
  assert.match(out, /data:image\/gif;base64,R0lGOD/);
});

test('@import переписывается вместе с url()', () => {
  const out = rewriteCss('@import "base.css"; a{background:url(y.png)}', toLocal({ 'base.css': 'B.css', 'y.png': 'Y.png' }));
  assert.match(out, /@import "B\.css"/);
  assert.match(out, /url\(Y\.png\)/);
});

// ---------- документ ----------

const build = (html, maps = {}) => {
  const { document } = parseHTML(html);
  const stats = rewriteDocument(document, {
    mapAsset: toLocal(maps.assets || {}),
    mapPage: toLocal(maps.pages || {}),
    scripts: maps.scripts || 'strip',
    passport: maps.passport ?? null,
  });
  return { html: document.documentElement.outerHTML, stats, document };
};

test('амперсанд в адресе не разъезжается при переписывании', () => {
  /* Ровно то, ради чего переписывание идёт по DOM, а не регулярками: setAttribute экранирует сам,
     и vnu не покажет ошибок, которых на исходном сайте не было. */
  const { html } = build('<html><body><a href="/old?a=1&amp;b=2">x</a></body></html>', {
    pages: { '/old?a=1&b=2': '../abc/page.html' },
  });
  assert.match(html, /href="\.\.\/abc\/page\.html"/);
  assert.ok(!html.includes('&b=2'), 'неэкранированный амперсанд попал в разметку');
});

test('ссылка на несохранённую страницу остаётся прежней', () => {
  const { html } = build('<html><body><a href="https://example.test/nope">x</a></body></html>');
  assert.match(html, /href="https:\/\/example\.test\/nope"/);
});

test('ленивые картинки переписываются по data-src', () => {
  const { html } = build('<html><body><img data-src="lazy.png" src="stub.gif"></body></html>', {
    assets: { 'lazy.png': '../../assets/aa/1.png', 'stub.gif': '../../assets/bb/2.gif' },
  });
  assert.match(html, /data-src="\.\.\/\.\.\/assets\/aa\/1\.png"/);
  assert.match(html, /src="\.\.\/\.\.\/assets\/bb\/2\.gif"/);
});

test('integrity снимается: после переписывания хэш не сойдётся', () => {
  const { html, stats } = build('<html><head><link rel="stylesheet" href="a.css" integrity="sha384-xxx"></head><body></body></html>', {
    assets: { 'a.css': '../../assets/cc/3.css' },
  });
  assert.equal(stats.integrityRemoved, 1);
  assert.ok(!html.includes('integrity'));
});

test('метаредирект обезврежен, но остаётся виден в разметке', () => {
  const { html } = build('<html><head><meta http-equiv="refresh" content="3;url=https://example.test/"></head><body></body></html>');
  assert.match(html, /http-equiv="refresh"/, 'сам тег должен остаться — иначе редирект исчезнет из отчёта');
  assert.ok(!html.includes('content='), 'content обязан быть снят, иначе копия уедет на боевой сайт');
});

test('скрипты вырезаются, JSON-LD остаётся', () => {
  const { html, stats } = build(
    '<html><head><script src="app.js"></script><script type="application/ld+json">{"@type":"Article"}</script></head><body></body></html>',
  );
  assert.equal(stats.scriptsRemoved, 1);
  assert.ok(!html.includes('app.js'));
  assert.match(html, /application\/ld\+json/);
});

test('со scripts: keep скрипты сохраняются', () => {
  const { html, stats } = build('<html><head><script src="app.js"></script></head><body></body></html>', { scripts: 'keep' });
  assert.equal(stats.scriptsRemoved, 0);
  assert.match(html, /app\.js/);
});

test('паспорт копии вписывается в head', () => {
  const { html } = build('<html><head><title>x</title></head><body></body></html>', { passport: 'Локальная копия https://example.test/' });
  assert.match(html, /<!-- Локальная копия https:\/\/example\.test\/ -->/);
});

test('url() в инлайновом style переписывается', () => {
  const { html } = build('<html><body><div style="background:url(bg.png);color:red"></div></body></html>', {
    assets: { 'bg.png': '../../assets/dd/4.png' },
  });
  assert.match(html, /background:url\(\.\.\/\.\.\/assets\/dd\/4\.png\)/);
  assert.match(html, /color:red/);
});

/*
 * xlink:href у SVG. Двоеточие — часть имени атрибута, но в селекторе разделяет псевдокласс:
 * без экранирования querySelectorAll бросает «Attribute selector didn't terminate» и роняет
 * переписывание целиком, ещё до того как дойдёт до остальных атрибутов.
 */
test('атрибут с двоеточием не роняет переписывание', () => {
  const { html } = build('<html><body><svg><use xlink:href="icons.svg#star"></use></svg></body></html>', {
    assets: { 'icons.svg#star': '../../assets/ee/5.svg' },
  });
  assert.match(html, /\.\.\/\.\.\/assets\/ee\/5\.svg/);
});
