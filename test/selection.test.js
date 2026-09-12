/**
 * Поверхность подключения: что реально поднимается на /mcp/<группы>.
 *
 * groups.test.js проверяет разбор адреса, здесь — его последствия: состав tools/list, рамка
 * подключения, список в help, сводка stand_info и набор сценариев. Смысл именно в согласованности:
 * отфильтровать инструменты мало, если рамка продолжает советовать отсутствующее — агент пойдёт
 * по совету, получит «нет такого инструмента» и решит, что стенд неисправен.
 *
 * Нужен полный набор зависимостей, как и в tools-manifest.test.js:
 *
 *   LT_FULL_TESTS=1 npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FLOOR, GROUPS, resolveSelection } from '../src/tools/groups.js';
import { buildInstructions } from '../src/tools/instructions.js';

const enabled = process.env.LT_FULL_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_FULL_TESTS=1 и полный npm ci' };

/** Инструменты пола: есть на любом адресе, какую бы выборку ни назвали. */
const ALWAYS = ['help', 'stand_info', 'artifacts_list', 'read_artifact'];

let connect = null;
let closeAll = null;
/** Выборка -> { tools: Set<string>, prompts: Set<string>, client } */
const built = new Map();

test.before(async () => {
  if (!enabled) return;
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  ({ closeAll } = await import('../src/browser/pool.js'));

  connect = async (spec) => {
    if (built.has(spec)) return built.get(spec);
    const selection = resolveSelection(spec);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = await createServer({ selection });
    await server.connect(serverSide);
    const client = new Client({ name: 'selection-test', version: '1' });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    /* Выборка, в которой не осталось ни одного выполнимого сценария, не объявляет возможность
       prompts вовсе, и prompts/list отвечает «метод не найден». Это не поломка, а следствие:
       SDK включает возможность при первой регистрации промпта. */
    const prompts = await client.listPrompts().then((r) => r.prompts, () => []);
    const entry = {
      selection,
      client,
      tools: new Set(tools.map((tool) => tool.name)),
      prompts: new Set(prompts.map((prompt) => prompt.name)),
    };
    built.set(spec, entry);
    return entry;
  };

  await connect('all');
  for (const group of GROUPS) await connect(group);
});

test.after(async () => {
  if (closeAll) await closeAll();
});

test('выборка всегда уже полного набора и никогда не шире', options, async () => {
  const all = await connect('all');
  for (const group of GROUPS) {
    const one = await connect(group);
    for (const name of one.tools) {
      assert.ok(all.tools.has(name), `${group}: инструмент ${name} есть в выборке, но не в полном наборе`);
    }
    assert.ok(one.tools.size < all.tools.size, `${group}: выборка совпала с полным набором`);
  }
});

test('группы покрывают полный набор — ни один инструмент не осиротел', options, async () => {
  const all = await connect('all');
  const covered = new Set();
  for (const group of GROUPS) for (const name of (await connect(group)).tools) covered.add(name);
  const orphans = [...all.tools].filter((name) => !covered.has(name));
  assert.deepEqual(orphans, [], 'инструмент не попадает ни в одну группу — его нельзя запросить адресом');
});

test('пол поднят при любой выборке', options, async () => {
  for (const group of GROUPS) {
    const one = await connect(group);
    for (const name of ALWAYS) {
      assert.ok(one.tools.has(name), `${group}: без ${name} агенту нечем понять, почему остального нет`);
    }
  }
});

test('добранная зависимость доходит до манифеста, а не остаётся на бумаге', options, async () => {
  const figma = await connect('figma');
  assert.ok(figma.tools.has('figma_compare'), 'названное должно быть поднято');
  assert.ok(figma.tools.has('screenshot'), 'visual добран к figma — значит и его инструменты');
  assert.ok(figma.tools.has('browser_open'), 'session добран к figma');
  assert.ok(!figma.tools.has('crawl'), 'ничего сверх названного и добранного');
});

test('рамка подключения не советует того, чего на этом адресе нет', options, async () => {
  const all = await connect('all');
  for (const group of GROUPS) {
    const one = await connect(group);
    const text = buildInstructions(one.selection.groups);
    for (const name of all.tools) {
      if (one.tools.has(name)) continue;
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${name}\\b`),
        `/mcp/${group}: рамка упоминает ${name}, которого здесь нет`,
      );
    }
  }
});

test('рамка называет хотя бы один поднятый инструмент', options, async () => {
  for (const group of GROUPS) {
    const one = await connect(group);
    const text = buildInstructions(one.selection.groups);
    const named = [...one.tools].some((name) => new RegExp(`\\b${name}\\b`).test(text));
    assert.ok(named, `/mcp/${group}: рамка не называет ни одного инструмента — с чего начинать, неясно`);
  }
});

test('help перечисляет только поднятое', options, async () => {
  const seo = await connect('seo');
  const answer = await seo.client.callTool({ name: 'help', arguments: {} });
  const listed = JSON.parse(answer.content[0].text).tools;
  for (const name of listed) {
    assert.ok(seo.tools.has(name), `help предлагает ${name}, которого на /mcp/seo нет`);
  }
});

test('help про неподнятый инструмент отвечает оговорками и говорит, где он есть', options, async () => {
  const seo = await connect('seo');
  const answer = await seo.client.callTool({ name: 'help', arguments: { tool: 'figma_compare' } });
  const payload = JSON.parse(answer.content[0].text);
  assert.equal(payload.active, false);
  assert.ok(payload.detail, 'оговорки остаются доступными: знать отличие полезно и до подключения');
  assert.match(payload.note, /\/mcp/, 'ответ должен называть адрес, где инструмент есть');
});

test('stand_info объясняет выборку и не отправляет перезапускать стенд', options, async () => {
  const figma = await connect('figma');
  const answer = await figma.client.callTool({ name: 'stand_info', arguments: {} });
  const { tools } = JSON.parse(answer.content[0].text);

  assert.equal(tools.endpoint, '/mcp/figma+session+visual');
  assert.deepEqual(tools.requested, ['figma']);
  assert.deepEqual(tools.added, ['session', 'visual']);
  for (const name of FLOOR) assert.ok(tools.groups.includes(name), `${name} поднят всегда и должен быть виден`);
  assert.match(tools.note, /\/mcp/, 'совет должен называть адрес, по которому есть остальное');
  assert.doesNotMatch(tools.note, /LT_TOOLS/, 'переменной окружения больше нет — совет про неё уводил бы в никуда');
  assert.doesNotMatch(
    tools.note,
    /перезапустите|restart the stand/i,
    'набор меняется вторым подключением, а не перезапуском стенда',
  );
});

test('stand_info полного набора не выдумывает добранного', options, async () => {
  const all = await connect('all');
  const answer = await all.client.callTool({ name: 'stand_info', arguments: {} });
  const { tools } = JSON.parse(answer.content[0].text);
  assert.equal(tools.endpoint, '/mcp');
  assert.deepEqual([...tools.groups].sort(), [...GROUPS, ...FLOOR].sort());
});

test('сценарии поднимаются только там, где выполнимы', options, async () => {
  assert.ok((await connect('figma')).prompts.has('figma-layout'));
  assert.ok(!(await connect('seo')).prompts.has('figma-layout'), 'сценарий по макету без figma невыполним');
  assert.ok((await connect('crawl')).prompts.has('seo-site'));
  assert.ok(!(await connect('perf')).prompts.has('layout-broken'));
  assert.equal((await connect('all')).prompts.size, 4, 'полный набор отдаёт все сценарии');
});
