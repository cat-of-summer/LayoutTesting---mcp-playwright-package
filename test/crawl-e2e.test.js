/**
 * Обход целиком: поднять маленький сайт, обойти его и поработать по архиву.
 *
 * Браузер здесь не нужен намеренно — режим render: never. Гибридная эскалация проверяется
 * отдельно, а всё остальное в обходе (очередь, дедупликация адресов, robots, глубина, индекс,
 * выборки) от браузера не зависит, и гонять ради него Chromium значит превратить быстрый тест
 * в двадцатисекундный.
 *
 * Сайт собран так, чтобы каждая проверка имела на чём сработать: дублирующиеся заголовки,
 * закрытый в robots раздел, страница глубже лимита, битая ссылка, ссылка наружу.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { startCrawl, crawlStatus, looksEmpty, decodeBody, DEFAULTS } from '../src/crawl/runner.js';
import { queryPages, querySelector } from '../src/crawl/query.js';
import { readFrontier, readIndex, removeSite, siteDir } from '../src/crawl/store.js';

const SITE_ID = 'lt-crawl-e2e';

/* Текста на страницах с запасом: обход в режиме auto счёл бы короткую страницу пустой
   и полез бы за браузером. Здесь это не проверяется, поэтому текст настоящий. */
const filler =
  'Этот абзац существует ради объёма: обход считает страницу пустой, если видимого текста ' +
  'меньше двух сотен символов, и в гибридном режиме отправляет такую страницу в браузер. ' +
  'Здесь проверяется не эскалация, а сам обход, поэтому текста заведомо достаточно.';

const page = (title, body, extra = '') => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${title}</title>${extra}</head>
<body><h1>${title}</h1><p>${filler}</p>${body}</body></html>`;

function serve() {
  const routes = {
    '/': page('Главная', '<a href="/a">А</a> <a href="/b">Б</a> <a href="/admin/secret">Закрытое</a> <a href="https://outside.test/x">Наружу</a>'),
    '/a': page('Дубль', '<a href="/c">В</a> <a href="/broken">Битая</a>', '<meta name="description" content="одно и то же">'),
    '/b': page('Дубль', '<a href="/a">А</a>', '<meta name="description" content="одно и то же">'),
    '/c': page('Глубокая', '<a href="/d">Г</a>'),
    '/d': page('Глубже лимита', ''),
    '/admin/secret': page('Не должно попасть', ''),
    '/robots.txt': 'User-agent: *\nDisallow: /admin\n',
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const hit = routes[url];
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Нет страницы', ''));
      return;
    }
    res.writeHead(200, { 'Content-Type': url === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8' });
    res.end(hit);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const settle = async (siteId) => {
  for (let i = 0; i < 100; i += 1) {
    const status = await crawlStatus(siteId);
    /* finishing — задача досчитала, но ещё дописывает файлы. Уходить отсюда рано:
       следом идёт очистка каталога, и она наткнётся на незаконченную запись. */
    if (status.status !== 'running' && status.status !== 'finishing') return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('обход не завершился за отведённое время');
};

test('обход собирает сайт, уважает robots и глубину', async (t) => {
  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await removeSite(SITE_ID);
  });

  const started = await startCrawl({
    url: `http://127.0.0.1:${port}/`,
    siteId: SITE_ID,
    render: 'never',
    delayMs: 0,
    maxDepth: 2,
    maxPages: 50,
  });
  assert.equal(started.siteId, SITE_ID);
  assert.equal(started.status, 'running', 'старт обязан возвращать управление сразу');

  const done = await settle(SITE_ID);
  assert.equal(done.status, 'done');

  const index = await readIndex(SITE_ID);
  const paths = Object.keys(index.pages).map((u) => new URL(u).pathname).sort();

  assert.deepEqual(paths, ['/', '/a', '/b', '/broken', '/c'], `обошлось не то: ${paths.join(', ')}`);

  /* /admin/secret закрыт в robots.txt, /d лежит на глубине 3 при лимите 2. Обе причины
     разные, и ни одна не должна выглядеть как «страницы не существует». */
  const frontier = await readFrontier(SITE_ID);
  const skipped = Object.keys(frontier.skipped).map((u) => new URL(u).pathname);
  assert.deepEqual(skipped, ['/admin/secret']);
  assert.match(Object.values(frontier.skipped)[0].reason, /robots/);
  assert.ok(Object.values(frontier.skipped)[0].from, 'у пропущенной страницы должен быть источник ссылки');
});

test('битая страница попадает в архив со своим кодом, а не теряется', async (t) => {
  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await removeSite(SITE_ID);
  });

  await startCrawl({ url: `http://127.0.0.1:${port}/`, siteId: SITE_ID, render: 'never', delayMs: 0, maxDepth: 2 });
  await settle(SITE_ID);

  const found = await queryPages(SITE_ID, { filter: { status: 404 } });
  assert.equal(found.total, 1);
  assert.match(found.pages[0].url, /\/broken$/);
});

