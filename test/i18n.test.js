/**
 * Выбор языка описаний.
 *
 * Автоопределение здесь ненадёжно по существу: в контейнере LANG обычно C.UTF-8 или пусто, и
 * о языке задачи это не говорит ничего. Поэтому проверяется не «угадывает», а «предсказуемо»:
 * явная переменная всегда сильнее окружения, а неизвестное значение не превращает описания
 * в пустоту.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, langInfo, t } from '../src/i18n.js';

test('LT_LANG сильнее локали окружения', () => {
  assert.equal(detectLang({ LT_LANG: 'en', LANG: 'ru_RU.UTF-8' }), 'en');
  assert.equal(detectLang({ LT_LANG: 'ru', LANG: 'en_US.UTF-8' }), 'ru');
});

test('без LT_LANG смотрим на локаль', () => {
  assert.equal(detectLang({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(detectLang({ LC_ALL: 'ru_RU.UTF-8' }), 'ru');
});

/* Ровно тот случай, ради которого нужна явная переменная: типичное окружение контейнера. */
test('C.UTF-8 и пустое окружение дают язык проекта', () => {
  assert.equal(detectLang({ LANG: 'C.UTF-8' }), 'ru');
  assert.equal(detectLang({}), 'ru');
});

test('неизвестное значение LT_LANG не ломает выбор', () => {
  assert.equal(detectLang({ LT_LANG: 'кириллица' }), 'ru');
  assert.equal(detectLang({ LT_LANG: 'de', LANG: 'en_US.UTF-8' }), 'en');
});

test('auto просит посмотреть на окружение', () => {
  assert.equal(detectLang({ LT_LANG: 'auto', LANG: 'en_GB.UTF-8' }), 'en');
  assert.equal(detectLang({ LT_LANG: 'auto', LANG: 'C' }), 'ru');
});

test('строка без вариантов проходит насквозь', () => {
  assert.equal(t('как есть'), 'как есть');
});

test('выбор варианта по языку', () => {
  assert.equal(t({ ru: 'русский', en: 'english' }, 'en'), 'english');
  assert.equal(t({ ru: 'русский', en: 'english' }, 'ru'), 'русский');
});

/* Недостающий перевод обязан отдать хоть что-то: пустое описание инструмента — это инструмент,
   которого агент не увидит вовсе. */
test('недостающий перевод подменяется, а не пустеет', () => {
  assert.equal(t({ ru: 'только русский' }, 'en'), 'только русский');
  assert.equal(t({ en: 'only english' }, 'ru'), 'only english');
  assert.equal(t({}, 'ru'), '');
});

test('stand_info объясняет, откуда взялся язык', () => {
  assert.equal(langInfo({ LT_LANG: 'en' }).source, 'LT_LANG');
  assert.equal(langInfo({ LANG: 'ru_RU.UTF-8' }).source, 'LANG');
  assert.equal(langInfo({}).source, 'по умолчанию');
  assert.deepEqual(langInfo({}).supported, ['ru', 'en']);
});
