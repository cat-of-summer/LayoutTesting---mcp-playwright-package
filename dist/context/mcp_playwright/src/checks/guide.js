/**
 * Визуальный справочник вариантов.
 *
 * Отличается от отчёта матрицы адресатом. Матрица отвечает разработчику «где сломалось»:
 * одна и та же страница в разных условиях, вердикт и метрики. Справочник отвечает
 * контент-менеджеру «что я получу, если выберу вот это»: разные блоки одной страницы,
 * каждый со своим набором параметров и снимком в нескольких ширинах.
 *
 * Такой документ собирают руками — снимают серию кадров, жмут их и вклеивают в HTML.
 * Здесь это один вызов, и результат самодостаточен: картинки вшиты, файл можно переслать.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { withSession, gotoAndSettle } from '../browser/pool.js';
import { takeScreenshot, imageDataUri } from './visual.js';
import { artifactRef, newRunId, runDir, slug } from '../artifacts.js';

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STYLE = `
:root { color-scheme: light dark;
  --bg:#f6f5f3; --surface:#fff; --surface-2:#faf9f7; --fg:#1c1b19; --muted:#5c574f;
  --faint:#6d6659; --line:#e3dfd8; --line-2:#cdc6bb; --accent:#9a4520; --accent-bg:#f4e6dd; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16150f; --surface:#1e1c17; --surface-2:#23211b; --fg:#ece8e0; --muted:#b3ad9f;
    --faint:#968c7e; --line:#332f27; --line-2:#463f34; --accent:#f2a678; --accent-bg:#3a2519; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width:1140px; margin:0 auto; padding:32px 20px 80px; }
h1 { font-size:28px; line-height:1.2; margin:0 0 8px; }
.meta { color:var(--faint); font-size:13px; margin:0 0 28px; }
.intro { color:var(--muted); max-width:78ch; margin:0 0 28px; }
.item { background:var(--surface); border:1px solid var(--line); border-radius:10px;
  margin:22px 0; overflow:hidden; }
.item__head { padding:15px 20px; border-bottom:1px solid var(--line); background:var(--surface-2); }
.item__title { font-weight:600; font-size:16px; margin:0 0 9px; }
.params { display:flex; flex-wrap:wrap; gap:6px; }
.chip { font-size:12.5px; line-height:1.4; padding:3px 9px; border-radius:100px;
  border:1px solid var(--line-2); color:var(--muted); background:var(--bg); white-space:nowrap; }
.chip b { color:var(--fg); font-weight:600; }
.note { margin:9px 0 0; font-size:12.5px; color:var(--faint); }
.shots { display:flex; gap:18px; padding:18px 20px 20px; align-items:flex-start; }
.shot { min-width:0; }
.shot__label { font-size:11.5px; text-transform:uppercase; letter-spacing:.06em;
  color:var(--faint); margin-bottom:7px; font-weight:600; }
.shot img { display:block; width:100%; height:auto; border:1px solid var(--line); border-radius:6px; }
.shot .scroller { max-height:540px; overflow-y:auto; border-radius:6px; }
.missing { padding:18px 20px; color:var(--faint); font-size:14px; }
@media (max-width:760px) { .shots { flex-direction:column; } }
@media print { .item { break-inside:avoid; } .shot .scroller { max-height:none; overflow:visible; } }
`;

/**
 * Первый профиль занимает всю оставшуюся ширину, остальные встают колонками рядом:
 * узкий снимок рядом с широким читается как «то же самое на телефоне», а не как
 * отдельная картинка.
 */
function shotsHtml(shots) {
  return shots
    .map(({ label, uri, width, narrow }) =>
      uri
        ? `<div class="shot" style="flex:${narrow ? '0 0 200px' : '1 1 auto'}">
      <div class="shot__label">${esc(label)}</div>
      ${narrow ? '<div class="scroller">' : ''}<img src="${uri}" width="${width}" alt="${esc(label)}">${narrow ? '</div>' : ''}
    </div>`
        : `<div class="shot"><div class="shot__label">${esc(label)}</div><div class="missing">снять не удалось</div></div>`,
    )
    .join('\n');
}

