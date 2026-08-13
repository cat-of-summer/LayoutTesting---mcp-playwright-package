/**
 * Эвристики разбора вёрстки. Нужен настоящий браузер:
 *
 *   npm run test:browser
 *
 * Здесь два разных сорта проверок, и путать их не надо.
 *
 * Первая половина закрепляет то, что стенд уже находит на fixtures/broken.html: этот
 * файл собран как эталонный набор из десяти пронумерованных дефектов, по одному на
 * категорию. Проверки написаны на «не меньше, чем», а не на точное число: правка
 * эвристики имеет право найти больше, но молча перестать находить заявленный дефект — нет.
 *
 * Вторая половина — про ложные срабатывания и пропуски, найденные на боевой странице.
 * Там числа точные: смысл именно в том, что находок быть не должно.
 *
 * Фикстуры отдаются по http: под file:// не воспроизводятся ни ленивая загрузка,
 * ни наблюдатели пересечения на честных координатах.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

let pool;
let layoutAudit;
let server;
let base;

async function startServer() {
  const srv = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
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

/** Открывает фикстуру и отдаёт разбор, закрывая сессию в любом случае. */
async function audit(file, opts = {}, viewport = 'desktop') {
  const session = await pool.createSession({ viewport });
  try {
    await pool.gotoAndSettle(session, `${base}/${file}`);
    return await layoutAudit(session.page, opts);
  } finally {
    await pool.closeSession(session.id);
  }
}

test.before(async () => {
  if (!enabled) return;
  pool = await import('../src/browser/pool.js');
  ({ layoutAudit } = await import('../src/checks/layout.js'));
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (pool) await pool.closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// Закрепляем то, что уже находится на эталонной фикстуре дефектов.
// ---------------------------------------------------------------------------

test('на эталонной фикстуре находится каждый из заявленных дефектов', options, async () => {
  const res = await audit('broken.html');
  const c = res.counts;

  assert.ok(res.issues.documentOverflow, 'случай 1: горизонтальный скролл документа');
  assert.ok(c.overflowingElements >= 1, 'случай 1: блок шириной 3000px');
  assert.ok(c.overlaps >= 1, 'случай 2: соседи с отрицательным margin');
  assert.ok(c.clippedText >= 2, 'случай 3: обрезка по ширине и по высоте');
  assert.ok(c.brokenImages >= 1, 'случай 4: картинка, которой нет');
  assert.ok(c.imagesWithoutDimensions >= 1, 'случай 5: картинка без width/height');
  assert.ok(c.tinyTargets >= 2, 'случай 6: кнопка 20px и ссылка 18px');
  assert.ok(c.lowContrast >= 1, 'случай 7: #b6bcc6 на белом');
});

test('счётчики считаются по всем категориям, даже если запрошена одна', options, async () => {
  const res = await audit('broken.html', { categories: ['overlaps'] });

  assert.ok(res.counts.clippedText >= 2, 'счётчики не должны зависеть от фильтра');
  assert.equal(res.issues.clippedText, undefined, 'подробности — только по запрошенному');
  assert.ok(Array.isArray(res.issues.overlaps));
});

test('на чистой фикстуре разбор молчит', options, async () => {
  const res = await audit('clean.html');

  assert.equal(res.counts.documentOverflow, 0);
  assert.equal(res.counts.overflowingElements, 0);
  assert.equal(res.counts.overlaps, 0);
  assert.equal(res.counts.coveredText, 0);
  assert.equal(res.counts.clippedText, 0);
  assert.equal(res.counts.brokenImages, 0);
});

test('обрезанный текст различает многоточие и глухую обрезку', options, async () => {
  const res = await audit('broken.html', { categories: ['clippedText'] });
  const items = res.issues.clippedText;

  // Оба случая — находки, но потребитель обязан уметь их развести: на каталоге
  // из полусотни карточек многоточие иначе топит единственный настоящий дефект.
  const withEllipsis = items.filter((i) => i.ellipsis);
  const withoutEllipsis = items.filter((i) => !i.ellipsis);

  assert.ok(withEllipsis.length >= 1, 'обрезка с многоточием');
  assert.ok(withoutEllipsis.length >= 1, 'обрезка без многоточия');
  assert.ok(
    withEllipsis.every((i) => typeof i.hasTitle === 'boolean'),
    'признак title обязан быть у каждой находки',
  );
});

// ---------------------------------------------------------------------------
// Ложные срабатывания и пропуски, найденные на боевой странице.
// ---------------------------------------------------------------------------

test('элемент, уехавший за край скролл-контейнера, не считается перекрытым', options, async () => {
  const res = await audit('scroll-clip.html', { categories: ['coveredText'] });
  const covered = res.issues.coveredText;

  const tabs = covered.filter((i) => /rail__tab|rail/.test(i.selector));
  assert.equal(
    tabs.length,
    0,
    `кнопки рейла обрезаны своим контейнером, а не перекрыты подвалом; найдено: ${tabs
      .map((i) => i.text)
      .join(', ')}`,
  );

  // Настоящее перекрытие рядом — если пропало и оно, проверка выхолощена.
  assert.ok(
    covered.some((i) => i.selector.includes('really-covered')),
    'абзац под непрозрачной плашкой обязан остаться находкой',
  );
});

test('виновник горизонтального скролла находится и при body overflow-x hidden', options, async () => {
  const res = await audit('overflow-hidden-body.html', { categories: ['overflowingElements'] });
  const items = res.issues.overflowingElements;

  assert.ok(
    items.some((i) => i.selector.includes('culprit')),
    'блок 2000px обязан быть назван, иначе отчёт бесполезен именно там, где нужен',
  );
  assert.ok(
    !items.some((i) => i.selector.includes('carousel__track')),
    'лента карусели в своей рамке широка намеренно',
  );
});

test('снимок fullPage дожидается блоков, проявляющихся при прокрутке', options, async () => {
  const { evaluateOnPage } = await import('../src/browser/evaluate.js');
  const { takeScreenshot } = await import('../src/checks/visual.js');
  const session = await pool.createSession({ viewport: 'desktop' });

  try {
    await pool.gotoAndSettle(session, `${base}/reveal-on-scroll.html`);
    await takeScreenshot(session.page, {
      runId: 'test-reveal',
      name: 'reveal',
      fullPage: true,
    });

    const res = await evaluateOnPage(
      session.page,
      `(() => {
        const all = [...document.querySelectorAll('.block')];
        return {
          total: all.length,
          hidden: all.filter((el) => getComputedStyle(el).opacity === '0').map((el) => el.textContent.trim()),
        };
      })()`,
    );

    assert.equal(res.value.total, 10, 'фикстура рассчитана на десять блоков');
    assert.deepEqual(
      res.value.hidden,
      [],
      'к моменту съёмки не должно остаться непроявленных блоков',
    );
  } finally {
    await pool.closeSession(session.id);
  }
});
