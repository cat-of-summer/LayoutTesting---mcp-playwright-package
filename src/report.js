import path from 'node:path';
import { imageDataUri } from './checks/visual.js';

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --muted:#5b6270; --line:#e3e6ec;
        --ok:#0f7b46; --warn:#9a6100; --bad:#b3261e; --card:#fafbfc; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#14161a; --fg:#e8eaee; --muted:#9aa2b1; --line:#2a2e37; --card:#1b1e24;
          --ok:#4ec98a; --warn:#e0a33a; --bad:#ff6b5e; }
}
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
       font:14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size:20px; margin:0 0 4px; }
.meta { color:var(--muted); margin-bottom:20px; font-size:13px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:16px; }
.cell { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--card); }
.cell h2 { font-size:13px; margin:0; padding:10px 12px; border-bottom:1px solid var(--line);
           font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:600; }
.cell .body { padding:12px; }
.shot { display:block; width:100%; height:auto; border-bottom:1px solid var(--line); background:#fff; }
.verdict { font-weight:600; margin-bottom:8px; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
table { width:100%; border-collapse:collapse; font-size:13px; }
td { padding:3px 0; vertical-align:top; }
td:first-child { color:var(--muted); padding-right:12px; white-space:nowrap; }
.legend { margin:24px 0 8px; font-size:13px; color:var(--muted); }
`;

function verdictClass(cell) {
  if (!cell.ok) return 'bad';
  return cell.summary.clean ? 'ok' : 'warn';
}

function metricRows(cell) {
  if (!cell.ok) return `<tr><td>ошибка</td><td>${esc(cell.error)}</td></tr>`;
  const s = cell.summary;
  const rows = [
    ['эвристики вёрстки', s.layoutIssues],
    ['горизонтальный скролл', s.documentOverflow ? 'да' : null],
    ['axe', s.axeViolations],
    ['HTML-ошибки', s.htmlErrors],
    ['CLS', s.cls],
    ['LCP, мс', s.lcp],
    ['Lighthouse perf', s.performanceScore],
    ['Lighthouse SEO', s.seoScore],
    ['не индексируется', s.notIndexable ? s.indexabilityReasons.join(', ') : null],
    ['визуально', s.visual === 'diff' ? `расхождение ${s.diffPercentage}%` : s.visual],
    ['ошибки JS', s.jsErrors || null],
    ['неудачные запросы', s.failedRequests || null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== 0 && v !== '');
  return rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
}

/**
 * Отчёт по умолчанию ссылается на соседние файлы и живёт только внутри своего каталога:
 * переслать его одним файлом нельзя. inlineImages вшивает картинки в разметку —
 * тогда отчёт открывается откуда угодно и переживает пересылку.
 */
export async function renderMatrixReport({ url, name, cells, runId, inlineImages = false, image = {} }) {
  const srcFor = async (absPath) => {
    if (!inlineImages) return esc(path.basename(absPath));
    const { uri } = await imageDataUri(absPath, {
      format: image.format || 'webp',
      quality: image.quality ?? 80,
      maxWidth: image.maxWidth ?? 1000,
    });
    return uri;
  };

  const cards = (
    await Promise.all(
      cells.map(async (cell) => {
        const shot = cell.ok && cell.results?.screenshot?.path;
        const img = shot
          ? `<img class="shot" loading="lazy" src="${await srcFor(shot)}" alt="${esc(cell.key)}">`
          : '';
        const diff = cell.ok && cell.results?.visual?.diff?.path;
        const diffImg = diff
          ? `<img class="shot" loading="lazy" src="${await srcFor(diff)}" alt="diff ${esc(cell.key)}">`
          : '';
        return `<div class="cell">
  <h2>${esc(cell.key)}</h2>
  ${img}${diffImg}
  <div class="body">
    <div class="verdict ${verdictClass(cell)}">${esc(cell.ok ? cell.summary.verdict : 'прогон не удался')}</div>
    <table>${metricRows(cell)}</table>
  </div>
</div>`;
      }),
    )
  ).join('\n');

  const problems = cells.filter((c) => c.ok && !c.summary.clean).length;
  const failed = cells.filter((c) => !c.ok).length;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Матрица «${esc(name)}» — ${esc(runId)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Матрица «${esc(name)}»</h1>
<div class="meta">
  ${esc(url)}<br>
  прогон ${esc(runId)} · комбинаций ${cells.length} · с проблемами ${problems} · не удалось ${failed}
</div>
<div class="grid">
${cards}
</div>
<div class="legend">Каждая карточка — одна комбинация условий. Имя карточки читается как
браузер_ширинаxвысота_тема_модификаторы.</div>
</body>
</html>`;
}
