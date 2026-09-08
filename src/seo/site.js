/**
 * Сводный разбор сайта по архиву обхода.
 *
 * Здесь живут только те проверки, которых по одной странице не сделать: дубли, граф ссылок,
 * взаимность hreflang, сироты. Всё, что видно на отдельной странице, уже посчитано при обходе
 * и лежит в индексе — второй раз это не пересчитывается.
 *
 * Про честность выводов. Обход почти всегда неполон: сработал лимит страниц, лимит глубины,
 * запрет в robots.txt, sameOrigin отсёк поддомен. Поэтому «не проверено» здесь — отдельная
 * категория, а не разновидность «всё в порядке» и не разновидность «битое». Отчёт, который
 * молча выдаёт непройденное за исправное, хуже отсутствующего.
 */
import { normalizeUrl, sameHost } from '../crawl/url.js';
import { readFrontier, readIndex, readSite } from '../crawl/store.js';

/** Группы одинаковых значений, размером больше одного. Одиночки — норма, они только шумят. */
function duplicates(pages, pick) {
  const groups = new Map();
  for (const page of pages) {
    const key = pick(page);
    if (key === null || key === undefined || key === '') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page.url);
  }
  return [...groups.entries()]
    .filter(([, urls]) => urls.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([value, urls]) => ({ value: String(value).slice(0, 200), count: urls.length, urls: urls.slice(0, 20) }));
}

/**
 * Граф внутренних ссылок.
 *
 * Считается по сохранённым исходящим ссылкам, а не по полю from: from хранит только первый
 * найденный путь до страницы, а входящих связей у неё может быть сколько угодно, и именно их
 * количество отвечает на вопрос «что недолинковано».
 */
function buildGraph(pages) {
  const inbound = new Map();
  for (const page of pages) inbound.set(page.url, []);

  for (const page of pages) {
    for (const raw of page.links || []) {
      const target = normalizeUrl(raw);
      if (!inbound.has(target)) inbound.set(target, []);
      inbound.get(target).push(page.url);
    }
  }
  return inbound;
}

/**
 * Проверка адресов, до которых обход не дошёл.
 *
 * canonical и hreflang штатно указывают наружу периметра: альтернативные языки живут на других
 * доменах, canonical может вести на страницу глубже лимита. Проверить их иначе нечем, поэтому
 * здесь одиночные запросы: ссылки с них не разбираются, в очередь ничего не попадает, лимиты
 * обхода не тратятся.
 */
async function verifyExternal(urls, { userAgent, limit = 50 } = {}) {
  const results = new Map();
  for (const url of [...urls].slice(0, limit)) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      results.set(url, { status: res.status, finalUrl: res.url, redirected: res.redirected });
    } catch (err) {
      results.set(url, { status: null, error: err.message });
    }
  }
  return results;
}

