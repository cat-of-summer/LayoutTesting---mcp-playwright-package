/**
 * Сводка прогона и вердикт. Браузер не нужен: summarize — чистая функция над результатами.
 *
 * Проверяется главное свойство вердикта: найденное проверкой обязано в него попадать.
 * Молчаливый пропуск здесь дороже ложной тревоги — прогон рапортует «чисто», и дальше
 * никто не смотрит.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarize } from '../src/audit.js';

test('чистый прогон помечен флагом, а не только формулировкой', () => {
  const s = summarize({});

  assert.equal(s.clean, true);
  assert.equal(s.verdict, 'проблем не найдено');
});

test('нарушения pa11y попадают в вердикт', () => {
  const s = summarize({ pa11y: { byType: { error: 3 } } });

  assert.equal(s.pa11yErrors, 3);
  assert.equal(s.clean, false, 'прогон с одним лишь pa11y не должен считаться чистым');
  assert.match(s.verdict, /pa11y: 3/);
});

test('каждая проверка со своей находкой делает прогон нечистым', () => {
  const cases = [
    ['layout', { layout: { total: 2 } }, /эвристики вёрстки: 2/],
    ['axe', { axe: { total: 1 } }, /axe: 1/],
    ['html', { html: { byType: { error: 4 } } }, /невалидный HTML: 4/],
    ['seo', { lighthouse: { scores: { seo: 60 } } }, /Lighthouse SEO 60/],
    ['vitals', { vitals: { cls: 0.42 } }, /CLS 0\.42/],
    ['visual', { visual: { status: 'diff', diffPercentage: 1.5 } }, /визуальное расхождение 1\.5%/],
    ['logs', { logs: { errors: [{}], failedRequests: [] } }, /ошибок JS: 1/],
  ];

  for (const [label, results, pattern] of cases) {
    const s = summarize(results);
    assert.equal(s.clean, false, `${label}: находка обязана делать прогон нечистым`);
    assert.match(s.verdict, pattern, label);
  }
});

test('горизонтальный скролл виден в вердикте отдельно от прочих эвристик', () => {
  const s = summarize({ layout: { total: 1, issues: { documentOverflow: { overflowBy: 560 } } } });

  assert.equal(s.documentOverflow, true);
  assert.match(s.verdict, /горизонтальный скролл/);
});

test('ошибка самой проверки не теряется', () => {
  const s = summarize({}, { lighthouse: 'не запустился' });

  assert.deepEqual(s.checkErrors, ['lighthouse']);
});

/*
 * Оценка SEO считалась Lighthouse на каждом прогоне и терялась по дороге: в сводку поднимался
 * только performance, и страница с SEO 60 рапортовала «проблем не найдено». Случай закреплён
 * отдельно от таблицы, потому что проверяет не строку в вердикте, а то, что число вообще
 * доехало до сводки.
 */
test('оценка SEO из Lighthouse доезжает до сводки', () => {
  const s = summarize({ lighthouse: { scores: { performance: 95, seo: 82 } } });

  assert.equal(s.performanceScore, 95);
  assert.equal(s.seoScore, 82);
});

test('высокая оценка SEO не портит вердикт', () => {
  const s = summarize({ lighthouse: { scores: { seo: 95 } } });

  assert.equal(s.clean, true);
});

/* Неиндексируемость — не «одна из находок», а причина, по которой остальные находки не важны. */
test('причины неиндексируемости попадают в вердикт целиком', () => {
  const s = summarize({ seo: { indexable: false, reasons: ['noindex в robots-мете', 'статус ответа 404'] } });

  assert.equal(s.notIndexable, true);
  assert.equal(s.clean, false);
  assert.match(s.verdict, /noindex в robots-мете, статус ответа 404/);
});
