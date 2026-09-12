/**
 * Разбор ссылок на Figma.
 *
 * Ошибка здесь стоит запроса из минутного лимита REST и возвращается как 404, по которому не
 * понять, что сломалась именно ссылка. Поэтому формы, которые реально копируют из браузера,
 * проверяются поимённо.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRefs, normalizeNodeId, parseFigmaRef, refOf } from '../src/figma/url.js';

test('ссылка design с node-id через дефис', () => {
  const ref = parseFigmaRef(
    'https://www.figma.com/design/gBFiSlx3sDctc1zizPYlFS/Zemsky-doctor?node-id=1033-12944&t=abc-1',
  );
  assert.deepEqual(ref, { fileKey: 'gBFiSlx3sDctc1zizPYlFS', nodeId: '1033:12944' });
});

test('ссылка на ветку отдаёт ключ ветки, а не основного файла', () => {
  const ref = parseFigmaRef('https://www.figma.com/design/MAINKEY12345/branch/BRANCHKEY678/Name?node-id=1-2');
  assert.equal(ref.fileKey, 'BRANCHKEY678');
  assert.equal(ref.mainFileKey, 'MAINKEY12345');
  assert.equal(ref.nodeId, '1:2');
});

test('id вложенного узла инстанса раскодируется целиком', () => {
  const ref = parseFigmaRef('https://www.figma.com/file/gBFiSlx3sDctc1zizPYlFS/x?node-id=I1062-14566%3B1062-14546');
  assert.equal(ref.nodeId, 'I1062:14566;1062:14546');
});

test('ссылка без node-id — файл целиком', () => {
  assert.equal(parseFigmaRef('https://figma.com/proto/gBFiSlx3sDctc1zizPYlFS/x').nodeId, null);
});

test('короткая запись ключ:id', () => {
  assert.deepEqual(parseFigmaRef('gBFiSlx3sDctc1zizPYlFS:1033:12944'), {
    fileKey: 'gBFiSlx3sDctc1zizPYlFS',
    nodeId: '1033:12944',
  });
  assert.equal(refOf('gBFiSlx3sDctc1zizPYlFS', '1033:12944'), 'gBFiSlx3sDctc1zizPYlFS:1033:12944');
});

test('чужой хост и мусор отвергаются понятной ошибкой', () => {
  assert.throws(() => parseFigmaRef('https://example.com/design/abc/x'), /не ссылка на Figma/);
  assert.throws(() => parseFigmaRef('https://www.figma.com/community/plugin/1'), /ключ файла/);
  assert.throws(() => normalizeNodeId('узел'), /id узла/);
  assert.throws(() => parseFigmaRef(''), /Пустая/);
});

test('узлы одного файла собираются в одно задание', () => {
  const groups = groupRefs([
    'https://www.figma.com/design/gBFiSlx3sDctc1zizPYlFS/x?node-id=1033-12944',
    'gBFiSlx3sDctc1zizPYlFS:1062:13919',
    'gBFiSlx3sDctc1zizPYlFS:1033:12944',
    'OTHERFILEKEY42:1:2',
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    fileKey: 'gBFiSlx3sDctc1zizPYlFS',
    nodeIds: ['1033:12944', '1062:13919'],
    wholeFile: false,
  });
});
