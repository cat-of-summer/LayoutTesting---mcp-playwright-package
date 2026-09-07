/**
 * Зеркало целиком: сохранить страницу и открыть её без сети.
 *
 * Модульные тесты переписывания проверяют разметку, но разметка может быть безупречной, а копия
 * при этом не открываться: путь на два уровня вверх посчитан неверно, CSS уложен до переписывания,
 * расширение файла не то и nginx отдаёт стили как текст. Всё это видно только если действительно
 * открыть сохранённое.
 *
 * Поэтому здесь поднимается настоящий сервер, страница снимается, а потом открывается с диска при
 * наглухо перекрытой сети. Если хоть один ресурс на самом деле не сохранился, фон останется белым.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIRS } from '../src/config.js';
import { savePage, siteDirOf } from '../src/mirror/save.js';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const SITE_ID = 'lt-mirror-e2e';

/* Однопиксельный PNG: настоящая картинка нужна, чтобы проверить укладку бинарного ресурса. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PAGE = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Страница для зеркала</title>
  <link rel="stylesheet" href="/assets/style.css">
  <script src="/assets/app.js"></script>
</head>
<body>
  <h1>Заголовок</h1>
  <img id="shot" src="/assets/dot.png" width="1" height="1" alt="точка">
  <a href="/other">Соседняя страница</a>
</body>
</html>`;

/* url() внутри CSS проверяет самое хрупкое место: путь считается от каталога самого файла
   стилей, а он лежит на два уровня глубже страницы. */
const CSS = `@import "/assets/base.css";
body { background: rgb(1, 2, 3); }
h1 { background-image: url("/assets/dot.png"); }`;

const BASE_CSS = 'h1 { color: rgb(4, 5, 6); }';

