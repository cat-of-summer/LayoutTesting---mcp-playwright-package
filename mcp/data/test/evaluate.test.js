import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapExpression, wrapBody } from '../src/browser/evaluate.js';

/**
 * Регрессия: раньше режим выбирался по подстроке `return` в исходнике, и любое
 * выражение, где это слово встречалось внутри, объявлялось телом функции.
 * Тело без верхнеуровневого return отдавало undefined, а вызов — пустой ответ.
 */
const evaluateLike = (src) => {
  // Тот же порядок, что в evaluateOnPage: сначала выражение, при синтаксической
  // ошибке — тело. new Function здесь только ради проверки разбора.
  try {
    // eslint-disable-next-line no-new-func
    return { mode: 'expression', fn: new Function(`return ${wrapExpression(src)}`) };
  } catch {
    // eslint-disable-next-line no-new-func
    return { mode: 'body', fn: new Function(`return ${wrapBody(src)}`) };
  }
};

test('простое выражение разбирается как выражение и возвращает значение', async () => {
  const { mode, fn } = evaluateLike('1 + 1');
  assert.equal(mode, 'expression');
  assert.equal(await fn(), 2);
});

test('выражение со словом return внутри колбэка не считается телом', async () => {
  const src = "['a','b'].map(function (p) { return p + '!' }).join(',')";
  const { mode, fn } = evaluateLike(src);
  assert.equal(mode, 'expression');
  assert.equal(await fn(), 'a!,b!');
});

test('IIFE со словом return возвращает значение, а не undefined', async () => {
  const { mode, fn } = evaluateLike('(function () { return 42 })()');
  assert.equal(mode, 'expression');
  assert.equal(await fn(), 42);
});

test('слово return внутри строки не сбивает разбор', async () => {
  const { mode, fn } = evaluateLike("'.return-btn'.length");
  assert.equal(mode, 'expression');
  assert.equal(await fn(), 11);
});

test('несколько инструкций разбираются как тело функции', async () => {
  const { mode, fn } = evaluateLike('const x = 2; const y = 3; return x * y;');
  assert.equal(mode, 'body');
  assert.equal(await fn(), 6);
});

test('литерал объекта читается как объект, а не как блок', async () => {
  const { mode, fn } = evaluateLike('{ a: 1 }');
  assert.equal(mode, 'expression');
  assert.deepEqual(await fn(), { a: 1 });
});

test('обёртки не ломают асинхронный код', async () => {
  const { fn } = evaluateLike('Promise.resolve(7)');
  assert.equal(await fn(), 7);
});
