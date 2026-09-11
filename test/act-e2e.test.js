/**
 * Действия над страницей — через настоящие инструменты, а не через их внутренности.
 *
 * Загрузка файлов, диалоги, запись запросов и признак навигации живут в обработчиках
 * registerTool: между схемой, разбором аргументов и самим действием там достаточно места,
 * чтобы ошибиться, и проверка по внутренним функциям это место пропустила бы. Поэтому здесь
 * поднимается сервер и вызовы идут по JSON-RPC — ровно так, как их делает агент.
 *
 * Нужен браузер и полный набор зависимостей:
 *
 *   LT_BROWSER_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

/* Проверка обновлений ходит в сеть и к тесту отношения не имеет. Выключаем до импортов:
   значение читается на загрузке constants.js. */
process.env.LT_UPDATE_CHECK = '0';

const enabled = process.env.LT_BROWSER_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_BROWSER_TESTS=1 и установленный playwright' };

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');

let client;
let closeAll;
let server;
let base;
let sessionId;

/** Вызов инструмента с разбором ответа: текстовый блок у них всегда JSON. */
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * Сервер фикстур.
 *
 * file:// здесь не годится: форма должна уходить настоящим POST, иначе записывать в
 * browser_route нечего, а перехват диалога выбора файлов проверяется на той же странице.
 */
async function startServer() {
  const srv = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'POST') {
      // Тело дочитываем, иначе клиент ждёт; содержимое проверяется через запись правила.
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }

    const file = path.join(FIXTURES, path.basename(url));
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('нет такой страницы');
    }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return srv;
}

test.before(async () => {
  if (!enabled) return;
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  ({ closeAll } = await import('../src/browser/pool.js'));

  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = await createServer();
  await mcp.connect(serverSide);
  client = new Client({ name: 'act-e2e', version: '1' });
  await client.connect(clientSide);

  ({ sessionId } = await call('browser_open', { viewport: 'desktop' }));
});

test.after(async () => {
  if (closeAll) await closeAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('upload кладёт файл в скрытый input[type=file]', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/upload.html` });
  const res = await call('browser_act', {
    sessionId,
    action: 'upload',
    selector: '#files',
    files: ['fixtures/files/resume.txt'],
  });

  assert.equal(res.via, 'input', 'инпуту файлы кладутся прямо, без диалога выбора');
  assert.equal(res.files[0].path, 'fixtures/files/resume.txt');
  assert.ok(res.files[0].bytes > 0, 'размер файла должен быть прочитан со стенда');

  const picked = await call('browser_eval', {
    sessionId,
    expression: "document.querySelector('#picked').textContent",
  });
  assert.match(picked.value, /resume\.txt/);
});

test('upload по кнопке проходит через диалог выбора файлов', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/upload.html` });
  const res = await call('browser_act', {
    sessionId,
    action: 'upload',
    selector: '#clip',
    files: ['fixtures/files/letter.txt'],
  });

  assert.equal(res.via, 'filechooser', 'кнопка открывает системный диалог, и его надо ловить');

  const picked = await call('browser_eval', {
    sessionId,
    expression: "document.querySelector('#picked').textContent",
  });
  assert.match(picked.value, /letter\.txt/);
});

test('upload не пускает за пределы рабочего каталога стенда', options, async () => {
  await assert.rejects(
    () => call('browser_act', { sessionId, action: 'upload', selector: '#files', files: ['../../etc/passwd'] }),
    /выходит за пределы/,
  );
});