test('дубли заголовков и описаний находятся группировкой', async (t) => {
  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await removeSite(SITE_ID);
  });

  await startCrawl({ url: `http://127.0.0.1:${port}/`, siteId: SITE_ID, render: 'never', delayMs: 0, maxDepth: 2 });
  await settle(SITE_ID);

  const byTitle = await queryPages(SITE_ID, { groupBy: 'title' });
  /* Одиночные заголовки в ответ не попадают: показывать их значит утопить находку в шуме. */
  assert.equal(byTitle.total, 1, 'ожидалась ровно одна группа дублей');
  assert.equal(byTitle.groups[0].value, 'Дубль');
  assert.equal(byTitle.groups[0].count, 2);

  const byDescription = await queryPages(SITE_ID, { groupBy: 'description' });
  assert.equal(byDescription.groups[0].count, 2);
});

test('селектор по архиву отвечает узлами с указанием страницы', async (t) => {
  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await removeSite(SITE_ID);
  });

  await startCrawl({ url: `http://127.0.0.1:${port}/`, siteId: SITE_ID, render: 'never', delayMs: 0, maxDepth: 2 });
  await settle(SITE_ID);

  const hits = await querySelector(SITE_ID, { select: 'h1' });
  assert.equal(hits.pagesWithHits, 5);
  assert.ok(hits.hits.every((h) => h.url && h.count === 1));
  assert.ok(hits.hits.some((h) => h.nodes[0].text === 'Главная'));

  const links = await querySelector(SITE_ID, { select: 'a[href]', attr: 'href' });
  assert.ok(links.totalMatches > 0);
  assert.ok(links.hits[0].nodes[0].href !== undefined, 'запрошенный атрибут обязан приехать');
});

test('полнотекстовый поиск идёт по сохранённой разметке', async (t) => {
  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await removeSite(SITE_ID);
  });

  await startCrawl({ url: `http://127.0.0.1:${port}/`, siteId: SITE_ID, render: 'never', delayMs: 0, maxDepth: 2 });
  await settle(SITE_ID);

  const found = await queryPages(SITE_ID, { text: 'Глубокая' });
  assert.equal(found.total, 1);
  assert.match(found.pages[0].url, /\/c$/);

  assert.equal((await queryPages(SITE_ID, { text: 'такого текста нет нигде' })).total, 0);
});

test('страницы действительно лежат на диске, а не только в индексе', async (t) => {
  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await removeSite(SITE_ID);
  });

  await startCrawl({ url: `http://127.0.0.1:${port}/`, siteId: SITE_ID, render: 'never', delayMs: 0, maxDepth: 1 });
  await settle(SITE_ID);

  const index = await readIndex(SITE_ID);
  const entries = Object.values(index.pages);
  /* Без этой строки тест проходит на пустом индексе: цикл ниже просто не выполняется ни разу.
     Ровно так он и промолчал, когда обход не работал совсем. */
  assert.ok(entries.length >= 3, `в индексе ${entries.length} страниц — обход не отработал`);

  for (const entry of entries) {
    const file = `${siteDir(SITE_ID)}/pages/${entry.pageId}/raw.html`;
    const stat = await fs.stat(file).catch(() => null);
    assert.ok(stat && stat.size > 0, `страницы ${entry.pageId} нет на диске`);
  }
});

// ---------- чистые функции обхода ----------

test('признак пустой страницы срабатывает на каркасе SPA и на коротком тексте', () => {
  assert.equal(looksEmpty('<html><body><div id="root"></div></body></html>'), true);
  assert.equal(looksEmpty('<html><body><p>коротко</p></body></html>'), true);
  assert.equal(looksEmpty(`<html><body><h1>Есть</h1><p>${filler}</p></body></html>`), false);
});

/* Скрипты и стили из подсчёта текста выброшены: иначе страница с большим бандлом в разметке
   выглядит наполненной, хотя видимого текста на ней нет. */
test('текст скриптов не считается содержимым', () => {
  const withBundle = `<html><body><div id="app"></div><script>${'x'.repeat(5000)}</script></body></html>`;
  assert.equal(looksEmpty(withBundle), true);
});

/* windows-1251 на старых сайтах жив, и res.text() отдал бы кракозябры, по которым потом
   не находится ни title, ни h1 — страница уехала бы в браузер как якобы пустая. */
test('кодировка берётся из заголовка и из meta', () => {
  const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет» в windows-1251
  assert.equal(decodeBody(cyrillic, 'text/html; charset=windows-1251'), 'Привет');

  const withMeta = Buffer.concat([
    Buffer.from('<meta charset="windows-1251">', 'latin1'),
    cyrillic,
  ]);
  assert.match(decodeBody(withMeta, 'text/html'), /Привет$/);
});

test('неизвестная кодировка не роняет обход', () => {
  assert.equal(typeof decodeBody(Buffer.from('текст'), 'text/html; charset=нечто-странное'), 'string');
});

/*
 * User-Agent уходит в HTTP-заголовок, а его значение — ByteString: кириллица в нём роняет fetch
 * на первом же запросе, и падает весь обход, а не одна страница. Проверка дешёвая, а поломка
 * выглядит как «сайт недоступен» и уводит разбираться совсем не туда.
 */
test('User-Agent по умолчанию не содержит ничего вне ASCII', () => {
  assert.match(DEFAULTS.userAgent, /^[\x20-\x7e]+$/, `в UA есть символы вне ASCII: ${DEFAULTS.userAgent}`);
  assert.doesNotThrow(() => new Headers({ 'User-Agent': DEFAULTS.userAgent }));
});
