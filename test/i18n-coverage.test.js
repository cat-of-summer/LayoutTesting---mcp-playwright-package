/**
 * Полнота перевода описаний.
 *
 * Проверка идёт по исходникам, а не по поднятому серверу: поднять его — значит притащить sharp,
 * playwright и весь нативный слой ради вопроса, на который отвечает текст файла.
 *
 * Ловит она ровно один сценарий, зато неизбежный: кто-то добавляет инструмент, пишет описание
 * по-русски и на этом останавливается. Сервер при этом работает, тесты зелёные, а в английском
 * режиме у инструмента описание оказывается русским — и агент, работающий по-английски,
 * выбирает его хуже остальных. Заметить это можно только сравнив сорок описаний подряд.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const FILES = ['server.js', 'tools/crawl.js'];

async function toolBlocks(file) {
  const src = await readFile(path.join(SRC, file), 'utf8');
  const names = [...src.matchAll(/registerTool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  return names.map((name) => {
    const start = src.indexOf(`'${name}',`);
    const stop = src.indexOf('inputSchema:', start);
    return { name, file, block: src.slice(start, stop === -1 ? start + 2000 : stop) };
  });
}

const blocks = (await Promise.all(FILES.map(toolBlocks))).flat();

test('инструменты вообще нашлись — иначе тест проверяет пустоту', () => {
  assert.ok(blocks.length >= 40, `найдено всего ${blocks.length} инструментов`);
});

test('у каждого инструмента заголовок и описание на обоих языках', () => {
  const broken = [];
  for (const { name, file, block } of blocks) {
    /* Подстрокой, а не регулярным выражением: `t({` пришлось бы экранировать, и ошибка в
       экранировании даёт не ложную находку, а нерабочую проверку. */
    for (const field of ['title', 'description']) {
      if (!block.includes(`${field}: t({`)) broken.push(`${file}: ${name} — ${field} не переведён`);
    }
    if (!/en:\s*['"`]/.test(block)) broken.push(`${file}: ${name} — нет английского текста`);
    if (!/ru:\s*['"`]/.test(block)) broken.push(`${file}: ${name} — нет русского текста`);
  }
  assert.deepEqual(broken, [], `непереведённое:\n${broken.join('\n')}`);
});

/* Пустая строка проходит все проверки на существование и при этом означает инструмент,
   которого агент не увидит. */
test('ни один перевод не пуст', () => {
  const empty = [];
  for (const { name, file, block } of blocks) {
    for (const m of block.matchAll(/(ru|en):\s*(['"`])\s*\2/g)) {
      empty.push(`${file}: ${name} — пустой ${m[1]}`);
    }
  }
  assert.deepEqual(empty, []);
});

/* Описание в пару слов не помогает выбрать инструмент: по нему не понять, когда он нужен. */
test('английские описания не выродились в заглушки', () => {
  const short = [];
  for (const { name, file, block } of blocks) {
    const desc = /description: t\(\{[\s\S]*?en:\s*(['"`])([\s\S]*?)\1/.exec(block);
    if (desc && desc[2].length < 80) short.push(`${file}: ${name} — ${desc[2].length} символов`);
  }
  assert.deepEqual(short, [], `слишком короткие английские описания:\n${short.join('\n')}`);
});
