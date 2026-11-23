/**
 * Замечания приёмки ТОПГАН на настоящем браузере: перекрытая кнопка против reveal, блок поверх
 * шапки, рваный ряд кнопок, посадка текста, начальное состояние шапки, качество переходов,
 * hover на таче и поле, стирающее ввод.
 *
 *   LT_BROWSER_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.LT_UPDATE_CHECK = '0';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const head = '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px/1.4 sans-serif}</style>';
const PAGES = {
  '/covered.html': `${head}
    <div style="height:1200px"></div>
    <div style="position:relative;width:300px;height:80px">
      <button id="under" style="width:200px;height:60px">Купить</button>
      <div id="ring" style="position:absolute;inset:0"></div>
    </div>
    <div style="height:1200px"></div>`,
  '/reveal.html': `${head}
    <style>.veil{position:absolute;inset:0;background:#fff;transition:opacity .25s}.done .veil{opacity:0;pointer-events:none}</style>
    <div style="height:1200px"></div>
    <section id="s" style="position:relative;width:300px;height:80px">
      <button id="ok" style="width:200px;height:60px">Купить</button><div class="veil"></div>
    </section>
    <div style="height:1200px"></div>
    <script>new IntersectionObserver((e)=>{if(e[0].isIntersecting)document.getElementById('s').classList.add('done')}).observe(document.getElementById('s'))</script>`,
  '/header.html': `${head}
    <header id="top" style="position:fixed;top:0;left:0;right:0;height:60px;background:#222;z-index:10"></header>
    <div style="height:900px"></div>
    <div id="card" style="position:relative;z-index:20;height:300px;background:#f00"></div>
    <div style="height:1500px"></div>`,
  '/row.html': `${head}
    <style>.cards{display:flex;gap:16px;width:640px}.card{width:200px;border:1px solid #333}.btn{display:block}</style>
    <div class="cards">
      <div class="card"><p>Короткий</p><a class="btn" href="#a">Подробнее</a></div>
      <div class="card"><p>Длинный текст карточки, который занимает несколько строк подряд и толкает кнопку вниз</p><a class="btn" href="#b">Подробнее</a></div>
      <div class="card"><p>Короткий</p><a class="btn" href="#c">Подробнее</a></div>
    </div>`,
  '/glyph.html': `${head}
    <button id="off" style="display:block;height:40px;width:160px;padding:0 0 14px;border:0;background:#222;color:#fff;font-size:20px;line-height:26px">ЗАПИСЬ</button>`,
  '/initial.html': `${head}
    <header id="h" class="site is-solid" style="position:fixed;top:0;left:0;right:0;height:60px"></header>
    <div style="height:3000px"></div>
    <script>addEventListener('scroll',()=>{document.getElementById('h').classList.toggle('is-solid',scrollY>10)})</script>`,
  '/tabs.html': `${head}
    <style>.p{transition:opacity .4s}.p[hidden]{display:block;opacity:0;height:0;overflow:hidden}</style>
    <div role="tablist"><button id="t1" role="tab" aria-selected="true" aria-controls="p1">1</button>
    <button id="t2" role="tab" aria-selected="false" aria-controls="p2">2</button></div>
    <div id="p1" class="p" role="tabpanel">Первая панель</div><div id="p2" class="p" role="tabpanel" hidden>Вторая панель</div>
    <script>t2.onclick=()=>{t2.setAttribute('aria-selected','true');t1.setAttribute('aria-selected','false');p2.hidden=false;p2.style.opacity=1;setTimeout(()=>{p1.hidden=true},300)}</script>`,
  '/touch.html': `${head}
    <style>.tile{display:block;width:200px;height:100px;background:#ddd}.tile .more{opacity:0}.tile:hover .more{opacity:1}.solid{display:block;width:200px;height:100px;background:#bbb}@media (hover:hover){.solid:hover .x{opacity:1}}.solid .x{opacity:0}</style>
    <a class="tile" href="#go"><span class="more">Подробнее</span></a>
    <div class="solid"><span class="x">Скрыто</span></div>`,
  '/form.html': `${head}
    <form onsubmit="return false"><input id="q" name="q" required>
    <button>Найти</button></form>
    <script>q.addEventListener('blur',()=>{q.value=''})</script>`,
  '/motion.html': `${head}
    <style>#m{position:relative;width:400px;height:200px}#t{position:absolute;top:60px;opacity:0;transition:top .5s linear,opacity .5s linear}#m.on #t{top:0;opacity:1}#j{position:absolute;top:100px}</style>
    <div id="m"><p id="t" style="margin:0">Первый абзац</p><p id="j" style="margin:0">Рывок</p></div><button id="go">Пуск</button>
    <script>go.onclick=()=>{m.classList.add('on');const s=performance.now();const f=()=>{const k=Math.min(1,(performance.now()-s)/500);j.style.top=(100-100*k)+'px';if(k<1)requestAnimationFrame(f)};requestAnimationFrame(f)}</script>`,
  '/round.html': `${head}
    <div style="position:relative;width:300px;height:200px;margin:40px">
      <div id="decor" style="position:absolute;inset:0;background:#eee"></div>
      <button id="free" style="position:absolute;left:20px;top:20px;width:48px;height:48px;border-radius:50%;border:0;background:#000"></button>
      <button id="pill" style="position:absolute;left:90px;top:20px;width:160px;height:40px;border-radius:999px;border:0;background:#000"></button>
      <button id="buried" style="position:absolute;left:20px;top:100px;width:48px;height:48px;border-radius:50%;border:0;background:#000"></button>
      <div id="lid" style="position:absolute;left:14px;top:94px;width:60px;height:60px"></div>
    </div>
    <button id="float" style="position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;background:#000;z-index:5"></button>
    <div style="height:2000px;background:#ddd"></div>`,
  '/trim.html': `${head}
    <style>.b{display:flex;align-items:center;justify-content:center;width:220px;height:48px;padding:0;border:0;margin:8px;background:#000;color:#fff;font:700 24px/1 Arial}.t{display:block;text-box:trim-both cap alphabetic}</style>
    <button id="lower" class="b"><span class="t">запись</span></button>
    <button id="upper" class="b"><span class="t">ЗАПИСЬ</span></button>
    <button id="plain" class="b">запись</button>
    <button id="ex" class="b"><span style="display:block;text-box:trim-both ex alphabetic">запись</span></button>
    <button id="shifted" class="b" style="padding-bottom:10px"><span class="t">запись</span></button>`,
  '/scene.html': `${head}
    <div style="height:1600px"></div><section id="s" style="height:300px"></section>
    <img id="lazy" loading="lazy" width="10" height="10" src="/pixel.svg"><div style="height:600px"></div>
    <script>window.started=0;window.maxY=0;addEventListener('scroll',()=>{maxY=Math.max(maxY,scrollY)});new IntersectionObserver((e)=>{if(e[0].isIntersecting)started+=1}).observe(document.getElementById('s'))</script>`,
  '/pixel.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  '/warn.html': `${head}<p>Текст</p><script>console.warn('Swiper Loop Warning: The number of slides is not enough for loop mode')</script>`,
};

let pool;
let server;
let base;
let settled;
let ready;
let interaction;
let forms;
let capture;
let motion;

async function withPage(page, run, profile = { viewport: '1280x800', animations: 'allow' }) {
  const session = await pool.createSession(profile);
  try {
    await session.page.goto(`${base}${page}`);
    return await run(session);
  } finally {
    await pool.closeSession(session.id);
  }
}

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  settled = await import('../src/checks/settled.js');
  ready = await import('../src/checks/ready.js');
  interaction = await import('../src/checks/interaction.js');
  forms = await import('../src/checks/forms.js');
  capture = await import('../src/figma/motion-capture.js');
  motion = await import('../src/figma/motion.js');
  server = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404, { 'Content-Type': req.url.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' });
    res.end(body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  await new Promise((resolve) => server.close(resolve));
  await pool.closeAll?.();
});

test('кнопка под чужим слоем находится, с селектором того, кто сверху', options, async () => {
  const report = await withPage('/covered.html', (session) => settled.auditSettled(session.page));
  const hit = report.controlsCovered.find((item) => item.selector === '#under');
  assert.ok(hit, JSON.stringify(report.controlsCovered));
  assert.equal(hit.by, '#ring');
  assert.equal(hit.covered, 'center');
});

test('reveal, который убирает слой при прокрутке, ложной находки не даёт', options, async () => {
  const report = await withPage('/reveal.html', (session) => settled.auditSettled(session.page));
  assert.deepEqual(report.controlsCovered, []);
});

test('блок поверх fixed-шапки: кто и на какой прокрутке', options, async () => {
  const report = await withPage('/header.html', (session) => settled.auditSettled(session.page));
  const hit = report.overPinned.find((item) => item.selector === '#card');
  assert.ok(hit, JSON.stringify(report.overPinned));
  assert.equal(hit.pinned, '#top');
  assert.ok(hit.scrollY > 0);
});

test('кнопки в ряду карточек не на одной линии', options, async () => {
  const report = await withPage('/row.html', (session) => settled.auditSettled(session.page));
  assert.equal(report.rowChildren.length, 1, JSON.stringify(report.rowChildren));
  assert.equal(report.rowChildren[0].element, 'a.btn');
  assert.ok(report.rowChildren[0].spread > 20);
  assert.equal(report.rowChildren[0].outliers.length, 1);
});

test('текст выше центра контрола виден по чернилам', options, async () => {
  const report = await withPage('/glyph.html', (session) => settled.auditSettled(session.page));
  const hit = report.glyphOffset.find((item) => item.selector === '#off');
  assert.ok(hit, JSON.stringify(report.glyphOffset));
  assert.ok(hit.offset < -1);
});

test('шапка после загрузки не совпадает с шапкой после возврата наверх', options, async () => {
  const drift = await withPage('/initial.html', (session) => settled.initialStateDrift(session.page));
  assert.equal(drift.length, 1, JSON.stringify(drift));
  assert.deepEqual(drift[0].onlyAtLoad, ['is-solid']);
});

test('переключение табов: две панели на экране за время перехода', options, async () => {
  const result = await withPage('/tabs.html', (session) => interaction.runInteractions(session.page, { selectors: ['#t2'], actions: ['click'], timeoutMs: 1000 }));
  assert.ok(result.transitionIssues?.some((item) => item.kind === 'twoPanels'), JSON.stringify(result.transitionIssues));
});

test('hover на таче: ссылка уходит с первого тапа, блок не показывает состояние', options, async () => {
  const found = await withPage('/touch.html', (session) => interaction.auditTouchHover(session.page), { viewport: '390x800', touch: true, animations: 'allow' });
  assert.ok(found.some((item) => item.kind === 'navigatesAtOnce' && item.selector.includes('tile')), JSON.stringify(found));
  assert.ok(found.some((item) => item.kind === 'noTouchState' && item.selector.includes('solid')), JSON.stringify(found));
});

test('поле, стирающее введённое значение, - находка form_audit', options, async () => {
  const result = await withPage('/form.html', (session) => forms.auditForms(session, { submit: 'none' }));
  assert.ok(result.forms[0].issues.some((item) => item.kind === 'valueLost' && item.selector.includes('q')), JSON.stringify(result.forms[0].issues));
});

test('page_ready: перекрытая кнопка - блокер, поштучное списание его снимает', options, async () => {
  const check = (args) => withPage('/covered.html', (session) => ready.pageReady(session, { url: `${base}/covered.html`, run: 'all', widths: [1280], ...args }));
  const first = await check();
  const blocker = first.blockers.find((item) => item.check === 'settled' && item.selector === '#under');
  assert.ok(blocker, JSON.stringify(first.blockers));
  assert.equal(blocker.next.tool, 'element_layers');

  const second = await check({
    waivers: [
      { check: 'controlsCovered', selector: '#under', reason: 'кольцо задумано поверх кнопки' },
      { check: 'controlsCovered', selector: '#nope', reason: 'такого элемента нет' },
    ],
  });
  assert.ok(!second.blockers?.some((item) => item.selector === '#under'), JSON.stringify(second.blockers));
  assert.ok(second.waived.some((item) => item.selector === '#under'));
  assert.deepEqual(second.unusedWaivers, [{ check: 'controlsCovered', selector: '#nope' }]);
});

test('круглая кнопка: фон в углах рамки - не перекрытие, настоящая крышка находится', options, async () => {
  const report = await withPage('/round.html', (session) => settled.auditSettled(session.page));
  const covered = report.controlsCovered.map((item) => item.selector);
  assert.ok(!covered.includes('#free'), JSON.stringify(report.controlsCovered));
  assert.ok(!covered.includes('#pill'), JSON.stringify(report.controlsCovered));
  assert.ok(covered.includes('#buried'), JSON.stringify(report.controlsCovered));
  assert.equal(report.controlsCovered.find((item) => item.selector === '#buried').by, '#lid');
});

test('круглая закреплённая кнопка: страница за её углами не лежит поверх неё', options, async () => {
  const report = await withPage('/round.html', (session) => settled.auditSettled(session.page));
  assert.deepEqual(report.overPinned.filter((item) => item.pinned === '#float'), []);
});

test('посадка текста: text-box-trim и строчные не считаются сдвигом, настоящий сдвиг виден', options, async () => {
  const report = await withPage('/trim.html', (session) => settled.auditSettled(session.page));
  const found = report.glyphOffset.map((item) => item.selector);
  for (const id of ['#lower', '#upper', '#plain', '#ex']) assert.ok(!found.includes(id), `${id}: ${JSON.stringify(report.glyphOffset)}`);
  const shifted = report.glyphOffset.find((item) => item.selector === '#shifted');
  assert.ok(shifted && shifted.offset < -1, JSON.stringify(report.glyphOffset));
  assert.match(shifted.trim, /trim-both cap alphabetic/);
});

test('живая сессия: переход не прокручивает страницу и не запускает сцены, картинки грузятся', options, async () => {
  const session = await pool.createSession({ viewport: '800x600', animations: 'allow' });
  try {
    const navigation = await pool.gotoAndSettle(session, `${base}/scene.html`);
    const state = await session.page.evaluate(() => ({ started: window.started, maxY: window.maxY, y: scrollY, image: document.getElementById('lazy').naturalWidth }));
    assert.deepEqual(state, { started: 0, maxY: 0, y: 0, image: 10 });
    assert.match(navigation.scrollNote, /не прокручивалась/);
  } finally {
    await pool.closeSession(session.id);
  }
});

test('замороженная сессия и page_ready по-прежнему проявляют страницу целиком', options, async () => {
  const frozen = await pool.createSession({ viewport: '800x600' });
  try {
    const navigation = await pool.gotoAndSettle(frozen, `${base}/scene.html`);
    assert.ok((await frozen.page.evaluate(() => window.maxY)) > 0);
    assert.equal(navigation.scrollNote, undefined);
  } finally {
    await pool.closeSession(frozen.id);
  }
  const live = await pool.createSession({ viewport: '800x600', animations: 'allow' });
  try {
    await ready.pageReady(live, { url: `${base}/scene.html`, run: 'all', widths: [800] });
    assert.equal(live.revealOnGoto, true);
    await pool.gotoAndSettle(live, `${base}/scene.html`);
    assert.ok((await live.page.evaluate(() => window.maxY)) > 0);
  } finally {
    await pool.closeSession(live.id);
  }
});

test('screenshot в живой сессии: видимая область без прокрутки, целиком только по просьбе', options, async () => {
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = await createServer();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'live-shot', version: '1' });
  await client.connect(clientSide);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const body = res.content.find((item) => item.type === 'text')?.text ?? '';
    if (res.isError) throw new Error(`${name}: ${body}`);
    return JSON.parse(body);
  };
  const url = `${base}/scene.html`;
  const scrolled = (sessionId) => pool.getSession(sessionId).page.evaluate(() => ({ started: window.started, maxY: window.maxY }));

  const { sessionId: live } = await call('browser_open', { viewport: '800x600', animations: 'allow', url });
  try {
    const shot = await call('screenshot', { sessionId: live });
    assert.equal(shot.height, 600);
    assert.match(shot.scrollNote, /видимая область/);

    const below = await call('screenshot', { sessionId: live, clip: { x: 0, y: 1500, width: 200, height: 200 } });
    assert.match(below.scrollNote, /без прокрутки/);

    await call('browser_act', { sessionId: live, steps: [{ action: 'screenshot', clip: { x: 0, y: 1500, width: 200, height: 200 } }] });
    assert.equal((await scrolled(live)).maxY, 0, 'ни кадр, ни clip, ни шаг пакета страницу не прокрутили');

    const visible = await call('screenshot', { sessionId: live, fullPage: false });
    assert.equal(visible.scrollNote, undefined);

    /* Проход по странице нужен только при блоках, скрытых до прокрутки. */
    await pool.getSession(live).page.evaluate(() => {
      document.getElementById('s').style.opacity = '0';
    });
    const whole = await call('screenshot', { sessionId: live, fullPage: true });
    assert.ok(whole.height > 2000);
    assert.match(whole.scrollNote, /могли запуститься/);
    assert.ok((await scrolled(live)).maxY > 0);
  } finally {
    await call('browser_close', { sessionId: live });
  }

  const { sessionId: frozen } = await call('browser_open', { viewport: '800x600', url });
  try {
    const shot = await call('screenshot', { sessionId: frozen });
    assert.ok(shot.height > 2000, 'замороженная сессия по-прежнему снимает страницу целиком');
    assert.equal(shot.scrollNote, undefined);

    /* Разовое оживление одной страницы в замороженной сессии считается живым. */
    await call('browser_goto', { sessionId: frozen, url, animations: 'allow' });
    assert.equal((await call('screenshot', { sessionId: frozen })).height, 600);
  } finally {
    await call('browser_close', { sessionId: frozen });
    await client.close();
  }
});

