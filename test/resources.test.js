/**
 * Ресурсы, промпты и чистка эталонов.
 *
 * Нужен полный набор зависимостей — сервер тянет sharp, playwright и linkedom, — поэтому
 * по умолчанию пропускается:
 *
 *   LT_FULL_TESTS=1 npm test
 *
 * Браузер не запускается: ни один из проверяемых путей до обработчиков с сессией не доходит.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.LT_FULL_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_FULL_TESTS=1 и полный npm ci' };

let client = null;
let closeAll = null;

test.before(async () => {
  if (!enabled) return;
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  ({ closeAll } = await import('../src/browser/pool.js'));

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = await createServer();
  await server.connect(serverSide);
  client = new Client({ name: 'resources-test', version: '1' });
  await client.connect(clientSide);
});

test.after(async () => {
  if (closeAll) await closeAll();
});

test('сервер объявляет ресурсы, промпты и автодополнение', options, () => {
  const caps = client.getServerCapabilities();
  assert.ok(caps.resources, 'ресурсы должны быть объявлены');
  assert.ok(caps.prompts, 'промпты должны быть объявлены');
  assert.ok(caps.completions, 'автодополнение регистрируется вместе с шаблонами ресурсов');
});

test('перечисляются прогоны и эталоны, а не файлы внутри них', options, async () => {
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'lt://stand/info'), 'сводка о стенде адресуема');

  const runs = resources.filter((r) => r.uri.startsWith('lt://artifacts/'));
  // Каталог прогона, а не файл в нём: полсотни прогонов по десятку файлов сами стали бы
  // полезной нагрузкой.
  for (const run of runs) assert.match(run.uri, /\/$/, `${run.uri} должен быть каталогом`);
});

test('шаблоны покрывают все три хранилища', options, async () => {
  const { resourceTemplates } = await client.listResourceTemplates();
  const patterns = resourceTemplates.map((r) => r.uriTemplate);
  assert.deepEqual(patterns.sort(), [
    'lt://artifacts/{+path}',
    'lt://baselines/{name}',
    'lt://sites/{+path}',
  ]);
});

test('сводка о стенде одинакова через ресурс и через инструмент', options, async () => {
  const viaResource = await client.readResource({ uri: 'lt://stand/info' });
  const viaTool = await client.callTool({ name: 'stand_info', arguments: {} });
  const a = JSON.parse(viaResource.contents[0].text);
  const b = JSON.parse(viaTool.content[0].text);
  // Сессии и доступность валидатора меняются между вызовами, версия и пути — нет.
  assert.equal(a.version, b.version);
  assert.deepEqual(a.dirs, b.dirs);
  assert.deepEqual(a.viewports, b.viewports);
});

test('за пределы своего каталога ресурс не выпускает', options, async () => {
  // state/ хранит сохранённые логины и не адресуем ни под каким видом.
  const attempts = [
    'lt://sites/..%2Fstate%2Fprofiles.json',
    'lt://artifacts/..%2Fstate%2Fprofiles.json',
  ];
  for (const uri of attempts) {
    await assert.rejects(
      () => client.readResource({ uri }),
      (err) => {
        assert.match(err.message, /выходит за пределы|outside/i, `${uri}: отказ должен быть по границе`);
        return true;
      },
    );
  }
});

test('промпты на месте и разворачиваются с аргументами', options, async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(
    prompts.map((p) => p.name).sort(),
    ['figma-layout', 'layout-broken', 'seo-site', 'visual-regression'],
  );

  const got = await client.getPrompt({
    name: 'layout-broken',
    arguments: { url: 'http://nginx_app/', viewport: 'mobile', symptom: 'съехал header' },
  });
  const text = got.messages[0].content.text;
  assert.match(text, /http:\/\/nginx_app\//);
  assert.match(text, /viewport: "mobile"/);
  assert.match(text, /съехал header/);
  // Порядок шагов — то, ради чего промпт и заведён.
  assert.ok(text.indexOf('layout_audit') < text.indexOf('screenshot'), 'снимок идёт после разбора');
});

test('чистка эталонов по умолчанию ничего не удаляет', options, async () => {
  const before = JSON.parse(
    (await client.callTool({ name: 'visual_baselines', arguments: {} })).content[0].text,
  );

  const dry = JSON.parse(
    (await client.callTool({ name: 'visual_baselines', arguments: { action: 'prune', olderThanDays: 0 } }))
      .content[0].text,
  );
  assert.equal(dry.applied, false, 'без apply: true удаления быть не должно');
  assert.ok(Array.isArray(dry.wouldRemove), 'должен показать, что именно уйдёт');

  const after = JSON.parse(
    (await client.callTool({ name: 'visual_baselines', arguments: {} })).content[0].text,
  );
  assert.equal(after.baselines.length, before.baselines.length, 'вхолостую — значит вхолостую');
});

test('удаление эталона требует имени', options, async () => {
  const out = await client.callTool({ name: 'visual_baselines', arguments: { action: 'delete' } });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /name/);
});
