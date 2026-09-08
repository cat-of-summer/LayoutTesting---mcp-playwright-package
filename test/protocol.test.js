/**
 * Протокольные правки: совместимость со старыми вызовами и чистка схем.
 *
 * Браузер и тяжёлые зависимости не нужны — обработчики подставляются поддельные, проверяется
 * ровно то, что делает сам патч.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installProtocolPatches } from '../src/protocol.js';
import { getProfile, listProfiles } from '../src/browser/profiles.js';

/** Поддельный McpServer: патчу нужны только карта обработчиков и setRequestHandler. */
function fakeServer({ onCall, onList } = {}) {
  const handlers = new Map();
  if (onCall) handlers.set('tools/call', onCall);
  if (onList) handlers.set('tools/list', onList);
  const server = {
    _requestHandlers: handlers,
    setRequestHandler(schema, fn) {
      handlers.set(schema.shape.method.value, fn);
    },
  };
  return { mcp: { server }, handlers };
}

const callRequest = (name, args) => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

test('старые условия просмотра складываются в профиль, а вызов доходит', async () => {
  let seen = null;
  const { mcp, handlers } = fakeServer({
    onCall: async (request) => {
      seen = request.params.arguments;
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
  });
  installProtocolPatches(mcp);

  const result = await handlers.get('tools/call')(
    callRequest('audit', { url: 'http://example.test/', viewport: 'mobile', zoom: 200, rtl: true }),
    {},
  );

  assert.equal(seen.url, 'http://example.test/');
  assert.equal(seen.viewport, 'mobile', 'короткие условия остаются на месте');
  assert.equal('zoom' in seen, false, 'переехавшие ключи из аргументов убраны');
  assert.ok(seen.profile, 'вместо них подставлено имя одноразового профиля');

  const conditions = getProfile(seen.profile);
  assert.deepEqual(conditions, { zoom: 200, rtl: true }, 'условия сохранены полностью');

  const note = result.content.at(-1).text;
  assert.match(note, /zoom, rtl/);
  assert.match(note, /browser_open/);
});

test('пароль не теряется по дороге — иначе была бы загадочная 401', async () => {
  let seen = null;
  const { mcp, handlers } = fakeServer({
    onCall: async (request) => {
      seen = request.params.arguments;
      return { content: [] };
    },
  });
  installProtocolPatches(mcp);

  await handlers.get('tools/call')(callRequest('seo_page', { url: 'http://stand.test/', auth: 'user:secret' }), {});
  assert.deepEqual(getProfile(seen.profile), { auth: 'user:secret' });
});

test('одноразовые профили не показываются в списке', async () => {
  const { mcp, handlers } = fakeServer({ onCall: async () => ({ content: [] }) });
  installProtocolPatches(mcp);
  await handlers.get('tools/call')(callRequest('audit', { url: 'http://x.test/', hostMap: { a: '1.2.3.4' } }), {});
  assert.deepEqual(
    listProfiles().filter((p) => p.name.startsWith('__inline_')),
    [],
  );
});

test('вызов без переехавших условий не трогается вовсе', async () => {
  let calls = 0;
  const { mcp, handlers } = fakeServer({
    onCall: async (request) => {
      calls += 1;
      return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
    },
  });
  installProtocolPatches(mcp);

  const result = await handlers.get('tools/call')(callRequest('audit', { url: 'http://x.test/', viewport: 'mobile' }), {});
  assert.equal(calls, 1);
  assert.equal(result.content.length, 1, 'лишней пометки быть не должно');
  assert.deepEqual(JSON.parse(result.content[0].text), { url: 'http://x.test/', viewport: 'mobile' });
});

test('инструменты, у которых условия не менялись, проходят как есть', async () => {
  let seen = null;
  const { mcp, handlers } = fakeServer({
    onCall: async (request) => {
      seen = request.params.arguments;
      return { content: [] };
    },
  });
  installProtocolPatches(mcp);
  // browser_open сохранил полный набор условий: подменять у него нечего.
  await handlers.get('tools/call')(callRequest('browser_open', { url: 'http://x.test/', zoom: 200 }), {});
  assert.equal(seen.zoom, 200);
  assert.equal('profile' in seen, false);
});

test('из схем убран $schema, пустые properties свёрнуты', async () => {
  const tools = [
    {
      name: 'a',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { x: { type: 'string' } },
        additionalProperties: false,
      },
    },
    {
      name: 'b',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  ];
  const { mcp, handlers } = fakeServer({ onList: async () => ({ tools }) });
  installProtocolPatches(mcp);

  const out = await handlers.get('tools/list')({ method: 'tools/list' }, {});
  assert.equal('$schema' in out.tools[0].inputSchema, false);
  // additionalProperties остаётся намеренно: он запрещает модели придумывать параметры.
  assert.equal(out.tools[0].inputSchema.additionalProperties, false);
  assert.equal('properties' in out.tools[1].inputSchema, false, 'пустые properties ни о чём не говорят');
  assert.equal('required' in out.tools[1].inputSchema, false);
});

test('список инструментов считается один раз', async () => {
  let built = 0;
  const { mcp, handlers } = fakeServer({
    onList: async () => {
      built += 1;
      return { tools: [{ name: 'a', inputSchema: { type: 'object' } }] };
    },
  });
  installProtocolPatches(mcp);

  const first = await handlers.get('tools/list')({ method: 'tools/list' }, {});
  const second = await handlers.get('tools/list')({ method: 'tools/list' }, {});
  assert.equal(built, 1, 'zod в JSON Schema сворачивается один раз, а не на каждый запрос');
  assert.equal(first, second);
});
