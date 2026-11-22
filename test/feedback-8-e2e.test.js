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
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
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