test('record показывает состав multipart, а не только счётчик попаданий', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/upload.html` });
  await call('browser_route', { sessionId, action: 'clear' });
  const added = await call('browser_route', {
    sessionId,
    pattern: '**/api/vacancy',
    handler: 'fulfill',
    contentType: 'application/json',
    body: '{"ok":true}',
    record: true,
  });
  assert.equal(added.added.handler, 'fulfill', 'запись не отменяет подмену');

  await call('browser_act', {
    sessionId,
    action: 'upload',
    selector: '#files',
    files: ['fixtures/files/resume.txt'],
  });
  /* Кука ставится нарочно: журнал уезжает в переписку, и доступу там не место. */
  await call('browser_eval', { sessionId, expression: "document.cookie = 'sid=секрет'; return document.cookie" });
  await call('browser_act', { sessionId, action: 'click', selector: '#send' });

  const { recorded } = await call('browser_route', { sessionId, action: 'requests' });
  assert.equal(recorded.length, 1);
  const request = recorded[0].requests.at(-1);
  assert.equal(request.method, 'POST');
  assert.equal(request.body.kind, 'multipart');

  const names = request.body.fields.map((f) => f.name);
  assert.ok(names.includes('name'), `в теле должно быть поле name, а есть ${names.join(', ')}`);
  assert.ok(names.includes('files[]'), 'файл должен уйти в том же запросе');

  const file = request.body.fields.find((f) => f.filename);
  assert.equal(file.filename, 'resume.txt');
  assert.equal(file.contentType, 'text/plain');
  /* Содержимое файла браузер в тело запроса не кладёт, и притворяться, что кладёт, нельзя:
     нулевой размер без объяснения читался бы как «ушёл пустой файл». */
  assert.match(request.body.note, /Содержимое файлов/);

  const text = request.body.fields.find((f) => f.name === 'name');
  assert.equal(text.value, 'Иван');

  assert.equal(request.headers.cookie, undefined, 'куки сессии в журнал попадать не должны');

  await call('browser_route', { sessionId, action: 'clear' });
});

test('диалоги попадают в журнал, а не закрываются молча', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/dialogs.html` });
  await call('browser_act', { sessionId, action: 'click', selector: '#alert' });

  const logs = await call('page_logs', { sessionId, kind: 'dialogs' });
  const last = logs.dialogs.items.at(-1);
  assert.equal(last.type, 'alert');
  assert.match(last.message, /Файл слишком большой/);
  assert.equal(last.action, 'dismiss', 'по умолчанию диалог по-прежнему отклоняется');
});

test('политика диалогов меняется на ходу и действует на открытой странице', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/dialogs.html` });

  await call('browser_act', { sessionId, action: 'click', selector: '#confirm' });
  const dismissed = await call('browser_eval', {
    sessionId,
    expression: "document.querySelector('#result').textContent",
  });
  assert.equal(dismissed.value, 'confirm: false');

  await call('browser_act', { sessionId, action: 'dialog', value: 'accept' });
  await call('browser_act', { sessionId, action: 'click', selector: '#confirm' });
  const accepted = await call('browser_eval', {
    sessionId,
    expression: "document.querySelector('#result').textContent",
  });
  assert.equal(accepted.value, 'confirm: true');

  await call('browser_act', { sessionId, action: 'dialog', value: 'Мария' });
  await call('browser_act', { sessionId, action: 'click', selector: '#prompt' });
  const answered = await call('browser_eval', {
    sessionId,
    expression: "document.querySelector('#result').textContent",
  });
  assert.equal(answered.value, 'prompt: Мария');

  await call('browser_act', { sessionId, action: 'dialog', value: 'dismiss' });
});

test('press без селектора нажимает клавишу на уровне страницы', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/dialogs.html` });
  const res = await call('browser_act', { sessionId, action: 'press', value: 'Escape' });
  assert.equal(res.ok, true);
  assert.equal(res.key, 'Escape');
});

test('click без селектора бьёт по координатам', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/dialogs.html` });
  const at = await call('browser_eval', {
    sessionId,
    expression:
      "const r = document.querySelector('#confirm').getBoundingClientRect();" +
      'return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };',
  });

  await call('browser_act', { sessionId, action: 'click', x: at.value.x, y: at.value.y });
  const result = await call('browser_eval', {
    sessionId,
    expression: "document.querySelector('#result').textContent",
  });
  assert.match(result.value, /^confirm: /);
});

test('без селектора и координат click объясняет, чего не хватает', options, async () => {
  await assert.rejects(() => call('browser_act', { sessionId, action: 'click' }), /координаты/);
});

test('самопроизвольная перезагрузка видна в ответе следующего вызова', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/dialogs.html` });
  /* Свой переход неожиданностью не считается: сразу после goto признака быть не должно. */
  const quiet = await call('browser_act', { sessionId, action: 'wait', selector: 'body' });
  assert.equal(quiet.navigatedSince, undefined);

  await call('browser_eval', {
    sessionId,
    expression: "setTimeout(function () { location.reload(); }, 10); return 'scheduled';",
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  const after = await call('browser_act', { sessionId, action: 'wait', selector: 'body' });
  assert.ok(after.navigatedSince, 'перезагрузка между вызовами обязана быть видна');
  assert.ok(after.navigatedSince.count >= 1);
});

