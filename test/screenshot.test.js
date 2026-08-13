/**
 * Съёмка и то, что ей мешает. Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Проверяются два «молчаливых» дефекта — когда инструмент рапортует успех, а кадр
 * неверный, — поэтому фикстуры отдаются по http: под file:// ни ленивая загрузка,
 * ни неудачные запросы не воспроизводятся.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

let pool;
let server;
let base;
let tmp;

/** Отдаёт фикстуры, генерирует картинки и честно 404-ит всё под /missing/. */
async function startServer() {
  const png = await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 40, g: 90, b: 140 } },
  })
    .png()
    .toBuffer();

  const srv = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (url.startsWith('/missing/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('нет такого');
      return;
    }
    if (url.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    try {
      const body = await fs.readFile(path.join(FIXTURES, path.basename(url)));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return srv;
}

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-shot-'));
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('ленивые картинки ниже сгиба догружаются до снимка', options, async () => {
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/lazy-images.html`);

    const res = await evaluateOnPage(
      session.page,
      '[...document.images].filter(i => i.naturalWidth === 0).length',
    );
    assert.equal(res.value, 0, 'ни одна картинка не должна остаться незагруженной');

    const count = await evaluateOnPage(session.page, 'document.images.length');
    assert.equal(count.value, 4, 'фикстура рассчитана на одну обычную и три ленивые картинки');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('навигация сообщает о неудачных запросах, а не рапортует чистый 200', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    const nav = await pool.gotoAndSettle(session, `${base}/broken-images.html`);

    assert.equal(nav.status, 200, 'сама страница отвечает нормально — в этом и подвох');
    assert.ok(nav.warnings, 'о битых картинках обязано быть сказано в ответе навигации');
    assert.equal(nav.warnings.failedRequests, 3);
    assert.equal(nav.warnings.brokenImages, 3);
    assert.ok(nav.warnings.firstFailures.length > 0);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('на чистой странице предупреждений нет', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    const nav = await pool.gotoAndSettle(session, `${base}/lazy-images.html`);
    assert.equal(nav.warnings, undefined, 'лишний шум обесценивает предупреждение');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('rewrite чинит абсолютные адреса на недостижимый домен', options, async () => {
  const { addRoute, listRoutes } = await import('../src/browser/routes.js');
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  // Так выглядит страница из базы, где медиа записано абсолютными ссылками боевого домена.
  const page = `<!doctype html><meta charset="utf-8">
    <img src="http://site-which-does-not-resolve.invalid/img/one.png">
    <img src="http://site-which-does-not-resolve.invalid/img/two.png">`;

  try {
    await session.page.route('**/page.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page }),
    );

    const before = await pool.gotoAndSettle(session, `${base}/page.html`);
    assert.equal(before.warnings.brokenImages, 2, 'сначала картинки не доезжают');

    await addRoute(session, {
      pattern: '**/*.png',
      handler: 'rewrite',
      from: '/^http:\\/\\/site-which-does-not-resolve\\.invalid/',
      to: base,
    });

    const after = await pool.gotoAndSettle(session, `${base}/page.html`);
    assert.equal(after.warnings, undefined, 'после правила картинки должны доехать');

    const broken = await evaluateOnPage(
      session.page,
      '[...document.images].filter(i => i.naturalWidth === 0).length',
    );
    assert.equal(broken.value, 0);

    const rule = listRoutes(session)[0];
    assert.ok(rule.hits > 0, 'счётчик попаданий обязан расти');
    assert.equal(rule.rewrites, 2, 'замен должно быть ровно по числу картинок');
    assert.match(rule.lastRewrite.to, new RegExp(`^${base}/img/`), 'путь должен сохраниться');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('screenshot умеет webp и уменьшение по ширине', options, async () => {
  const { takeScreenshot } = await import('../src/checks/visual.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/lazy-images.html`);

    const shot = await takeScreenshot(session.page, {
      runId: 'test-format',
      name: 'webp-shot',
      fullPage: true,
      format: 'webp',
      quality: 70,
      maxWidth: 320,
    });

    assert.equal(shot.width, 320);
    assert.equal(shot.format, 'webp');
    assert.match(shot.path, /\.webp$/, 'расширение файла должно соответствовать формату');

    const head = await fs.readFile(shot.path);
    assert.equal(head.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(head.subarray(8, 12).toString('ascii'), 'WEBP');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('isolate убирает соседей из потока и возвращает страницу как было', options, async () => {
  const { takeScreenshot } = await import('../src/checks/visual.js');
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/lazy-images.html`);

    const whole = await takeScreenshot(session.page, {
      runId: 'test-isolate',
      name: 'body-whole',
      selector: 'body',
    });
    const isolated = await takeScreenshot(session.page, {
      runId: 'test-isolate',
      name: 'body-isolated',
      selector: 'body',
      isolate: ['figure:first-of-type'],
    });

    assert.ok(
      isolated.height < whole.height / 2,
      `распорки должны уйти из потока: было ${whole.height}, стало ${isolated.height}`,
    );

    const leftovers = await evaluateOnPage(session.page, 'document.querySelectorAll("[data-lt-isolate]").length');
    assert.equal(leftovers.value, 0, 'после снимка разметку надо вернуть в исходное состояние');

    const styles = await evaluateOnPage(session.page, 'document.querySelectorAll("style[data-lt-isolate-style]").length');
    assert.equal(styles.value, 0, 'служебный стиль тоже должен сниматься');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('isolate с ненайденным селектором падает внятно, а не отдаёт пустой кадр', options, async () => {
  const { takeScreenshot } = await import('../src/checks/visual.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/lazy-images.html`);
    await assert.rejects(
      () =>
        takeScreenshot(session.page, {
          runId: 'test-isolate-miss',
          name: 'miss',
          selector: 'body',
          isolate: ['.нет-такого'],
        }),
      /ни один из селекторов не найден/,
    );
  } finally {
    await pool.closeSession(session.id);
  }
});

test('снимок по селектору берёт видимое совпадение, а не первое в DOM', options, async () => {
  const { takeScreenshot } = await import('../src/checks/visual.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  // Скрытый шаблон перед настоящим блоком — обычное дело на страницах с модалками.
  const page = `<!doctype html><meta charset="utf-8">
    <section id="hidden" style="display:none"><p>шаблон</p></section>
    <section id="shown" style="width:200px;height:120px;background:#d6e4ff">видимый</section>`;

  try {
    await session.page.route('**/two-sections.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page }),
    );
    await pool.gotoAndSettle(session, `${base}/two-sections.html`);

    const shot = await takeScreenshot(session.page, {
      runId: 'test-visible-pick',
      name: 'pick',
      selector: 'section',
    });

    // Кадр обязан быть с видимого блока: 200×120, а не пустой и не по таймауту.
    assert.equal(shot.width, 200);
    assert.equal(shot.height, 120);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('снимок по селектору без единого видимого совпадения падает сразу и внятно', options, async () => {
  const { takeScreenshot } = await import('../src/checks/visual.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  const page = `<!doctype html><meta charset="utf-8">
    <section style="display:none">раз</section><section style="display:none">два</section>`;

  try {
    await session.page.route('**/all-hidden.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page }),
    );
    await pool.gotoAndSettle(session, `${base}/all-hidden.html`);

    const started = Date.now();
    await assert.rejects(
      () => takeScreenshot(session.page, { runId: 'test-none-visible', name: 'none', selector: 'section' }),
      /совпадений 2, видимых нет/,
    );
    // Суть правки — не ждать таймаута локатора: ответ должен прийти сразу.
    assert.ok(Date.now() - started < 5000, 'ждать тут нечего, число видимых известно сразу');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('layout_audit не раздувается на странице с инлайн-картинками', options, async () => {
  const { layoutAudit } = await import('../src/checks/layout.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    // Тридцать картинок с приличными data:-URI — ровно тот случай, на котором
    // ответ переставал помещаться в лимит.
    const png = (await sharp({ create: { width: 300, height: 200, channels: 3, background: '#c86' } })
      .png()
      .toBuffer()).toString('base64');
    const imgs = Array.from({ length: 30 }, () => `<img src="data:image/png;base64,${png}">`).join('');
    await session.page.setContent(`<!doctype html><meta charset="utf-8"><body>${imgs}</body>`);

    const audit = await layoutAudit(session.page, { maxItems: 5 });

    assert.equal(audit.counts.imagesWithoutDimensions, 5, 'категория должна подчиняться maxItems');
    for (const item of audit.issues.imagesWithoutDimensions) {
      assert.ok(item.src.length < 80, `адрес не обрезан: ${item.src.slice(0, 80)}`);
      assert.match(item.src, /^data:image\/png;base64,…\(\d+ КБ\)$/);
    }

    const size = JSON.stringify(audit).length;
    assert.ok(size < 100_000, `ответ всё ещё великоват: ${size} байт`);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('layout_audit по categories отдаёт подробности только по запрошенному', options, async () => {
  const { layoutAudit } = await import('../src/checks/layout.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/broken-images.html`);
    const audit = await layoutAudit(session.page, { categories: ['brokenImages'] });

    assert.deepEqual(Object.keys(audit.issues), ['brokenImages']);
    assert.ok(audit.counts.imagesWithoutDimensions !== undefined, 'счётчики остаются по всем категориям');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('visual_guide собирает самодостаточный документ', options, async () => {
  const { buildVisualGuide } = await import('../src/checks/guide.js');

  const result = await buildVisualGuide({
    url: `${base}/lazy-images.html`,
    title: 'Проба справочника',
    profiles: ['desktop', 'mobile'],
    items: [
      { selector: 'figure:nth-of-type(1)', title: 'Первый блок', params: { Расположение: 'Обычное' } },
      { selector: 'figure:nth-of-type(2)', title: 'Второй блок', note: 'с примечанием' },
    ],
    image: { format: 'webp', maxWidth: 400 },
  });

  assert.equal(result.items, 2);
  assert.equal(result.shots, 4, 'два варианта на две ширины');
  assert.equal(result.missing, undefined);

  const html = await fs.readFile(result.path, 'utf8');
  const external = html.match(/src="(?!data:)[^"]*"/g);
  assert.equal(external, null, `документ должен быть самодостаточным, а ссылается наружу: ${external}`);
  assert.match(html, /Первый блок/);
  assert.match(html, /Расположение/);
  assert.match(html, /с примечанием/);
});

test('visual_guide не падает целиком из-за одного плохого селектора', options, async () => {
  const { buildVisualGuide } = await import('../src/checks/guide.js');

  const result = await buildVisualGuide({
    url: `${base}/lazy-images.html`,
    title: 'Справочник с дыркой',
    profiles: ['desktop'],
    items: [
      { selector: 'figure:nth-of-type(1)', title: 'Есть' },
      { selector: '.такого-нет', title: 'Нет' },
    ],
  });

  assert.equal(result.shots, 1);
  assert.equal(result.missing, 1);
  assert.ok(result.warnings.length > 0, 'о пропущенном варианте надо сказать явно');
});
