/**
 * Сводный разбор сайта.
 *
 * Архив собирается руками, а не обходом: обход сюда притащил бы сеть, браузер и десятки секунд,
 * а проверять надо чистую логику над индексом. Зато индекс можно собрать таким, какого в жизни
 * пришлось бы долго искать: с невзаимным hreflang, с canonical на битую страницу, с сиротой.
 *
 * Отдельно закреплено то, что легче всего потерять при правках: «не проверено» обязано остаться
 * отдельной категорией. Отчёт, молча выдающий непройденное за исправное, хуже отсутствующего.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditSite, verdictOf } from '../src/seo/site.js';
import { removeSite, siteDir, writeIndex, writeFrontier, writeSite } from '../src/crawl/store.js';

const SITE_ID = 'lt-seo-site-test';
const HOST = 'https://example.test';

const page = (url, extra = {}) => [
  `${HOST}${url}`,
  {
    pageId: Buffer.from(url).toString('hex').slice(0, 16),
    depth: 1,
    status: 200,
    title: 'Заголовок',
    description: 'Описание',
    h1: 'H1',
    words: 500,
    indexable: true,
    reasons: [],
    canonical: `${HOST}${url}`,
    canonicalSelf: true,
    contentHash: 'hash-' + url,
    links: [],
    alternates: [],
    images: { total: 2, noAlt: 0 },
    redirected: false,
    finalUrl: `${HOST}${url}`,
    ...extra,
  },
];

async function seed(pages, frontier = {}) {
  await writeSite(SITE_ID, { url: `${HOST}/`, status: 'done', config: {} });
  await writeIndex(SITE_ID, { pages: Object.fromEntries(pages) });
  await writeFrontier(SITE_ID, { pending: [], done: [], failed: [], skipped: {}, seen: [], ...frontier });
}

const run = () => auditSite(SITE_ID, { verify: false });

test('дубли находятся по заголовку, описанию и содержимому', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/', { links: [`${HOST}/a`, `${HOST}/b`] }),
    page('/a', { title: 'Одинаковый', contentHash: 'same' }),
    page('/b', { title: 'Одинаковый', contentHash: 'same' }),
  ]);

  const { findings } = await run();
  assert.equal(findings.duplicateTitles.length, 1);
  assert.equal(findings.duplicateTitles[0].count, 2);
  assert.equal(findings.duplicateContent.length, 1);
  /* Заголовок «Заголовок» встречается один раз — одиночки в дубли не попадают. */
  assert.ok(!findings.duplicateTitles.some((g) => g.value === 'Заголовок'));
});

test('битая ссылка показывает, откуда на неё ведут', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/', { links: [`${HOST}/gone`] }),
    page('/gone', { status: 404 }),
  ]);

  const { findings } = await run();
  assert.equal(findings.brokenLinks.length, 1);
  assert.equal(findings.brokenLinks[0].status, 404);
  /* Без источника находка бесполезна: непонятно, где чинить. */
  assert.deepEqual(findings.brokenLinks[0].linkedFrom, [`${HOST}/`]);
});

test('сирота — страница без входящих ссылок, стартовая не в счёт', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/', { links: [`${HOST}/a`] }),
    page('/a'),
    page('/orphan'),
  ]);

  const { findings } = await run();
  assert.deepEqual(findings.orphans, [`${HOST}/orphan`]);
});

/* Граф считается по исходящим ссылкам, а не по полю from: from хранит только первый найденный
   путь, а входящих связей может быть сколько угодно — именно их число отвечает на вопрос
   «что недолинковано». */
test('входящие связи считаются по всем ссылающимся страницам', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/', { links: [`${HOST}/a`] }),
    page('/b', { links: [`${HOST}/a`] }),
    page('/c', { links: [`${HOST}/a`] }),
    page('/a', { from: `${HOST}/` }),
  ]);

  const { findings } = await run();
  assert.equal(findings.orphans.length, 2, 'на /b и /c никто не ссылается');
  assert.ok(!findings.poorlyLinked.some((p) => p.url === `${HOST}/a`), 'на /a ведут три ссылки');
});

test('canonical на страницу с ошибкой и на чужой хост различаются', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/', { links: [`${HOST}/a`, `${HOST}/b`] }),
    page('/a', { canonical: `${HOST}/gone`, canonicalSelf: false }),
    page('/b', { canonical: 'https://other.test/x', canonicalSelf: false }),
    page('/gone', { status: 404 }),
  ]);

  const { findings } = await run();
  const issues = findings.canonical.map((c) => c.issue);
  assert.ok(issues.some((i) => /статусом 404/.test(i)), `нет находки про 404: ${issues.join(' | ')}`);
  assert.ok(issues.some((i) => /другой хост/.test(i)), `нет находки про чужой хост: ${issues.join(' | ')}`);
});

