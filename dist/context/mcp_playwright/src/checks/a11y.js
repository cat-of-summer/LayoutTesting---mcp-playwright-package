import { AxeBuilder } from '@axe-core/playwright';
import pa11y from 'pa11y';
import { CONFIG } from '../config.js';

const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

/**
 * axe-core работает внутри уже открытой страницы, поэтому видит её в том же
 * состоянии, что и скриншот: после логина, раскрытых меню и прочего.
 */
export async function runAxe(page, { tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'], include, exclude, maxNodes = 10 } = {}) {
  let builder = new AxeBuilder({ page });
  if (tags?.length) builder = builder.withTags(tags);
  if (include) for (const sel of [].concat(include)) builder = builder.include(sel);
  if (exclude) for (const sel of [].concat(exclude)) builder = builder.exclude(sel);

  const results = await builder.analyze();

  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    tags: v.tags.filter((t) => t.startsWith('wcag')),
    nodeCount: v.nodes.length,
    nodes: v.nodes.slice(0, maxNodes).map((n) => ({
      target: n.target.join(' '),
      html: n.html.slice(0, 200),
      summary: (n.failureSummary || '').split('\n').filter(Boolean).slice(0, 3).join(' / '),
    })),
  }));

  const bySeverity = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) if (bySeverity[v.impact] !== undefined) bySeverity[v.impact] += v.nodeCount;

  return {
    url: results.url,
    total: violations.reduce((sum, v) => sum + v.nodeCount, 0),
    bySeverity,
    passes: results.passes.length,
    incomplete: results.incomplete.length,
    violations,
  };
}

/**
 * pa11y поднимает собственный браузер, поэтому проверяет URL, а не сессию.
 * Ценен вторым набором правил (HTML CodeSniffer) — он ловит не то же, что axe.
 */
export async function runPa11y(url, { standard = 'WCAG2AA', viewport, timeout = 45000, maxIssues = 50 } = {}) {
  const results = await pa11y(url, {
    standard,
    timeout,
    chromeLaunchConfig: {
      executablePath: CONFIG.chromePath,
      args: CHROME_ARGS,
    },
    viewport: viewport || { width: 1440, height: 900 },
    includeWarnings: true,
    includeNotices: false,
  });

  const issues = results.issues.slice(0, maxIssues).map((i) => ({
    type: i.type,
    code: i.code,
    message: i.message,
    selector: i.selector,
    context: (i.context || '').slice(0, 160),
  }));

  return {
    url: results.pageUrl,
    total: results.issues.length,
    byType: {
      error: results.issues.filter((i) => i.type === 'error').length,
      warning: results.issues.filter((i) => i.type === 'warning').length,
      notice: results.issues.filter((i) => i.type === 'notice').length,
    },
    issues,
  };
}
