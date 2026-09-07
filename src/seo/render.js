/**
 * HTML-отчёт по сайту.
 *
 * Стили и экранирование берутся из report.js, а не заводятся заново: третья копия одного и того
 * же CSS означала бы, что отчёты стенда начнут выглядеть по-разному в зависимости от того, кто
 * их сделал.
 *
 * Отчёт самодостаточен и открывается откуда угодно: ни одной внешней ссылки, всё внутри файла.
 * Его пересылают одним вложением, и разъехавшаяся вёрстка на чужой машине обесценила бы работу.
 */
import { esc, STYLE } from '../report.js';

const EXTRA = `
.totals { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:10px; margin:16px 0 24px; }
.tile { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:var(--card); }
.tile b { display:block; font-size:22px; line-height:1.2; }
.tile span { color:var(--muted); font-size:12px; }
.group { border:1px solid var(--line); border-radius:10px; margin:0 0 14px; background:var(--card); overflow:hidden; }
.group > h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); }
.group > h2 .n { color:var(--muted); font-weight:400; }
.group .body { padding:10px 12px; }
.group.empty > h2 { border-bottom:none; }
ul.items { margin:0; padding-left:18px; }
ul.items li { margin:2px 0; word-break:break-all; }
.dup { margin:0 0 10px; }
.dup .val { font-weight:600; }
.note { color:var(--muted); font-size:13px; margin:4px 0 0; }
.coverage { border-left:3px solid var(--warn); padding:8px 12px; margin:0 0 20px; color:var(--muted); }
`;

const list = (items, render) =>
  items.length ? `<ul class="items">${items.map((i) => `<li>${render(i)}</li>`).join('')}</ul>` : '';

const link = (url) => `<a href="${esc(url)}">${esc(String(url).slice(0, 140))}</a>`;

/** Пустой раздел показывается тоже: «проверено и чисто» — это результат, а не отсутствие данных. */
function section(title, count, body) {
  const empty = !count;
  return `<div class="group${empty ? ' empty' : ''}">
  <h2>${esc(title)} <span class="n">${empty ? '— чисто' : count}</span></h2>
  ${empty ? '' : `<div class="body">${body}</div>`}
</div>`;
}

const dupBlock = (groups) =>
  groups
    .slice(0, 20)
    .map(
      (g) => `<div class="dup"><div class="val">${esc(g.value)} <span class="n">— ${g.count}</span></div>
${list(g.urls, link)}</div>`,
    )
    .join('');

export function renderSiteReport(report, verdict) {
  const f = report.findings;
  const t = report.totals;

  const tiles = [
    ['страниц', t.pages],
    ['индексируются', t.indexable],
    ['битых', t.broken],
    ['сирот', t.orphans],
    ['дублей title', t.duplicateTitles],
    ['дублей контента', t.duplicateContent],
    ['тонких', t.thin],
    ['не пройдено', t.notCrawled],
  ]
    .map(([label, value]) => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
    .join('');

  const sections = [
    section('Битые ссылки', f.brokenLinks.length, list(f.brokenLinks, (b) =>
      `${link(b.url)} — ${esc(b.status)}${b.linkedFrom.length ? `<div class="note">ведут: ${b.linkedFrom.map(link).join(', ')}</div>` : ''}`)),

    section('Дубли title', f.duplicateTitles.length, dupBlock(f.duplicateTitles)),
    section('Дубли description', f.duplicateDescriptions.length, dupBlock(f.duplicateDescriptions)),
    section('Дубли h1', f.duplicateH1.length, dupBlock(f.duplicateH1)),
    section('Одинаковое содержимое', f.duplicateContent.length, dupBlock(f.duplicateContent)),

    section('Страницы-сироты', f.orphans.length,
      `<p class="note">На эти страницы не ведёт ни одной внутренней ссылки.</p>${list(f.orphans, link)}`),

    section('Вопросы к canonical', f.canonical.length, list(f.canonical, (c) =>
      `${link(c.url)} — ${esc(c.issue)}${c.target ? ` → ${link(c.target)}` : ''}`)),

    section('Вопросы к hreflang', f.hreflang.length, list(f.hreflang, (h) =>
      `${link(h.url)} — ${esc(h.issue)}${h.target ? ` → ${link(h.target)}` : ''}`)),

    section('Ссылки на закрытые от индексации', f.linksToNoindex.length, list(f.linksToNoindex, (p) =>
      `${link(p.url)} — ${esc((p.reasons || []).join(', '))}`)),

    section('Тонкое содержимое', f.thinContent.length, list(f.thinContent, (p) =>
      `${link(p.url)} — ${esc(p.words)} слов`)),

    section('Нет title', f.missing.title.length, list(f.missing.title, link)),
    section('Нет description', f.missing.description.length, list(f.missing.description, link)),
    section('Нет h1', f.missing.h1.length, list(f.missing.h1, link)),

    section('Картинки без alt', f.imagesWithoutAlt.length, list(f.imagesWithoutAlt, (p) =>
      `${link(p.url)} — ${esc(p.noAlt)} из ${esc(p.total)}`)),

    section('Редиректы', f.redirected.length, list(f.redirected, (r) =>
      `${link(r.url)} → ${link(r.finalUrl)}`)),

    section('Смешанное содержимое', f.mixedContent.length,
      `<p class="note">На странице по https есть ссылки по http.</p>${list(f.mixedContent, link)}`),

    section('Закрыто в robots.txt, но залинковано', f.notChecked.blockedByRobots.length,
      `<p class="note">Обход туда не пошёл, но ссылки изнутри сайта на них есть.</p>${list(f.notChecked.blockedByRobots, (b) =>
        `${link(b.url)}${b.linkedFrom ? `<div class="note">со страницы ${link(b.linkedFrom)}</div>` : ''}`)}`),
  ].join('\n');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO-отчёт — ${esc(report.siteId)}</title>
<style>${STYLE}${EXTRA}</style>
</head>
<body>
<h1>SEO-отчёт: ${esc(report.siteId)}</h1>
<div class="meta">${esc(report.url)}<br>снят ${esc(report.at)}</div>

<div class="verdict ${verdict.clean ? 'ok' : 'bad'}">${esc(verdict.verdict)}</div>
<div class="coverage">${esc(verdict.coverage)}</div>

<div class="totals">${tiles}</div>

${sections}

<div class="legend">Пустой раздел означает, что проверка отработала и ничего не нашла —
это не то же самое, что «не проверялось». Что не проверялось, сведено в охвате наверху.</div>
</body>
</html>`;
}
