import fs from 'node:fs/promises';
import path from 'node:path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { CONFIG } from '../config.js';
import { artifactRef, runDir, slug } from '../artifacts.js';

const PRESETS = {
  mobile: {
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
  },
  desktop: {
    formFactor: 'desktop',
    screenEmulation: { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
  },
};

export async function runLighthouse(url, {
  runId,
  name = 'lighthouse',
  categories = ['performance', 'accessibility', 'best-practices', 'seo'],
  preset = 'desktop',
  maxOpportunities = 10,
} = {}) {
  const chrome = await chromeLauncher.launch({
    chromePath: CONFIG.chromePath,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const { formFactor, screenEmulation } = PRESETS[preset] || PRESETS.desktop;
    const result = await lighthouse(url, {
      port: chrome.port,
      output: ['json', 'html'],
      logLevel: 'error',
      onlyCategories: categories,
      formFactor,
      screenEmulation,
    });

    const lhr = result.lhr;
    const dir = await runDir(runId);
    const base = slug(name);
    const htmlFile = path.join(dir, `${base}.html`);
    const jsonFile = path.join(dir, `${base}.json`);
    await fs.writeFile(htmlFile, result.report[1], 'utf8');
    await fs.writeFile(jsonFile, result.report[0], 'utf8');

    const scores = Object.fromEntries(
      Object.entries(lhr.categories).map(([key, cat]) => [key, cat.score === null ? null : Math.round(cat.score * 100)]),
    );

    const metricIds = [
      'first-contentful-paint',
      'largest-contentful-paint',
      'cumulative-layout-shift',
      'total-blocking-time',
      'speed-index',
      'interactive',
    ];
    const metrics = {};
    for (const id of metricIds) {
      const audit = lhr.audits[id];
      if (audit) metrics[id] = { value: audit.numericValue, display: audit.displayValue, score: audit.score };
    }

    // Отдаём только провалившиеся аудиты: полный lhr — это мегабайты JSON.
    const failed = Object.values(lhr.audits)
      .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative')
      .sort((a, b) => (b.details?.overallSavingsMs || 0) - (a.details?.overallSavingsMs || 0))
      .slice(0, maxOpportunities)
      .map((a) => ({
        id: a.id,
        title: a.title,
        score: a.score,
        display: a.displayValue || null,
        savingsMs: a.details?.overallSavingsMs ?? null,
      }));

    return {
      url: lhr.finalDisplayedUrl || url,
      preset,
      scores,
      metrics,
      failedAudits: failed,
      report: artifactRef(htmlFile),
      json: artifactRef(jsonFile),
    };
  } finally {
    await chrome.kill();
  }
}

/** Ставится до навигации: иначе первые сдвиги layout и LCP уже пропущены. */
export async function installVitalsCollector(page) {
  await page.addInitScript(() => {
    window.__ltVitals = { cls: 0, shifts: [], lcp: 0, fcp: 0, ttfb: 0, longTasks: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__ltVitals.cls += entry.value;
          if (window.__ltVitals.shifts.length < 20) {
            window.__ltVitals.shifts.push({
              value: Math.round(entry.value * 10000) / 10000,
              at: Math.round(entry.startTime),
              sources: (entry.sources || []).slice(0, 3).map((s) => {
                const el = s.node;
                if (!el || el.nodeType !== 1) return '(нет узла)';
                const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0];
                return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : cls ? `.${cls}` : '');
              }),
            });
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });

      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__ltVitals.lcp = Math.round(last.startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') window.__ltVitals.fcp = Math.round(entry.startTime);
        }
      }).observe({ type: 'paint', buffered: true });

      new PerformanceObserver((list) => {
        window.__ltVitals.longTasks += list.getEntries().length;
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* движок без части типов observer — метрики останутся нулевыми */
    }
  });
}

export async function readVitals(page, { settleMs = 1500 } = {}) {
  await page.waitForTimeout(settleMs);
  const raw = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const v = window.__ltVitals || { cls: 0, shifts: [], lcp: 0, fcp: 0, longTasks: 0 };
    return {
      ...v,
      ttfb: nav ? Math.round(nav.responseStart) : 0,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
      load: nav ? Math.round(nav.loadEventEnd) : 0,
    };
  });

  const cls = Math.round(raw.cls * 10000) / 10000;
  return {
    cls,
    clsRating: cls <= 0.1 ? 'good' : cls <= 0.25 ? 'needs-improvement' : 'poor',
    lcp: raw.lcp,
    lcpRating: raw.lcp <= 2500 ? 'good' : raw.lcp <= 4000 ? 'needs-improvement' : 'poor',
    fcp: raw.fcp,
    ttfb: raw.ttfb,
    domContentLoaded: raw.domContentLoaded,
    load: raw.load,
    longTasks: raw.longTasks,
    /** Кто именно сдвинул layout — обычно это картинка без размеров или поздний шрифт. */
    shifts: raw.shifts,
  };
}
