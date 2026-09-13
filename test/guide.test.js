/**
 * Регламент вёрстки по макету: целостность текста и его единственность.
 *
 * Проверка идёт по файлам, без поднятого сервера: вопрос здесь не про протокол, а про то, что
 * текст на месте, одинаков в двух языках и не завёлся второй копией в коде. Последнее и есть
 * главное: правила разбора макета уже жили в четырёх местах сразу, все четыре были пересказами
 * друг друга и расходились. Ради этого регламент и переехал в файлы — и сторожить надо именно
 * то, чтобы пересказ не отрос обратно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ORDER, list, read } from '../src/guide.js';

const ROOT = path.resolve(import.meta.dirname, '../guide');
const LANGS = ['ru', 'en'];

test('список разделов и каталоги совпадают на обоих языках', async () => {
  for (const lang of LANGS) {
    const files = (await fs.readdir(path.join(ROOT, lang)))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, ''))
      .sort();
    assert.deepEqual(files, [...ORDER].sort(), `${lang}: каталог разошёлся с ORDER`);
  }
});

test('у каждого раздела есть заголовок и аннотация', async () => {
  const sections = await list();
  assert.equal(sections.length, ORDER.length);
  for (const section of sections) {
    assert.ok(section.title, `${section.section}: нет заголовка`);
    assert.ok(section.about && section.about.length > 10, `${section.section}: нет аннотации`);
    /* Аннотация идёт в перечни разделов — заголовок, продублированный туда, их обесценивает. */
    assert.notEqual(section.about, section.title, `${section.section}: аннотация повторяет заголовок`);
  }
});

test('ни один раздел не пуст ни на одном языке', async () => {
  for (const lang of LANGS) {
    for (const slug of ORDER) {
      const text = await fs.readFile(path.join(ROOT, lang, `${slug}.md`), 'utf8');
      assert.ok(text.trim().length > 300, `${lang}/${slug}: ${text.trim().length} символов — это заглушка`);
      assert.match(text, /^# /, `${lang}/${slug}: первая строка должна быть заголовком`);
    }
  }
});

test('слаг не выпускает за пределы каталога', async () => {
  for (const bad of ['../i18n', '../../package.json', '/etc/passwd', '', 'нет-такого']) {
    assert.equal(await read(bad), null, `${bad} не должен читаться`);
  }
});

/*
 * Сторож единственности. Тема figma у help — входная точка: десять правил и карта разделов.
 * Если она снова начнёт пересказывать фазы, длина выдаст это раньше, чем пересказ разойдётся
 * с регламентом.
 */
test('тема figma осталась входной точкой, а не пересказом регламента', async () => {
  const src = await fs.readFile(path.resolve(import.meta.dirname, '../src/tools/help.js'), 'utf8');
  const start = src.indexOf('const FIGMA_TOPIC');
  const end = src.indexOf('Object.assign(TOPICS', start);
  const block = src.slice(start, end);

  assert.ok(block.includes('guide:'), 'тема обязана вести в регламент');
  assert.ok(
    block.length < 6000,
    `тема figma разрослась до ${block.length} символов — похоже, в неё снова переехал пересказ фаз. Место такому тексту в guide/, а не здесь.`,
  );
});

/*
 * Единственное, что агент читает гарантированно, — это instructions: их клиент показывает модели
 * при подключении. Всё остальное требует, чтобы агент сам догадался вызвать help.
 *
 * Первая версия регламента этот путь не закрывала: рамка вела в промпт figma-layout, а промпт
 * модель сама вызвать не может — его тело клиент подтягивает, только когда сценарий выбрал
 * человек. То есть указатель существовал и вёл в тупик.
 */
test('рамка подключения ведёт в регламент, а не в промпт', async () => {
  const { buildInstructions } = await import('../src/tools/instructions.js');
  const { resolveSelection } = await import('../src/tools/groups.js');
  const text = buildInstructions(resolveSelection('design').groups);

  assert.match(text, /help\(guide: "index"\)/, 'вход в регламент должен стоять в самой рамке');
  assert.match(text, /help с guide: имя/, 'способ читать разделы должен быть назван');
  assert.ok(
    !/порядок целиком — промпт|whole order is in\s+the figma-layout prompt/.test(text),
    'рамка не должна отправлять модель в промпт: сама она его вызвать не может',
  );

  /* На выборке без figma пункт про макеты не появляется — и указатель в пустоту тоже. */
  const seo = buildInstructions(resolveSelection('seo+crawl').groups);
  assert.ok(!seo.includes('help(guide: "index")'), 'на подключении без figma регламент не рекламируется');
});

test('промпт figma-layout ведёт в регламент, а не повторяет его', async () => {
  const src = await fs.readFile(path.resolve(import.meta.dirname, '../src/tools/prompts.js'), 'utf8');
  const start = src.indexOf("'figma-layout'");
  const block = src.slice(start);
  assert.ok(block.includes('help(guide:'), 'промпт обязан вести в регламент');
  assert.ok(!/^\s*12\./m.test(block), 'двенадцать шагов вернулись в промпт — их место в guide/');
});
