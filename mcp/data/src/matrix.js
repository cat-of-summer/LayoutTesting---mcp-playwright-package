import path from 'node:path';
import { runAudit } from './audit.js';
import { newRunId, runDir, writeJson, slug } from './artifacts.js';
import { profileKey } from './browser/profile.js';
import { renderMatrixReport } from './report.js';

/**
 * Оси матрицы. Каждая — список значений; прогон идёт по декартову произведению.
 * Одна ось из одного значения ничего не умножает, поэтому дефолты безопасны.
 */
export const AXES = {
  browser: ['chromium'],
  viewport: ['desktop'],
  colorScheme: ['light'],
  rtl: [false],
  zoom: [100],
  textZoom: [100],
  forcedColors: ['none'],
  pseudoLoc: [false],
  deviceScaleFactor: [1],
};

export function buildProfiles(axes = {}) {
  const merged = { ...AXES, ...Object.fromEntries(Object.entries(axes).filter(([, v]) => v && v.length)) };
  let combos = [{}];
  for (const [key, values] of Object.entries(merged)) {
    const next = [];
    for (const combo of combos) for (const value of values) next.push({ ...combo, [key]: value });
    combos = next;
  }
  return combos;
}

/**
 * Прогон матрицы. Идёт последовательно с малой параллельностью:
 * каждый Chromium — сотни мегабайт, а памяти на стенде 8 ГБ.
 */
export async function runMatrix({
  url,
  axes = {},
  checks = ['layout', 'screenshot', 'vitals'],
  name = 'matrix',
  runId = newRunId(slug(name)),
  concurrency = 2,
  updateBaseline = false,
  mask = [],
  fullPage = true,
  onProgress = null,
} = {}) {
  const profiles = buildProfiles(axes);
  const queue = [...profiles.entries()];
  const cells = new Array(profiles.length);

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [index, profile] = item;
      const key = profileKey(profile);
      try {
        const report = await runAudit({
          url,
          profile,
          checks,
          runId,
          name: `${slug(name)}`,
          baselineName: name,
          updateBaseline,
          mask,
          fullPage,
        });
        cells[index] = { profile, key, ok: true, summary: report.summary, results: report.results };
      } catch (err) {
        cells[index] = { profile, key, ok: false, error: err.message };
      }
      if (onProgress) onProgress({ done: cells.filter(Boolean).length, total: profiles.length, key });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, profiles.length)) }, worker));

  const failed = cells.filter((c) => !c.ok);
  const problems = cells.filter((c) => c.ok && c.summary.verdict !== 'проблем не найдено');

  const dir = await runDir(runId);
  const html = await renderMatrixReport({ url, name, cells, runId });
  const htmlFile = path.join(dir, 'matrix.html');
  await writeJson(path.join(dir, 'matrix.json'), { runId, url, name, checks, axes, cells });
  const fs = await import('node:fs/promises');
  await fs.writeFile(htmlFile, html, 'utf8');

  return {
    runId,
    url,
    total: profiles.length,
    withProblems: problems.length,
    failed: failed.length,
    report: htmlFile,
    cells: cells.map((c) => ({
      key: c.key,
      ok: c.ok,
      verdict: c.ok ? c.summary.verdict : c.error,
      summary: c.ok ? c.summary : null,
    })),
  };
}