export async function auditSite(siteId, { verify = true, thinWords = 200, userAgent = 'LayoutTestingBot/0.3' } = {}) {
  const site = await readSite(siteId);
  if (!site) throw new Error(`Обход ${siteId} не найден.`);

  const index = await readIndex(siteId);
  const frontier = (await readFrontier(siteId)) || { pending: [], skipped: {}, failed: [] };
  const pages = Object.entries(index.pages).map(([url, entry]) => ({ url, ...entry }));
  if (!pages.length) throw new Error(`В архиве ${siteId} нет страниц. Обход не отработал?`);

  /*
   * Списки в отчёте ограничены: сайт на десять тысяч страниц дал бы отчёт, который нельзя
   * ни прочитать, ни переслать. Но обрезать молча нельзя — пятьдесят битых ссылок и пять
   * тысяч требуют разных решений, а по обрезанному списку они неразличимы. Поэтому рядом с
   * примерами всегда лежит полное число: findings показывает, что именно сломано, counts —
   * сколько этого на самом деле.
   */
  const LIST_LIMIT = 50;
  const counts = {};
  const cap = (name, list, limit = LIST_LIMIT) => {
    counts[name] = list.length;
    return list.slice(0, limit);
  };
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const ok = pages.filter((p) => p.status === 200);
  const inbound = buildGraph(pages);

  const findings = {};

  // ---------- дубли ----------
  findings.duplicateTitles = duplicates(ok, (p) => p.title);
  findings.duplicateDescriptions = duplicates(ok, (p) => p.description);
  findings.duplicateH1 = duplicates(ok, (p) => p.h1);
  findings.duplicateContent = duplicates(ok, (p) => p.contentHash);

  // ---------- ссылки ----------
  findings.brokenLinks = cap(
    'brokenLinks',
    pages
      .filter((p) => p.status !== null && p.status >= 400)
      .map((p) => ({ url: p.url, status: p.status, linkedFrom: (inbound.get(p.url) || []).slice(0, 10) })),
  );

  findings.redirected = cap(
    'redirected',
    pages.filter((p) => p.redirected).map((p) => ({ url: p.url, finalUrl: p.finalUrl })),
  );

  /* Сирота — страница, на которую нет ни одной внутренней ссылки. Стартовая не в счёт: на неё
     ссылок изнутри и не должно быть. */
  findings.orphans = cap(
    'orphans',
    ok
      .filter((p) => p.url !== normalizeUrl(site.url) && (inbound.get(p.url) || []).length === 0)
      .map((p) => p.url),
  );

  findings.poorlyLinked = cap(
    'poorlyLinked',
    ok
      .map((p) => ({ url: p.url, inbound: (inbound.get(p.url) || []).length }))
      .filter((p) => p.inbound === 1),
  );

  /* Ссылки на страницы, которые сами закрыты от индексации: вес уходит в никуда. */
  findings.linksToNoindex = cap(
    'linksToNoindex',
    ok
      .filter((p) => !p.indexable && (inbound.get(p.url) || []).length > 0)
      .map((p) => ({ url: p.url, reasons: p.reasons, linkedFrom: (inbound.get(p.url) || []).slice(0, 5) })),
  );

  // ---------- содержимое ----------
  findings.thinContent = cap(
    'thinContent',
    ok
      .filter((p) => (p.words ?? 0) < thinWords)
      .map((p) => ({ url: p.url, words: p.words ?? 0 }))
      .sort((a, b) => a.words - b.words),
  );

  findings.missing = {
    title: cap('missing.title', ok.filter((p) => !p.title).map((p) => p.url)),
    description: cap('missing.description', ok.filter((p) => !p.description).map((p) => p.url)),
    h1: cap('missing.h1', ok.filter((p) => !p.h1).map((p) => p.url)),
  };

  findings.imagesWithoutAlt = cap(
    'imagesWithoutAlt',
    ok
      .filter((p) => (p.images?.noAlt ?? 0) > 0)
      .map((p) => ({ url: p.url, noAlt: p.images.noAlt, total: p.images.total }))
      .sort((a, b) => b.noAlt - a.noAlt),
  );

  // ---------- canonical и hreflang ----------
  const outside = new Set();
  const canonicalIssues = [];
  for (const page of ok) {
    const target = page.canonical ? normalizeUrl(page.canonical) : null;
    if (!target) {
      canonicalIssues.push({ url: page.url, issue: 'canonical не задан' });
      continue;
    }
    if (page.canonicalSelf) continue;

    if (!sameHost(target, page.url)) {
      canonicalIssues.push({ url: page.url, issue: 'canonical ведёт на другой хост', target });
      outside.add(target);
      continue;
    }
    const known = byUrl.get(target);
    if (!known) {
      canonicalIssues.push({ url: page.url, issue: 'canonical ведёт на страницу вне обхода', target, verify: true });
      outside.add(target);
    } else if (known.status !== 200) {
      canonicalIssues.push({ url: page.url, issue: `canonical ведёт на страницу со статусом ${known.status}`, target });
    }
  }
  findings.canonical = canonicalIssues;

  const hreflangIssues = [];
  for (const page of ok) {
    const alternates = page.alternates || [];
    if (!alternates.length) continue;

    if (!alternates.some((a) => String(a.hreflang).toLowerCase() === 'x-default')) {
      hreflangIssues.push({ url: page.url, issue: 'нет x-default' });
    }
    for (const alt of alternates) {
      if (!alt.href) continue;
      const target = normalizeUrl(alt.href);
      const known = byUrl.get(target);
      if (!known) {
        outside.add(target);
        continue;
      }
      /* Взаимность: страница, объявленная альтернативой, обязана сослаться обратно. Односторонний
         hreflang поисковик игнорирует целиком, то есть работы как будто и не было. */
      const back = (known.alternates || []).some((a) => a.href && normalizeUrl(a.href) === page.url);
      if (!back) {
        hreflangIssues.push({ url: page.url, issue: 'альтернатива не ссылается обратно', target, hreflang: alt.hreflang });
      }
    }
  }
  findings.hreflang = hreflangIssues;

  // ---------- смешанное содержимое ----------
  findings.mixedContent = cap(
    'mixedContent',
    ok
      .filter((p) => p.url.startsWith('https://') && (p.links || []).some((l) => l.startsWith('http://')))
      .map((p) => p.url),
  );

  // ---------- чего мы не знаем ----------
  const skipped = Object.entries(frontier.skipped || {});
  findings.notChecked = {
    /* Три разные причины, и смешивать их нельзя: запрет в robots — это находка, упёршийся
       лимит — повод перезапустить обход шире, а неудачный запрос — возможная поломка сайта. */
    blockedByRobots: skipped
      .filter(([, info]) => /robots/.test(info.reason))
      .map(([url, info]) => ({ url, linkedFrom: info.from })),
    beyondLimits: (frontier.pending || []).length,
    failed: cap('notChecked.failed', frontier.failed || [], 20),
  };

  // ---------- проверка адресов вне периметра ----------
  if (verify && outside.size) {
    const checked = await verifyExternal(outside, { userAgent });
    findings.verifiedOutside = [...checked].map(([url, result]) => ({ url, ...result }));
    for (const issue of canonicalIssues) {
      const result = issue.target && checked.get(issue.target);
      if (result && result.status !== 200) {
        issue.issue = `canonical ведёт на адрес со статусом ${result.status ?? 'недоступен'}`;
      }
    }
  }

  return {
    siteId,
    url: site.url,
    at: new Date().toISOString(),
    totals: totalsOf(pages, findings),
    findings,
    /* Полные размеры списков из findings: примеры обрезаны, счётчики — нет. */
    counts,
  };
}

