import { CONFIG } from './config.js';
import { newRunId, writeJson, runDir, slug } from './artifacts.js';
import { createSession, closeSession, gotoAndSettle } from './browser/pool.js';
import { profileKey } from './browser/profile.js';
import { layoutAudit } from './checks/layout.js';
import { pageSnapshot } from './checks/snapshot.js';
import { takeScreenshot, compareWithBaseline } from './checks/visual.js';
import { runAxe, runPa11y } from './checks/a11y.js';
import { installVitalsCollector, readVitals, runLighthouse } from './checks/perf.js';
import { validateHtmlWithVnu, validateHtmlLocal } from './checks/static.js';
import path from 'node:path';

export const ALL_CHECKS = ['layout', 'screenshot', 'visual', 'axe', 'pa11y', 'vitals', 'lighthouse', 'html', 'snapshot'];

export function expandChecks(checks) {
  if (!checks || checks.length === 0) return ['layout', 'screenshot', 'axe', 'vitals'];
  if (checks.includes('all')) return [...ALL_CHECKS];
  const unknown = checks.filter((c) => !ALL_CHECKS.includes(c));
  if (unknown.length) {
    throw new Error(`Неизвестные проверки: ${unknown.join(', ')}. Доступны: ${ALL_CHECKS.join(', ')}, all`);
  }
  // visual без снимка бессмыслен — добираем сами.
  return checks.includes('visual') && !checks.includes('screenshot') ? [...checks, 'screenshot'] : checks;
}

/**
 * Один прогон: одна страница под одним профилем, набор проверок.
 * Используется и MCP-инструментом, и CLI, и каждой ячейкой матрицы.
 */
export async function runAudit({
  url,
  profile = {},
  checks = [],
  runId = newRunId(),
  name = 'page',
  fullPage = true,
  selector = null,
  mask = [],
  hide = [],
  updateBaseline = false,
  threshold = CONFIG.visualThreshold,
  waitUntil = 'load',
  timeout = CONFIG.defaultTimeout,
  baselineName = null,
} = {}) {
  const wanted = expandChecks(checks);
  const key = profileKey(profile);
  const session = await createSession(profile);
  const results = {};
  const errors = {};

  try {
    if (wanted.includes('vitals') || wanted.includes('lighthouse')) {
      await installVitalsCollector(session.page);
    }

    const nav = await gotoAndSettle(session, url, { waitUntil, timeout });
    results.navigation = nav;

    const safe = async (label, fn) => {
      try {
        results[label] = await fn();
      } catch (err) {
        errors[label] = err.message;
      }
    };

    if (wanted.includes('layout')) await safe('layout', () => layoutAudit(session.page));
    if (wanted.includes('snapshot')) await safe('snapshot', () => pageSnapshot(session.page));
    if (wanted.includes('axe')) await safe('axe', () => runAxe(session.page));
    if (wanted.includes('vitals')) await safe('vitals', () => readVitals(session.page));

    if (wanted.includes('screenshot')) {
      await safe('screenshot', () =>
        takeScreenshot(session.page, {
          runId,
          name: `${slug(name)}__${slug(key)}`,
          fullPage,
          selector,
          mask,
          hide,
        }),
      );
    }

    if (wanted.includes('visual') && results.screenshot) {
      await safe('visual', () =>
        compareWithBaseline({
          runId,
          name: baselineName || name,
          profileKey: key,
          actualPath: results.screenshot.path,
          threshold,
          updateBaseline,
        }),
      );
    }

    if (wanted.includes('html')) {
      await safe('html', async () => {
        const html = await session.page.content();
        try {
          return { source: 'vnu', ...(await validateHtmlWithVnu(html)) };
        } catch (err) {
          // Контейнер vnu может быть не поднят — тогда отвечает встроенный валидатор.
          return { source: 'html-validate', fallbackReason: err.message, ...(await validateHtmlLocal(html)) };
        }
      });
    }

    if (wanted.includes('pa11y')) {
      await safe('pa11y', () => runPa11y(url, { viewport: session.profile.viewport }));
    }

    if (wanted.includes('lighthouse')) {
      await safe('lighthouse', () =>
        runLighthouse(url, {
          runId,
          name: `lighthouse__${slug(key)}`,
          preset: session.profile.viewport.width <= 480 ? 'mobile' : 'desktop',
        }),
      );
    }

    results.logs = {
      errors: session.logs.errors,
      consoleErrors: session.logs.console.filter((c) => c.type === 'error'),
      failedRequests: session.logs.network.filter((n) => n.failure || (n.status && n.status >= 400)),
    };
  } finally {
    await closeSession(session.id);
  }

  const summary = summarize(results, errors);
  const report = {
    runId,
    url,
    name,
    profileKey: key,
    profile: session.profile,
    checks: wanted,
    unsupported: session.unsupported,
    summary,
    results,
    errors,
    at: new Date().toISOString(),
  };

  const dir = await runDir(runId);
  await writeJson(path.join(dir, `${slug(name)}__${slug(key)}.json`), report);
  return report;
}

export function summarize(results, errors = {}) {
  const s = {
    layoutIssues: results.layout?.total ?? null,
    documentOverflow: results.layout?.issues?.documentOverflow ? true : false,
    axeViolations: results.axe?.total ?? null,
    pa11yErrors: results.pa11y?.byType?.error ?? null,
    htmlErrors: results.html?.byType?.error ?? null,
    cls: results.vitals?.cls ?? null,
    lcp: results.vitals?.lcp ?? null,
    performanceScore: results.lighthouse?.scores?.performance ?? null,
    visual: results.visual?.status ?? null,
    diffPercentage: results.visual?.diffPercentage ?? null,
    jsErrors: results.logs?.errors?.length ?? 0,
    failedRequests: results.logs?.failedRequests?.length ?? 0,
    navigationTimedOut: results.navigation?.navigationTimedOut ?? false,
    checkErrors: Object.keys(errors),
  };
  s.verdict = verdictOf(s);
  return s;
}

function verdictOf(s) {
  const problems = [];
  if (s.documentOverflow) problems.push('горизонтальный скролл');
  if (s.layoutIssues) problems.push(`эвристики вёрстки: ${s.layoutIssues}`);
  if (s.axeViolations) problems.push(`axe: ${s.axeViolations}`);
  if (s.htmlErrors) problems.push(`невалидный HTML: ${s.htmlErrors}`);
  if (s.cls !== null && s.cls > 0.1) problems.push(`CLS ${s.cls}`);
  if (s.visual === 'diff') problems.push(`визуальное расхождение ${s.diffPercentage}%`);
  if (s.jsErrors) problems.push(`ошибок JS: ${s.jsErrors}`);
  if (s.failedRequests) problems.push(`неудачных запросов: ${s.failedRequests}`);
  if (s.navigationTimedOut) problems.push('страница не догрузилась до конца');
  return problems.length ? problems.join('; ') : 'проблем не найдено';
}