function serve() {
  const routes = {
    '/': { type: 'text/html; charset=utf-8', body: PAGE },
    '/assets/style.css': { type: 'text/css', body: CSS },
    '/assets/base.css': { type: 'text/css', body: BASE_CSS },
    '/assets/dot.png': { type: 'image/png', body: PNG },
    '/assets/app.js': { type: 'application/javascript', body: 'window.__ranOnline = true;' },
  };
  const server = http.createServer((req, res) => {
    const hit = routes[req.url.split('?')[0]];
    if (!hit) {
      res.writeHead(404).end('нет');
      return;
    }
    res.writeHead(200, { 'Content-Type': hit.type });
    res.end(hit.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('сохранённая страница открывается без сети и сохраняет оформление', options, async (t) => {
  const { createSession, closeSession, gotoAndSettle, closeAll } = await import('../src/browser/pool.js');

  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await fs.rm(siteDirOf(SITE_ID), { recursive: true, force: true });
    await closeAll();
  });

  // ---------- снимаем ----------
  const session = await createSession({ browser: 'chromium' });
  let saved;
  try {
    await gotoAndSettle(session, `http://127.0.0.1:${port}/`);
    saved = await savePage(session, { siteId: SITE_ID });
  } finally {
    await closeSession(session.id);
  }

  assert.equal(saved.siteId, SITE_ID);
  assert.equal(saved.assets.failed, 0, 'часть ресурсов не скачалась');
  /*
   * Ровно три: style.css, подключённый из него через @import base.css и dot.png. Скрипт не
   * тянется, потому что scripts по умолчанию strip. Точное число, а не «хотя бы столько»:
   * dot.png упомянут дважды — в img и в url() внутри CSS, — и лишняя единица здесь означала бы,
   * что кэш по адресу не сработал и обход ходит за одним файлом по два раза.
   */
  assert.equal(saved.assets.fetched, 3, `скачано ${saved.assets.fetched} вместо трёх`);

  const pageHtml = await fs.readFile(saved.files.page, 'utf8');
  assert.match(pageHtml, /\.\.\/\.\.\/assets\//, 'ссылки не переписаны на локальные');
  assert.ok(!pageHtml.includes(`127.0.0.1:${port}/assets`), 'в копии остались адреса исходного сервера');
  assert.match(pageHtml, /Локальная копия http:\/\/127\.0\.0\.1/, 'нет паспорта копии');

  /* Сырой ответ обязан остаться нетронутым: по нему валидирует vnu и по нему видно,
     что отдаёт сервер роботу без скриптов. */
  const rawHtml = await fs.readFile(saved.files.raw, 'utf8');
  assert.match(rawHtml, /href="\/assets\/style\.css"/, 'сырой ответ оказался переписан');

  // ---------- открываем без сети ----------
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();

    const leaked = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (/^https?:/i.test(url)) {
        leaked.push(url);
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(pathToFileURL(saved.files.page).href, { waitUntil: 'load' });

    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(body, 'rgb(1, 2, 3)', 'таблица стилей не подхватилась из зеркала');

    const heading = await page.evaluate(() => getComputedStyle(document.querySelector('h1')).color);
    assert.equal(heading, 'rgb(4, 5, 6)', '@import внутри сохранённого CSS не переписан');

    const image = await page.evaluate(() => {
      const img = document.getElementById('shot');
      return { complete: img.complete, width: img.naturalWidth };
    });
    assert.equal(image.width, 1, 'картинка не загрузилась из зеркала');

    /* Скрипты вырезаны по умолчанию: на копии аналитика стучала бы в сеть, а роутер SPA
       подменял бы страницу. */
    const ranOnline = await page.evaluate(() => Boolean(window.__ranOnline));
    assert.equal(ranOnline, false, 'скрипт исходной страницы остался в копии');

    assert.deepEqual(leaked, [], `копия ходила в сеть: ${leaked.join(', ')}`);
  } finally {
    await browser.close();
  }
});

test('ссылки на несохранённые страницы остаются рабочими адресами', options, async (t) => {
  const { createSession, closeSession, gotoAndSettle, closeAll } = await import('../src/browser/pool.js');

  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await fs.rm(siteDirOf(SITE_ID), { recursive: true, force: true });
    await closeAll();
  });

  const session = await createSession({ browser: 'chromium' });
  let saved;
  try {
    await gotoAndSettle(session, `http://127.0.0.1:${port}/`);
    saved = await savePage(session, { siteId: SITE_ID, assets: false, raw: false });
  } finally {
    await closeSession(session.id);
  }

  const html = await fs.readFile(saved.files.page, 'utf8');
  /* /other в архив не попадала. Сломать ссылку хуже, чем оставить её ведущей наружу:
     по ней хотя бы видно, куда она вела. */
  assert.match(html, new RegExp(`href="http://127\\.0\\.0\\.1:${port}/other"`));
});

test('каталог сайта лежит в sites/, а не в артефактах с их автоочисткой', () => {
  assert.equal(siteDirOf(SITE_ID), path.join(DIRS.sites, SITE_ID));
  assert.ok(!siteDirOf(SITE_ID).startsWith(DIRS.artifacts));
});

/*
 * Якорь и mailto: остаются как есть. Нормализация превратила бы #section в полный адрес
 * страницы, а это уже другая ссылка — по ней браузер перезагрузит документ вместо прокрутки.
 */
test('якоря и не-http схемы переписыванием не трогаются', options, async (t) => {
  const { createSession, closeSession, gotoAndSettle, closeAll } = await import('../src/browser/pool.js');

  const server = await serve();
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await fs.rm(siteDirOf(SITE_ID), { recursive: true, force: true });
    await closeAll();
  });

  const session = await createSession({ browser: 'chromium' });
  let saved;
  try {
    await gotoAndSettle(session, `http://127.0.0.1:${port}/anchors`);
    await session.page.setContent(
      '<a id="a" href="#section">якорь</a><a id="b" href="mailto:x@example.test">почта</a>',
    );
    saved = await savePage(session, { siteId: SITE_ID, assets: false, raw: false });
  } finally {
    await closeSession(session.id);
  }

  const html = await fs.readFile(saved.files.page, 'utf8');
  assert.match(html, /href="#section"/, 'якорь превратился в полный адрес');
  assert.match(html, /href="mailto:x@example\.test"/, 'mailto: не должен переписываться');
});
