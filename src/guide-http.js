/**
 * Регламент и скилл по HTTP.
 *
 * Два адреса, оба GET и оба мимо протокола MCP:
 *
 *   /skill/layout-by-figma/SKILL.md   — регламент как скилл агента, собранный из guide/;
 *   /guide/<ru|en>/<раздел>.md        — один раздел целиком.
 *
 * Их читает не агент через инструмент, а заглушка скилла в проекте (curl со стенда) — так
 * регламент подтягивается по триггеру задачи, без того чтобы агент вспомнил про help.
 * Текст тот же, что у help(guide) и lt://guide/…: одна витрина больше, копий — нет.
 *
 * Обработчик вынесен из index.js по той же причине, что и /upload: index.js — про транспорт
 * MCP, а не про содержимое.
 */
import { ORDER, read } from './guide.js';
import { LANG } from './i18n.js';
import { SKILL_NAME, buildSkill } from './skill.js';

const LANGS = new Set(['ru', 'en']);

function markdown(res, code, text) {
  res.writeHead(code, {
    'Content-Type': 'text/markdown; charset=utf-8',
    /* Регламент правят и пересобирают образ; кэшировать его в прокси незачем. */
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function plain(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** Язык: ?lang=… или язык стенда. Неизвестный — язык стенда, а не ошибка. */
function langOf(url, fallback = LANG) {
  const wanted = String(url.searchParams.get('lang') || '').toLowerCase();
  return LANGS.has(wanted) ? wanted : fallback;
}

export async function handleGuideRoute(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    plain(res, 405, 'Только GET.\n');
    return;
  }

  if (url.pathname === `/skill/${SKILL_NAME}/SKILL.md`) {
    const { text } = await buildSkill(langOf(url));
    markdown(res, 200, text);
    return;
  }
  if (url.pathname.startsWith('/skill/')) {
    plain(res, 404, `Есть только /skill/${SKILL_NAME}/SKILL.md (?lang=ru|en).\n`);
    return;
  }

  const match = /^\/guide\/(ru|en)\/([a-z]+)\.md$/.exec(url.pathname);
  if (!match) {
    plain(res, 404, `Адрес раздела — /guide/<ru|en>/<раздел>.md. Разделы: ${ORDER.join(', ')}.\n`);
    return;
  }
  const [, lang, slug] = match;
  const section = await read(slug, { lang });
  if (!section) {
    plain(res, 404, `Раздела «${slug}» нет. Разделы: ${ORDER.join(', ')}.\n`);
    return;
  }
  markdown(res, 200, section.note ? `${section.text}\n\n${section.note}\n` : `${section.text}\n`);
}