function itemHtml(item, shots) {
  const chips = Object.entries(item.params || {})
    .map(([k, v]) => `<span class="chip"><b>${esc(k)}:</b> ${esc(v)}</span>`)
    .join('');
  return `<div class="item">
  <div class="item__head">
    <p class="item__title">${esc(item.title || item.selector)}</p>
    ${chips ? `<div class="params">${chips}</div>` : ''}
    ${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}
  </div>
  <div class="shots">
${shotsHtml(shots)}
  </div>
</div>`;
}

export function renderGuide({ title, intro, url, items, runId, profiles }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<h1>${esc(title)}</h1>
<p class="meta">${esc(url)} · вариантов ${items.length} · ширины: ${esc(profiles.join(', '))} · прогон ${esc(runId)}</p>
${intro ? `<p class="intro">${esc(intro)}</p>` : ''}
${items.map((i) => i.html).join('\n')}
</div>
</body>
</html>`;
}

/**
 * Снимает каждый вариант в каждом профиле и собирает один HTML.
 *
 * Профили — это отдельные сессии: ширина задаётся при создании контекста, менять её
 * на лету нельзя. Страница для каждого профиля открывается один раз, дальше по ней
 * ходят все варианты — переоткрывать её на каждый кадр незачем.
 */
export async function buildVisualGuide({
  url,
  items,
  title = 'Визуальный справочник',
  intro = null,
  profiles = ['desktop', 'mobile'],
  auth = null,
  image = {},
  browser = 'chromium',
  // Справочник — это десятки кадров подряд, и опечатка в селекторе не должна стоить
  // полного таймаута ожидания на каждой ширине. Нужный блок либо уже на странице,
  // либо его нет: она отрисована ещё до первого снимка.
  itemTimeout = 5000,
} = {}) {
  if (!url) throw new Error('Нужен url страницы.');
  if (!Array.isArray(items) || !items.length) throw new Error('Нужен непустой список items.');

  const runId = newRunId(slug(title));
  const dir = await runDir(runId);
  const imageOpts = { format: image.format || 'webp', quality: image.quality ?? 80, maxWidth: image.maxWidth ?? 1000 };

  // shots[индекс варианта][индекс профиля]
  const shots = items.map(() => []);
  const warnings = [];

  for (const [profileIndex, viewport] of profiles.entries()) {
    await withSession({ viewport, browser, ...(auth ? { auth } : {}) }, async (session) => {
      const nav = await gotoAndSettle(session, url);
      if (nav.warnings) warnings.push({ viewport, ...nav.warnings });

      for (const [itemIndex, item] of items.entries()) {
        const label = `${viewport} ${session.profile.viewport.width}`;
        try {
          const shot = await takeScreenshot(session.page, {
            runId,
            name: `${String(itemIndex + 1).padStart(2, '0')}-${slug(item.title || item.selector)}__${slug(viewport)}`,
            selector: item.selector,
            isolate: item.isolate,
            hide: item.hide,
            fullPage: false,
            timeout: itemTimeout,
            ...imageOpts,
          });
          const { uri, width } = await imageDataUri(shot.path, imageOpts);
          shots[itemIndex][profileIndex] = {
            label,
            uri,
            width,
            narrow: session.profile.viewport.width <= 480,
          };
        } catch (err) {
          // Один непойманный селектор не должен ронять весь справочник:
          // в документе останется честная дырка, остальное соберётся.
          shots[itemIndex][profileIndex] = { label, uri: null, error: err.message };
          warnings.push({ viewport, selector: item.selector, error: err.message });
        }
      }
    });
  }

  const rendered = items.map((item, i) => ({ ...item, html: itemHtml(item, shots[i]) }));
  const html = renderGuide({ title, intro, url, items: rendered, runId, profiles });

  const file = path.join(dir, 'guide.html');
  await fs.writeFile(file, html, 'utf8');

  const missing = shots.flat().filter((s) => !s || !s.uri).length;
  return {
    runId,
    ...artifactRef(file),
    items: items.length,
    profiles,
    shots: shots.flat().filter((s) => s && s.uri).length,
    bytes: Buffer.byteLength(html),
    ...(missing ? { missing } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
