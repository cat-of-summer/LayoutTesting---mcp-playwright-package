/**
 * Манифест инструментов: собирается ли он вообще и сколько стоит.
 *
 * Нужен полный набор зависимостей — сервер тянет sharp, playwright и linkedom, — поэтому
 * по умолчанию пропускается, как и браузерные тесты:
 *
 *   LT_FULL_TESTS=1 npm test
 *
 * Браузер при этом не запускается: tools/list до обработчиков не доходит.
 *
 * Зачем он есть. Слой инструментов не был покрыт ничем: единственная проверка разбирала
 * исходники регулярками и по построению не могла заметить, что модуль не загружается. Так и
 * случилось — вызов t() без импорта уронил бы весь сервер, а тесты остались зелёными.
 * Здесь сервер поднимается по-настоящему и отвечает по JSON-RPC, так что любая ошибка на
 * загрузке модуля или незаворачиваемая в JSON Schema zod-схема видна сразу.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.LT_FULL_TESTS === '1';
const options = { skip: enabled ? false : 'нужен LT_FULL_TESTS=1 и полный npm ci' };

/*
 * Бюджет манифеста в символах.
 *
 * Манифест платится при каждом подключении агента, целиком, до первого полезного действия.
 * Число здесь не идеал, а замер: 46 555 на 2026-09-08, после переезда условий просмотра в
 * именованные профили (было 53 456 при 42 инструментах). Смысл не в том, чтобы держать эту
 * величину, а в том, чтобы её рост был виден в diff, а не через полгода в счёте за контекст.
 */
const BUDGET = { total: 48000, perToolSchema: 2300, tools: 43 };

/*
 * Инструменты, где схема кратно тяжелее описания, и это не дефект.
 *
 * browser_open — единственное место, где полный набор условий просмотра и должен быть
 * объявлен: он сессию и открывает. Раньше тот же блок лежал ещё в пяти инструментах, и в
 * списке было семь имён вместо двух.
 *
 * matrix_run описывает девять осей перебора: схема у него заведомо длиннее любого разумного
 * описания. Здесь это принято, а не забыто.
 */
const KNOWN_SKEW = new Set(['browser_open', 'matrix_run']);

let tools = null;
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
  const client = new Client({ name: 'manifest-test', version: '1' });
  await client.connect(clientSide);
  ({ tools } = await client.listTools());
});

test.after(async () => {
  if (closeAll) await closeAll();
});

test('сервер поднимается и отдаёт список инструментов', options, () => {
  assert.ok(Array.isArray(tools), 'tools/list должен вернуть массив');
  assert.equal(tools.length, BUDGET.tools, 'число инструментов изменилось — поправьте BUDGET.tools осознанно');
});

test('у каждого инструмента есть имя, заголовок и описание', options, () => {
  const broken = tools
    .filter((t) => !t.name || !t.title || !t.description)
    .map((t) => t.name || '(без имени)');
  assert.deepEqual(broken, [], 'без описания инструмент не выбирают: модель читает его до вызова');
});

test('схема каждого инструмента разворачивается в JSON Schema', options, () => {
  for (const tool of tools) {
    assert.equal(typeof tool.inputSchema, 'object', `${tool.name}: схема не собралась`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name}: схема не объект`);
  }
});

test('манифест укладывается в бюджет', options, () => {
  const size = JSON.stringify(tools).length;
  const worst = [...tools]
    .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)
    .slice(0, 5)
    .map((t) => `${t.name} ${JSON.stringify(t).length}`)
    .join(', ');
  assert.ok(
    size <= BUDGET.total,
    `манифест вырос до ${size} при бюджете ${BUDGET.total}. Самые тяжёлые: ${worst}`,
  );
});

test('ни одна схема не занимает больше своей доли', options, () => {
  const fat = tools
    .map((t) => [t.name, JSON.stringify(t.inputSchema).length])
    .filter(([, size]) => size > BUDGET.perToolSchema);
  assert.deepEqual(fat, [], `схема инструмента превысила ${BUDGET.perToolSchema} символов`);
});

test('описание не тонет в схеме', options, () => {
  const skewed = tools
    .filter((t) => {
      const schema = JSON.stringify(t.inputSchema).length;
      const desc = (t.description || '').length;
      return schema > 800 && schema / Math.max(desc, 1) > 6;
    })
    .map((t) => t.name)
    .filter((name) => !KNOWN_SKEW.has(name));
  assert.deepEqual(
    skewed,
    [],
    'у этих инструментов схема кратно тяжелее описания: модель платит за параметры, ' +
      'ещё не поняв, зачем инструмент нужен',
  );
});
