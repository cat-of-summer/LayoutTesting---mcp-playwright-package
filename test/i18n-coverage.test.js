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

/**
 * Файлы с регистрациями.
 *
 * Список явный, а не собранный по маске: маска молча подхватила бы shared.js и instructions.js,
 * где инструментов нет, и проверка «нашлось ли хоть что-то» перестала бы что-либо значить.
 * Добавили группу — добавьте её сюда; забыли — упадёт первый же тест, он для этого и стоит.
 */
const GROUPS = [
  'session',
  'observe',
  'layout',
  'visual',
  'a11y',
  'perf',
  'seo',
  'static',
  'composite',
  'artifacts',
  'crawl',
  'figma',
  'help',
];
const FILES = GROUPS.map((g) => `tools/${g}.js`);

/**
 * Из текста исходника — в строку, какой она будет в рантайме.
 *
 * Ключ словаря — это значение строки, а не то, как она записана: в коде стоит '\\/' , а в
 * памяти живёт '\/'. Сравнивать исходный текст с ключом значит не найти совпадения там, где
 * оно есть, и объявить перевод пропущенным, а сам перевод — мёртвым. Ровно так этот тест
 * один раз и соврал.
 */
const unescape = (raw) => raw.replace(/\\(.)/g, '$1');

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

/*
 * Полнота словаря параметров.
 *
 * Описания параметров переводятся через словарь, а не по месту: одинаковый текст встречается в
 * нескольких инструментах, и пять копий одного перевода разъедутся на первой же правке.
 * Обратная сторона словаря — пропущенный ключ: d() тогда молча вернёт русскую строку, и в
 * английском режиме описание параметра окажется русским.
 */
test('каждая строка d() есть в словаре переводов', async () => {
  const { KNOWN } = await import('../src/i18n-params.js');
  const all = ['tools/shared.js', ...FILES];

  const missing = new Set();
  let seen = 0;
  for (const rel of all) {
    let src;
    try {
      src = await readFile(path.join(SRC, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/\bd\('([^']*)'\)/g)) {
      seen += 1;
      if (!(unescape(m[1]) in KNOWN)) missing.add(unescape(m[1]));
    }
  }

  assert.ok(seen > 100, `найдено всего ${seen} вызовов d() — проверка ничего не проверяет`);
  assert.deepEqual([...missing], [], `нет перевода для:\n${[...missing].join('\n')}`);
});

/* Словарь без единого лишнего ключа держать необязательно, но мёртвые записи копятся и мешают
   понять, что ещё нужно перевести. */
test('в словаре нет записей, которых больше нет в коде', async () => {
  const { KNOWN } = await import('../src/i18n-params.js');
  const used = new Set();
  for (const rel of ['tools/shared.js', ...FILES]) {
    let src;
    try {
      src = await readFile(path.join(SRC, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/\bd\('([^']*)'\)/g)) used.add(unescape(m[1]));
  }
  const dead = Object.keys(KNOWN).filter((k) => !used.has(k));
  assert.deepEqual(dead, [], `мёртвые записи словаря:\n${dead.join('\n')}`);
});