test('404 бандла попадает в ошибки, а не только в сетевой журнал', options, async () => {
  const local = await call('browser_open', { viewport: 'desktop' });
  try {
    await call('browser_route', {
      sessionId: local.sessionId,
      pattern: '**/dialogs.html',
      handler: 'fulfill',
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><script src="/bundle.gone.js"></script><p>цела с виду</p></body></html>',
    });
    await call('browser_goto', { sessionId: local.sessionId, url: `${base}/dialogs.html` });

    const logs = await call('page_logs', { sessionId: local.sessionId, kind: 'errors' });
    assert.equal(logs.errors.items.length, 0, 'необработанных исключений здесь и не бывает');
    assert.ok(logs.resourceErrors, 'не доехавший скрипт обязан быть виден среди ошибок');
    assert.match(logs.resourceErrors.items[0].url, /bundle\.gone\.js/);
  } finally {
    await call('browser_close', { sessionId: local.sessionId });
  }
});

test('animations: allow оставляет переходы живыми, по умолчанию они заглушены', options, async () => {
  const frozen = await call('browser_open', { viewport: 'desktop', url: `${base}/animated.html` });
  const live = await call('browser_open', {
    viewport: 'desktop',
    animations: 'allow',
    url: `${base}/animated.html`,
  });

  try {
    const read = (id) =>
      call('browser_eval', {
        sessionId: id,
        expression: "getComputedStyle(document.querySelector('.card__body')).transitionDuration",
      });

    assert.equal((await read(frozen.sessionId)).value, '0s', 'по умолчанию движение останавливается');
    assert.equal(
      (await read(live.sessionId)).value,
      '1.2s',
      'с allow снимается и служебный CSS, и reduced-motion, иначе страница глушит переход сама',
    );
  } finally {
    await call('browser_close', { sessionId: frozen.sessionId });
    await call('browser_close', { sessionId: live.sessionId });
  }
});

test('include сужает и подробности, и счётчики layout_audit', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/broken.html` });

  const whole = await call('layout_audit', { sessionId });
  assert.ok(whole.counts.tinyTargets > 0);
  assert.ok(whole.counts.lowContrast > 0);

  const targets = await call('layout_audit', { sessionId, include: ['#targets'] });
  assert.ok(targets.counts.tinyTargets > 0, 'внутри выбранного блока находки остаются');
  assert.equal(targets.counts.lowContrast, 0, 'чужие находки не должны набивать счётчик');
  assert.equal(targets.counts.imagesWithoutDimensions, 0, 'картинки берутся из той же области');
  assert.deepEqual(targets.scope.include, ['#targets']);

  /* Мелкие цели на этой фикстуре есть и вне #targets, поэтому сравниваем с полным разбором
     и смотрим, что ушли именно те две, а не «сколько-нибудь». */
  const without = await call('layout_audit', { sessionId, exclude: ['#targets'] });
  assert.ok(
    without.counts.tinyTargets < whole.counts.tinyTargets,
    'находки исключённого блока обязаны уйти из счётчика',
  );
  assert.equal(
    without.issues.tinyTargets.filter((i) => i.selector.includes('tiny')).length,
    0,
    'кнопка из исключённого блока не должна остаться в подробностях',
  );
  assert.ok(without.counts.lowContrast > 0, 'остальная страница разбирается как раньше');
});

test('clip снимает прямоугольник, а не страницу целиком', options, async () => {
  await call('browser_goto', { sessionId, url: `${base}/upload.html` });
  const shot = await call('screenshot', {
    sessionId,
    name: 'clip-probe',
    clip: { x: 0, y: 0, width: 120, height: 60 },
  });
  assert.equal(shot.width, 120);
  assert.equal(shot.height, 60);
});
