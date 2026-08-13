/**
 * Работа с визуальным содержимым: заглушки вместо не доехавшего, маска, снимки.
 * Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Всё это — «молчаливые» дефекты: инструмент рапортует успех, а кадр неверен. Поэтому
 * проверяем не только что стало лучше, но и что о подмене сказано вслух и что рабочее
 * содержимое подменой не задето.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

let pool;
let evaluateOnPage;
let takeScreenshot;
let server;
let base;

async function startServer() {
  const png = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 30, g: 120, b: 60 } },
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

/** Геометрия и происхождение заглушки по каждому подопытному узлу. */
const probe = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      placeholder: 'ltPlaceholder' in el.dataset,
      src: (el.currentSrc || el.src || '').slice(0, 30),
      poster: (el.poster || '').slice(0, 30),
    };
  };
  return {
    attrs: box('#attrs img'),
    css: box('#css img'),
    naked: box('#naked img'),
    video: box('#video video'),
    ok: box('#ok img'),
    afterTop: Math.round(document.querySelector('.after').getBoundingClientRect().top),
  };
})()`;

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ evaluateOnPage } = await import('../src/browser/evaluate.js'));
  ({ takeScreenshot } = await import('../src/checks/visual.js'));
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('битой картинке возвращается заявленный размер из атрибутов', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`);
    const { value } = await evaluateOnPage(session.page, probe);

    assert.equal(value.attrs.placeholder, true, 'коробка подменена');
    assert.equal(value.attrs.w, 400, 'ширина взята из атрибута, а не из квадрата');
    assert.equal(value.attrs.h, 300, 'высота из атрибута');
    assert.match(value.attrs.src, /^data:image\/svg\+xml/, 'подставлена сгенерированная заглушка');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('размеры из стилей уважаются, а не перебиваются квадратом', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`);
    const { value } = await evaluateOnPage(session.page, probe);

    assert.equal(value.css.placeholder, true);
    assert.equal(value.css.w, 320, 'ширина из CSS');
    assert.equal(value.css.h, 240, 'высота из CSS, а не 1:1 от квадрата заглушки');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('когда размер не известен ниоткуда, ставится запасной квадрат', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`);
    const { value } = await evaluateOnPage(session.page, probe);

    assert.equal(value.naked.placeholder, true);
    assert.equal(value.naked.w, value.naked.h, 'ничем не стеснённая заглушка остаётся квадратной');
    assert.equal(value.naked.w, 1000, 'размер квадрата по умолчанию');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('видео без источника получает заглушку постером', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`);
    const { value } = await evaluateOnPage(session.page, probe);

    assert.equal(value.video.placeholder, true);
    assert.match(value.video.poster, /^data:image\/svg\+xml/);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('рабочая картинка остаётся нетронутой', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`);
    const { value } = await evaluateOnPage(session.page, probe);

    assert.equal(value.ok.placeholder, false, 'подменять то, что загрузилось, нельзя');
    assert.match(value.ok.src, /\/img\//, 'адрес рабочей картинки сохранён');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('о подмене сказано в ответе навигации, а не сделано молча', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });
  try {
    const nav = await pool.gotoAndSettle(session, `${base}/broken-media.html`);

    assert.ok(nav.warnings, 'страница с битым содержимым не должна выглядеть чистой');
    assert.ok(nav.warnings.placeholders, 'факт подмены обязан быть в ответе');
    assert.equal(nav.warnings.placeholders.images, 3);
    assert.equal(nav.warnings.placeholders.videos, 1);
    assert.equal(nav.warnings.placeholders.total, 4);
    // Битые картинки как были находкой, так и остаются: подмена не отменяет диагноз.
    assert.ok(nav.warnings.brokenImages > 0, 'исходная проблема должна остаться видна');
  } finally {
    await pool.closeSession(session.id);
  }
});

test('заглушки удерживают вёрстку: блок под картинками не уезжает вверх', options, async () => {
  const withStub = await pool.createSession({ viewport: 'desktop' });
  const without = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(withStub, `${base}/broken-media.html`);
    const a = await evaluateOnPage(withStub.page, probe);

    // Та же страница без стабилизации — как её видит браузер без нашей помощи.
    await pool.gotoAndSettle(without, `${base}/broken-media.html`, { stabilizePage: false });
    const b = await evaluateOnPage(without.page, probe);

    assert.ok(
      a.value.afterTop > b.value.afterTop,
      `с заглушками блок ниже (${a.value.afterTop}) чем без них (${b.value.afterTop}) — ` +
        'иначе схлопнутые коробки продолжают тянуть вёрстку вверх',
    );
  } finally {
    await pool.closeSession(withStub.id);
    await pool.closeSession(without.id);
  }
});

test('layout_audit продолжает считать битые картинки, несмотря на заглушки', options, async () => {
  const { layoutAudit } = await import('../src/checks/layout.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`);
    const res = await layoutAudit(session.page, { categories: ['brokenImages'] });

    // Заглушка — приём для сравнения, а не способ спрятать проблему от отчёта.
    // После подмены картинка грузится, и отличить её можно только по метке.
    assert.equal(res.counts.brokenImages, 3, 'все три битые картинки обязаны остаться находкой');
    assert.ok(
      res.issues.brokenImages.every((i) => i.placeholder === true),
      'у подменённых находок должна быть пометка о подмене',
    );
  } finally {
    await pool.closeSession(session.id);
  }
});

test('заглушку можно отключить, если нужен кадр «как есть»', options, async () => {
  const { stabilize } = await import('../src/browser/stabilize.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`, { stabilizePage: false });
    const res = await stabilize(session.page, { placeholders: false });
    const { value } = await evaluateOnPage(session.page, probe);

    assert.equal(res.stubbed, null, 'при выключенной подмене её не должно быть вовсе');
    assert.equal(value.attrs.placeholder, false);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('снимок по селектору с маской отдаёт кадр заявленного размера', options, async () => {
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/broken-media.html`);
    const shot = await takeScreenshot(session.page, {
      runId: 'test-media-mask',
      name: 'masked',
      selector: '#attrs',
      mask: ['img'],
    });

    // Коробка восстановлена заглушкой, значит и кадр блока имеет осмысленный размер.
    assert.ok(shot.height > 300, `ожидали кадр выше 300px, получили ${shot.height}`);
  } finally {
    await pool.closeSession(session.id);
  }
});