function totalsOf(pages, findings) {
  return {
    pages: pages.length,
    indexable: pages.filter((p) => p.indexable).length,
    broken: findings.brokenLinks.length,
    orphans: findings.orphans.length,
    duplicateTitles: findings.duplicateTitles.length,
    duplicateContent: findings.duplicateContent.length,
    thin: findings.thinContent.length,
    canonicalIssues: findings.canonical.length,
    hreflangIssues: findings.hreflang.length,
    blockedByRobots: findings.notChecked.blockedByRobots.length,
    notCrawled: findings.notChecked.beyondLimits,
  };
}

/** Человеческий вердикт. Порядок — по тому, что дороже стоит, а не по алфавиту. */
export function verdictOf(report) {
  const t = report.totals;
  const problems = [];
  if (t.broken) problems.push(`битых ссылок: ${t.broken}`);
  if (t.duplicateContent) problems.push(`групп дублей контента: ${t.duplicateContent}`);
  if (t.duplicateTitles) problems.push(`групп дублей title: ${t.duplicateTitles}`);
  if (t.canonicalIssues) problems.push(`вопросов к canonical: ${t.canonicalIssues}`);
  if (t.hreflangIssues) problems.push(`вопросов к hreflang: ${t.hreflangIssues}`);
  if (t.orphans) problems.push(`страниц-сирот: ${t.orphans}`);
  if (t.thin) problems.push(`тонких страниц: ${t.thin}`);
  if (t.pages - t.indexable) problems.push(`не индексируется: ${t.pages - t.indexable}`);

  return {
    clean: problems.length === 0,
    verdict: problems.length ? problems.join('; ') : 'проблем не найдено',
    /* Оговорка идёт рядом с вердиктом, а не в примечаниях: «проблем не найдено» по половине
       сайта — это не то же самое, что по всему сайту. */
    coverage:
      t.notCrawled || t.blockedByRobots
        ? `проверено ${t.pages} страниц; не пройдено ${t.notCrawled}, закрыто robots ${t.blockedByRobots}`
        : `проверено ${t.pages} страниц`,
  };
}