test('страница по кадрам: CSS-переход и анимация на rAF идут по управляемым часам', options, async () => {
  const times = motion.frameTimes(500, 10);
  const shot = await capture.capturePage({
    url: `${base}/motion.html`,
    selector: '#m',
    trigger: 'click',
    triggerSelector: '#go',
    fps: 10,
    width: 800,
    texts: [],
    segments: [{ times, texts: ['Первый абзац', 'Рывок'] }],
  });
  const [segment] = shot.segments;
  assert.equal(segment.frames, 7);
  assert.equal(segment.measured.moved, true);
  const css = segment.elements.find((item) => item.text === 'первый абзац');
  const raf = segment.elements.find((item) => item.text === 'рывок');
  assert.deepEqual(css.y.map(Math.round), [60, 48, 36, 24, 12, 0]);
  assert.deepEqual(css.opacity.map((value) => Math.round(value * 10) / 10), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.equal(Math.round(raf.y[0]), 100);
  /* rAF срабатывает по сетке 16 мс: последний кадр может не дойти до конца на долю шага. */
  assert.ok(Math.abs(raf.y.at(-1)) <= 4, `конец анимации: ${raf.y.at(-1)}`);
  assert.ok(raf.y[2] < 100 && raf.y[2] > 0, `анимация на rAF идёт по шагам: ${raf.y}`);
});

test('page_ready: предупреждение Swiper и незакрытый пункт микро-ТЗ - блокеры', options, async () => {
  const result = await withPage('/warn.html', (session) =>
    ready.pageReady(session, { url: `${base}/warn.html`, run: 'all', widths: [1280], checklist: '- [x] Заголовок\n- [ ] Подсказка один раз\n' }),
  );
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((item) => item.check === 'page_logs' && item.what.startsWith('swiper-loop')), JSON.stringify(result.blockers));
  assert.ok(result.blockers.some((item) => item.check === 'spec' && item.where === 'Подсказка один раз'));
  assert.deepEqual(result.checklist, { done: 1, total: 2, open: 1 });
});