const ru = { hreflang: 'ru', href: `${HOST}/ru` };
const en = { hreflang: 'en', href: `${HOST}/en` };
const xDefault = { hreflang: 'x-default', href: `${HOST}/ru` };

test('односторонний hreflang находится', async (t) => {
  t.after(() => removeSite(SITE_ID));
  /* /ru объявляет /en альтернативой, а /en про /ru не знает вовсе. Поисковик такую пару
     игнорирует целиком — то есть работы как будто и не было. */
  await seed([
    page('/ru', { alternates: [ru, en, xDefault] }),
    page('/en', { alternates: [en] }),
  ]);

  const { findings } = await run();
  assert.ok(
    findings.hreflang.some((h) => h.url === `${HOST}/ru` && /не ссылается обратно/.test(h.issue)),
    `нет находки про односторонность: ${JSON.stringify(findings.hreflang)}`,
  );
  assert.ok(findings.hreflang.some((h) => h.url === `${HOST}/en` && /x-default/.test(h.issue)));
});

/*
 * Обратной ссылкой считается любая альтернатива, ведущая назад, в том числе x-default: для
 * поисковика важно наличие возвратной ссылки, а не совпадение языкового кода. Случай стоит
 * отдельно, потому что «ужесточить» проверку до совпадения языков — очень соблазнительная
 * правка, дающая поток ложных находок на каждом двуязычном сайте.
 */
test('взаимный набор не даёт находок, x-default засчитывается за обратную ссылку', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/ru', { alternates: [ru, en, xDefault] }),
    page('/en', { alternates: [ru, en, xDefault] }),
  ]);

  const { findings } = await run();
  assert.deepEqual(findings.hreflang, [], 'взаимный hreflang не должен давать находок');
});

test('«не проверено» разложено по причинам и не смешано с находками', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed(
    [page('/', { links: [] })],
    {
      pending: [{ url: `${HOST}/deep`, depth: 6 }],
      skipped: { [`${HOST}/admin`]: { reason: 'запрещено в robots.txt', from: `${HOST}/` } },
      failed: [{ url: `${HOST}/timeout`, error: 'таймаут' }],
    },
  );

  const report = await run();
  const nc = report.findings.notChecked;

  assert.equal(nc.blockedByRobots.length, 1);
  assert.equal(nc.blockedByRobots[0].linkedFrom, `${HOST}/`);
  assert.equal(nc.beyondLimits, 1, 'упёршееся в лимит считается отдельно от запрещённого');
  assert.equal(nc.failed.length, 1);

  /* Ни одно из трёх не должно оказаться среди битых ссылок: это разные диагнозы. */
  assert.equal(report.findings.brokenLinks.length, 0);
});

test('охват указан рядом с вердиктом, а не в примечаниях', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([page('/')], { pending: [{ url: `${HOST}/x`, depth: 9 }] });

  const verdict = verdictOf(await run());
  assert.equal(verdict.clean, true);
  assert.match(verdict.verdict, /проблем не найдено/);
  /* «Проблем не найдено» по половине сайта — не то же самое, что по всему сайту. */
  assert.match(verdict.coverage, /не пройдено 1/);
});

test('чистый сайт даёт чистый вердикт', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/', { links: [`${HOST}/a`] }),
    page('/a', { title: 'Другой', contentHash: 'other' }),
  ]);

  const verdict = verdictOf(await run());
  assert.equal(verdict.clean, true);
  assert.match(verdict.coverage, /проверено 2 страниц/);
});

test('пустой архив отвергается внятно, а не отдаёт пустой отчёт', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([]);
  await assert.rejects(run, /нет страниц/);
});

test('отчёт по несуществующему обходу говорит об этом, а не падает внутри', async () => {
  await assert.rejects(() => auditSite('нет-такого-обхода', { verify: false }), /не найден/);
});

test('тонкое содержимое и отсутствующие поля попадают в находки', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([
    page('/', { links: [`${HOST}/thin`, `${HOST}/bare`] }),
    page('/thin', { words: 40, title: 'Тонкая', contentHash: 'thin' }),
    page('/bare', { title: null, description: null, h1: null, contentHash: 'bare', images: { total: 3, noAlt: 3 } }),
  ]);

  const { findings } = await run();
  assert.equal(findings.thinContent[0].url, `${HOST}/thin`);
  assert.deepEqual(findings.missing.title, [`${HOST}/bare`]);
  assert.deepEqual(findings.missing.h1, [`${HOST}/bare`]);
  assert.equal(findings.imagesWithoutAlt[0].noAlt, 3);
});

test('отчёт складывается в каталог обхода, а не в артефакты с их автоочисткой', async (t) => {
  t.after(() => removeSite(SITE_ID));
  await seed([page('/')]);
  const dir = siteDir(SITE_ID);
  assert.ok(await fs.stat(path.join(dir, 'index.json')).then(() => true));
  assert.ok(!dir.includes(`${path.sep}artifacts${path.sep}`));
});
