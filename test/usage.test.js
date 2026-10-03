/**
 * Журнал использования: маскировка, выжимка ответа, запись на диск, сводка.
 *
 * Браузер не нужен: журнал пишется во временный каталог, вызовы подставляются поддельные.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactArgs, MAX_STRING } from '../src/usage/redact.js';
import { createUsageLog, summarizeResult, usageLogged } from '../src/usage/log.js';
import { buildUsageReport, formatUsageReport, normalizeError, readUsageDir } from '../src/usage/report.js';
import { installProtocolPatches } from '../src/protocol.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lt-usage-'));
const lines = (dir) =>
  fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n'))
    .map((line) => JSON.parse(line));

test('маскировка: доступы, заголовки, куки, ввод в формы, логин в адресе', () => {
  const out = redactArgs('browser_open', {
    url: 'https://user:hunter2@site.local/path',
    auth: 'user:hunter2',
    extraHTTPHeaders: { Authorization: 'Bearer abc', 'Accept-Language': 'ru' },
    storageState: 'figma-editor',
    viewport: 'mobile',
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('Bearer abc'));
  assert.equal(out.url, 'https://[скрыто]@site.local/path');
  assert.equal(out.viewport, 'mobile', 'обычные параметры пишутся как есть');
  assert.deepEqual(Object.keys(out.extraHTTPHeaders), ['Authorization', 'Accept-Language'], 'имена заголовков остаются');

  const act = redactArgs('browser_act', { sessionId: 's', action: 'fill', selector: '#pass', value: 'секрет' });
  assert.equal(act.value, '[скрыто: 6 симв.]');
  assert.equal(act.selector, '#pass');
  assert.equal(redactArgs('browser_act', { action: 'press', value: 'Enter' }).value, 'Enter', 'клавиша — не секрет');

  const states = redactArgs('layout_audit', { states: [{ name: 'login', steps: [{ action: 'type', selector: '#p', value: 'секрет' }] }] });
  assert.ok(!JSON.stringify(states).includes('секрет'), 'шаги внутри проверок тоже маскируются');

  assert.ok(!JSON.stringify(redactArgs('browser_storage', { action: 'set', scope: 'cookies', value: '[{"name":"sid"}]' })).includes('sid'));
  assert.ok(!JSON.stringify(redactArgs('form_audit', { values: { '#email': 'me@example.com' } })).includes('example'));

  const long = redactArgs('browser_eval', { expression: 'x'.repeat(MAX_STRING + 100) });
  assert.ok(long.expression.length < MAX_STRING + 100);
  assert.match(long.expression, /обрезано/);
});

test('выжимка ответа: форма JSON и размеры картинок без данных', () => {
  const summary = summarizeResult({
    content: [
      { type: 'text', text: JSON.stringify({ issues: [1, 2, 3], truncated: true, url: 'http://a/', hint: 'сузьте селектор' }) },
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(400) },
      { type: 'resource_link', uri: 'lt://artifacts/x.png' },
      { type: 'text', text: 'Условия просмотра переехали' },
    ],
  });
  assert.deepEqual(summary.shape.arrays, { issues: 3 });
  assert.equal(summary.shape.scalars.truncated, true);
  assert.equal(summary.shape.hint, 'сузьте селектор');
  assert.deepEqual(summary.images, [{ mime: 'image/png', bytes: 300 }]);
  assert.equal(summary.blocks.resource_link, 1);
  assert.deepEqual(summary.notes, ['Условия просмотра переехали']);
  assert.ok(!JSON.stringify(summary).includes('AAAA'), 'base64 не пишется');
});

test('запись: вызов, ошибка, выключатель и отказ диска не ломают вызов', async () => {
  const dir = tmp();
  let on = true;
  const log = createUsageLog({ dir, enabled: () => on });
  const ctx = { toolset: 'all', standVersion: '1.2.3', client: () => ({ name: 'claude-code', version: '2.0' }) };

  const ok = await usageLogged(ctx, { params: { name: 'audit', arguments: { url: 'http://x/', auth: 'a:b' } } }, { sessionId: 'S1', requestId: 7 }, async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }), { log });
  assert.deepEqual(ok.content[0].text, '{"ok":true}', 'результат проходит без изменений');
  await usageLogged(ctx, { params: { name: 'audit', arguments: { url: 1 } } }, { sessionId: 'S1' }, async () => ({ isError: true, content: [{ type: 'text', text: 'Invalid arguments: url expected string' }] }), { log, legacyKeys: ['zoom'] });
  await assert.rejects(usageLogged(ctx, { params: { name: 'x' } }, {}, async () => { throw new Error('упал'); }, { log }));

  const [first, second, third] = lines(dir);
  assert.equal(first.event, 'call');
  assert.equal(first.seq, 1);
  assert.equal(first.mcpSession, 'S1');
  assert.equal(first.standVersion, '1.2.3');
  assert.deepEqual(first.client, { name: 'claude-code', version: '2.0' });
  assert.ok(first.install, 'идентификатор установки');
  assert.ok(!JSON.stringify(first).includes('a:b'));
  assert.equal(second.outcome, 'error');
  assert.match(second.error, /url expected string/);
  assert.deepEqual(second.legacyKeys, ['zoom']);
  assert.equal(third.outcome, 'throw');
  assert.equal(lines(dir)[0].install, third.install, 'идентификатор установки один');

  on = false;
  await usageLogged(ctx, { params: { name: 'audit' } }, {}, async () => ({ content: [] }), { log });
  assert.equal(lines(dir).length, 3, 'выключенный журнал не пишет');

  const warnings = [];
  const blocked = path.join(dir, 'file-not-dir');
  fs.writeFileSync(blocked, '');
  const broken = createUsageLog({ dir: path.join(blocked, 'usage'), enabled: () => true, warn: (line) => warnings.push(line) });
  const result = await usageLogged(ctx, { params: { name: 'audit' } }, {}, async () => ({ content: [] }), { log: broken });
  assert.deepEqual(result, { content: [] });
  await usageLogged(ctx, { params: { name: 'audit' } }, {}, async () => ({ content: [] }), { log: broken });
  assert.equal(warnings.length, 1, 'одно предупреждение, дальше журнал молчит');
});

test('ротация удаляет файлы старше срока', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'usage-2020-01-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'usage-2026-09-30.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'чужое');
  const log = createUsageLog({ dir, enabled: () => true, keep: () => 30, now: () => new Date('2026-10-03T12:00:00Z') });
  log.record({ event: 'call', tool: 'audit' });
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['install.json', 'notes.txt', 'usage-2026-09-30.jsonl', 'usage-2026-10-03.jsonl']);
});

test('протокольный патч пишет вызовы, начало сессии и чтение ресурсов', async () => {
  const dir = tmp();
  const log = createUsageLog({ dir, enabled: () => true });
  const handlers = new Map([
    ['initialize', async () => ({ protocolVersion: '2025-06-18' })],
    ['tools/call', async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] })],
    ['resources/read', async () => ({ contents: [] })],
  ]);
  const server = {
    _requestHandlers: handlers,
    setRequestHandler(schema, fn) {
      handlers.set(schema.shape.method.value, fn);
    },
    getClientVersion: () => ({ name: 'cursor', version: '1' }),
  };
  installProtocolPatches({ server }, { toolset: 'seo', standVersion: '0.0.9', log });

  await handlers.get('initialize')({ params: { clientInfo: { name: 'cursor', version: '1' }, protocolVersion: '2025-06-18' } }, { sessionId: 'S' });
  await handlers.get('tools/call')({ params: { name: 'seo_page', arguments: { url: 'http://x/' } } }, { sessionId: 'S' });
  await handlers.get('resources/read')({ params: { uri: 'lt://guide/index' } }, { sessionId: 'S' });

  const records = lines(dir);
  assert.deepEqual(records.map((r) => r.event), ['session_open', 'call', 'resource']);
  assert.equal(records[1].toolset, 'seo');
  assert.equal(records[1].client.name, 'cursor');
  assert.equal(records[2].target, 'lt://guide/index');
});

test('сводка: ошибки, повторы, путь к help, неиспользуемое', () => {
  const at = (n) => new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString();
  const call = (n, tool, outcome = 'ok', extra = {}) => ({ v: 1, ts: at(n), install: 'I', mcpSession: 'S', event: 'call', tool, seq: n, outcome, durationMs: n * 10, args: { url: 'http://x/' }, ...extra });
  const records = [
    { v: 1, ts: at(0), install: 'I', mcpSession: 'S', event: 'session_open', client: { name: 'claude-code', version: '2' } },
    call(1, 'audit', 'error', { error: 'Invalid arguments: "zoom" expected number, got 150' }),
    call(2, 'audit', 'error', { error: 'Invalid arguments: "rtl" expected number, got 10' }),
    call(3, 'audit'),
    call(4, 'help'),
    call(5, 'screenshot'),
    call(6, 'screenshot'),
    call(7, 'screenshot'),
  ];
  const report = buildUsageReport(records, {
    manifest: [
      { name: 'audit', params: ['url', 'checks'] },
      { name: 'screenshot', params: ['url'] },
      { name: 'lighthouse', params: ['url'] },
    ],
  });
  assert.equal(report.overview.calls, 7);
  assert.equal(report.overview.clients['claude-code 2'], 1);
  const audit = report.tools.find((t) => t.tool === 'audit');
  assert.equal(audit.errors, 2);
  assert.equal(report.errors[0].top[0].count, 2, 'одинаковые по сути ошибки сведены');
  assert.deepEqual(report.retries, [{ tool: 'audit', count: 2, fixed: 1 }]);
  assert.deepEqual(report.beforeHelp, [{ tool: 'audit', count: 1 }]);
  assert.deepEqual(report.streaks, [{ tool: 'audit', count: 1 }, { tool: 'screenshot', count: 1 }]);
  assert.deepEqual(report.unusedTools, ['lighthouse']);
  assert.deepEqual(report.unusedParams, [{ tool: 'audit', params: ['checks'] }]);
  assert.match(formatUsageReport(report), /Повтор после ошибки/);
});

test('сведение папок и оборванная строка', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'alice'));
  fs.mkdirSync(path.join(dir, 'bob'));
  fs.writeFileSync(path.join(dir, 'alice', 'usage-2026-10-01.jsonl'), '{"event":"call","install":"A"}\n');
  fs.writeFileSync(path.join(dir, 'bob', 'usage-2026-10-01.jsonl'), '{"event":"call","install":"B"}\n{"event":"ca');
  const { records, skipped } = readUsageDir(dir);
  assert.equal(records.length, 2);
  assert.equal(skipped, 1);
  assert.equal(normalizeError('Нет элемента "#a .b" на http://x/1 за 3000 мс'), 'Нет элемента <str> на <url> за <n> мс');
});
