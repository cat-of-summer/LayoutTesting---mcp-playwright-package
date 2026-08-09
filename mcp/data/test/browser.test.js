/**
 * Проверки, которым нужен настоящий браузер. По умолчанию пропускаются:
 * `npm test` должен оставаться зелёным там, где playwright не установлен.
 *
 *   LT_BROWSER_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const FIXTURE = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/stacking.html')).href;

let pool;
let session;

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  session = await pool.createSession({ viewport: 'desktop' });
  await pool.gotoAndSettle(session, FIXTURE);
});

test.after(async () => {
  if (pool) await pool.closeAll();
});

test('browser_eval возвращает значение выражения со словом return внутри', options, async () => {
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const res = await evaluateOnPage(
    session.page,
    "['a','b'].map(function (p) { return p.toUpperCase() }).join('')",
  );
  assert.equal(res.mode, 'expression');
  assert.equal(res.value, 'AB');
});

test('browser_eval честно сообщает про undefined вместо пустого ответа', options, async () => {
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const res = await evaluateOnPage(session.page, 'void 0');
  assert.equal(res.type, 'undefined');
  assert.match(res.note, /ничего не вернуло/);
});

test('browser_eval исполняет тело функции с несколькими инструкциями', options, async () => {
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const res = await evaluateOnPage(session.page, 'const n = document.querySelectorAll("p").length; return n;');
  assert.equal(res.mode, 'body');
  assert.ok(res.value >= 2);
});

test('computed_styles читает псевдоэлемент', options, async () => {
  const { computedStyles } = await import('../src/checks/layout.js');
  const res = await computedStyles(session.page, '.hero', ['z-index', 'position'], { pseudo: '::before' });
  assert.equal(res.found, true);
  assert.equal(res.styles['z-index'], '4');
  assert.equal(res.styles.position, 'absolute');
});

test('computed_styles отдаёт все совпадения селектора', options, async () => {
  const { computedStyles } = await import('../src/checks/layout.js');
  const res = await computedStyles(session.page, 'p', ['display'], { all: true });
  assert.ok(res.count >= 2);
  assert.equal(res.matches.length, res.count);
});

test('element_layers ловит z-index на position: static', options, async () => {
  const { elementLayers } = await import('../src/checks/layers.js');
  const res = await elementLayers(session.page, { selector: '.dead-z' });
  assert.equal(res.found, true);
  assert.ok(res.warnings.some((w) => w.kind === 'deadZIndex'));
});

test('element_layers объясняет z-index, запертый в чужом стек-контексте', options, async () => {
  const { elementLayers } = await import('../src/checks/layers.js');
  const res = await elementLayers(session.page, { selector: '.trapped' });
  assert.ok(res.warnings.some((w) => w.kind === 'scopedZIndex'));
  assert.ok(res.stackingContextChain.length > 0);
});

test('element_layers видит, что текст закрыт непрозрачной крышкой', options, async () => {
  const { elementLayers } = await import('../src/checks/layers.js');
  const res = await elementLayers(session.page, { selector: '.covered-text' });
  assert.ok(res.hitTest.some((h) => h.covered && h.opaque));
});

test('element_layers разбирает псевдоэлемент-затемнение', options, async () => {
  const { elementLayers } = await import('../src/checks/layers.js');
  const res = await elementLayers(session.page, { selector: '.hero', pseudo: '::before' });
  assert.equal(res.target.zIndex, '4');
  assert.equal(res.target.pointerEvents, 'none');
});

test('layout_audit сообщает про перекрытый текст и мёртвый z-index', options, async () => {
  const { layoutAudit } = await import('../src/checks/layout.js');
  const res = await layoutAudit(session.page);
  assert.ok(res.issues.deadZIndex.some((i) => i.zIndex === '10'));
  assert.ok(res.issues.coveredText.some((i) => /закрыт/.test(i.text)));
});

test('matched_rules показывает правило псевдоэлемента и его источник', options, async () => {
  const { matchedRules } = await import('../src/checks/cssom.js');
  const res = await matchedRules(session.page, { selector: '.hero', pseudo: '::before', properties: ['z-index'] });
  assert.equal(res.found, true);
  const winner = res.winners.find((w) => w.property === 'z-index');
  assert.equal(winner.value, '4');
  assert.ok(res.rules.some((r) => r.selector.includes('.hero')));
});

test('browser_style переживает навигацию', options, async () => {
  const { addInjection, clearInjections } = await import('../src/browser/inject.js');
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  await addInjection(session, { css: '.hero__title{color:rgb(1, 2, 3)}', id: 'patch' });

  const before = await evaluateOnPage(session.page, "getComputedStyle(document.querySelector('.hero__title')).color");
  assert.equal(before.value, 'rgb(1, 2, 3)');

  await pool.gotoAndSettle(session, FIXTURE);
  const after = await evaluateOnPage(session.page, "getComputedStyle(document.querySelector('.hero__title')).color");
  assert.equal(after.value, 'rgb(1, 2, 3)', 'патч должен переприменяться после перехода');

  await clearInjections(session);
});

/**
 * Перехвату нужен настоящий http: под file:// внешних запросов у страницы нет.
 * Поднимаем крошечный сервер прямо здесь — контейнер для этого не нужен.
 */
test('browser_route подменяет и блокирует запросы', options, async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/theme.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('h1{color:rgb(9, 9, 9)}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><link rel="stylesheet" href="/theme.css"><h1>привет</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { addRoute, clearRoutes, listRoutes } = await import('../src/browser/routes.js');
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const local = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(local, `${base}/`);
    const original = await evaluateOnPage(local.page, "getComputedStyle(document.querySelector('h1')).color");
    assert.equal(original.value, 'rgb(9, 9, 9)');

    await addRoute(local, {
      pattern: '**/theme.css',
      handler: 'fulfill',
      contentType: 'text/css',
      body: 'h1{color:rgb(4, 4, 4)}',
    });
    await pool.gotoAndSettle(local, `${base}/`);
    const patched = await evaluateOnPage(local.page, "getComputedStyle(document.querySelector('h1')).color");
    assert.equal(patched.value, 'rgb(4, 4, 4)', 'таблица стилей должна прийти из правила');
    assert.ok(listRoutes(local)[0].hits > 0, 'счётчик попаданий обязан расти');

    await clearRoutes(local);
    await pool.gotoAndSettle(local, `${base}/`);
    const restored = await evaluateOnPage(local.page, "getComputedStyle(document.querySelector('h1')).color");
    assert.equal(restored.value, 'rgb(9, 9, 9)', 'после clear правило должно сниматься');
  } finally {
    await pool.closeSession(local.id);
    await new Promise((resolve) => server.close(resolve));
  }
});
