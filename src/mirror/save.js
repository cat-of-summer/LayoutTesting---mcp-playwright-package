/**
 * Сохранение страницы в локальное зеркало.
 *
 * Смысл затеи: скачать страницу один раз и дальше разбирать её сколько угодно, не трогая чужой
 * сервер. Поэтому зеркало открывается через nginx стенда и к нему применимы все существующие
 * инструменты — layout_audit, screenshot, computed_styles, — а не только чтение разметки.
 *
 * На диск ложатся две версии, и это не избыточность:
 *   - raw.html — то, что отдал сервер: до JS и до переписывания ссылок. По нему валидирует vnu
 *     и по нему видно, что получает поисковый робот, не исполняющий скрипты;
 *   - page.html — отрендеренный DOM с локальными ссылками. Это то, что можно открыть.
 * Расхождение между ними само по себе находка: «контент появляется только после JS».
 *
 * Ресурсы тянутся через context.request, а не отдельным http-клиентом: так к ним применяются
 * куки сессии, basic-auth и заголовки профиля. Скачанное чужим клиентом на закрытом стенде
 * приезжает страницей логина, и выясняется это уже на готовом зеркале.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { DIRS } from '../config.js';
import { putAsset } from './assets.js';
import { rewriteCss, rewriteDocument } from './rewrite.js';
import { pageIdFor, siteIdFor, tryNormalize } from '../crawl/url.js';

export const siteDirOf = (siteId) => path.join(DIRS.sites, siteId);
export const pageDirOf = (siteId, pageId) => path.join(siteDirOf(siteId), 'pages', pageId);

/** Сколько уровней @import и url() внутри CSS обходим. Дальше начинается чужая сборка. */
const CSS_DEPTH = 2;

async function fetchResource(request, url) {
  const response = await request.get(url, { timeout: 15000, failOnStatusCode: false });
  if (!response.ok()) return { ok: false, status: response.status() };
  return {
    ok: true,
    status: response.status(),
    body: await response.body(),
    contentType: response.headers()['content-type'] || '',
  };
}

/**
 * Собирает зеркало страницы.
 *
 * knownPages — карта «нормализованный адрес → pageId» уже сохранённых страниц. Ссылки на них
 * ведут внутрь архива, остальные остаются абсолютными: сломать ссылку хуже, чем оставить её
 * ведущей наружу.
 */
export async function savePage(session, { siteId, assets = true, scripts = 'strip', raw = true, knownPages = new Map() } = {}) {
  const pageUrl = session.page.url();
  const site = siteId || siteIdFor(pageUrl);
  const pageId = pageIdFor(pageUrl);
  const dir = pageDirOf(site, pageId);
  const siteDir = siteDirOf(site);
  await fs.mkdir(dir, { recursive: true });

  const rendered = await session.page.content();
  const warnings = [];

  if (raw) {
    /* Сырой ответ берём повторным запросом через тот же контекст: page.content() отдаёт уже
       отрендеренный DOM, и «что видит робот без JS» по нему не восстановить. */
    const original = await fetchResource(session.context.request, pageUrl).catch(() => ({ ok: false }));
    if (original.ok) await fs.writeFile(path.join(dir, 'raw.html'), original.body);
    else warnings.push('Сырой ответ сервера получить не удалось — сохранён только отрендеренный DOM.');
  }

  const { document } = parseHTML(rendered);

  /* Кэш на адрес, а не только на содержимое: дедупликация по хэшу экономит место, а этот кэш —
     сетевые запросы, которых на странице с полусотней одинаковых иконок иначе полсотни. */
  const byUrl = new Map();
  const stats = { fetched: 0, reused: 0, failed: 0, bytes: 0 };

  const saveAsset = async (rawUrl, depth = 0) => {
    const abs = tryNormalize(rawUrl, pageUrl);
    if (!abs || !/^https?:/i.test(abs)) return null;
    if (byUrl.has(abs)) return byUrl.get(abs);

    let result = null;
    try {
      const got = await fetchResource(session.context.request, abs);
      if (got.ok) {
        let body = got.body;

        // CSS переписываем до укладки: иначе хэш посчитается от версии с чужими адресами.
        if (/text\/css/i.test(got.contentType) && depth < CSS_DEPTH) {
          const nested = new Map();
          for (const found of String(body).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/gi)) {
            const ref = found[1] || found[2];
            if (!ref || /^(data|blob):/i.test(ref)) continue;
            const target = tryNormalize(ref, abs);
            if (target) nested.set(ref, await saveAsset(target, depth + 1));
          }
          /* Внутри CSS путь считается от каталога самого файла, а он лежит в assets/<xx>/,
             то есть на два уровня глубже каталога сайта. */
          body = Buffer.from(
            rewriteCss(String(body), (ref) => {
              const saved = nested.get(ref);
              return saved ? `../../${saved}` : null;
            }),
            'utf8',
          );
        }

        const put = await putAsset(siteDir, body, { url: abs, contentType: got.contentType });
        stats[put.reused ? 'reused' : 'fetched'] += 1;
        if (!put.reused) stats.bytes += put.bytes;
        result = put.rel;
      } else {
        stats.failed += 1;
      }
    } catch {
      stats.failed += 1;
    }

    byUrl.set(abs, result);
    return result;
  };

  // Ресурсы собираются заранее: rewriteDocument синхронный, а скачивание — нет.
  const wanted = new Set();
  if (assets) {
    for (const [tag, attrName] of [
      ['img', 'src'], ['img', 'data-src'], ['source', 'src'], ['video', 'src'], ['video', 'poster'],
      ['audio', 'src'], ['link', 'href'], ['object', 'data'], ['embed', 'src'],
      ...(scripts === 'keep' ? [['script', 'src']] : []),
    ]) {
      for (const el of document.querySelectorAll(`${tag}[${attrName}]`)) {
        const value = el.getAttribute(attrName);
        if (value) wanted.add(value);
      }
    }
    for (const attrName of ['srcset', 'data-srcset']) {
      for (const el of document.querySelectorAll(`[${attrName}]`)) {
        for (const part of String(el.getAttribute(attrName)).split(',')) {
          const url = part.trim().split(/\s/)[0];
          if (url) wanted.add(url);
        }
      }
    }
    for (const el of document.querySelectorAll('style')) {
      for (const found of String(el.textContent || '').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        wanted.add(found[1]);
      }
    }
  }

  const resolved = new Map();
  for (const value of wanted) {
    const rel = await saveAsset(value);
    if (rel) resolved.set(value, rel);
  }

  const passport = `Локальная копия ${pageUrl} — снята ${new Date().toISOString()}, site=${site} page=${pageId}`;
  /* Страница лежит в pages/<pageId>/, ресурсы — в assets/ от корня сайта: два уровня вверх. */
  /*
   * Всё, что не легло в архив, обязано стать абсолютным адресом.
   *
   * Оставить как было нельзя: копия лежит в sites/<site>/pages/<id>/, и относительный /other
   * разрешится в адрес стенда, а не исходного сайта. Ссылка не просто перестаёт работать — она
   * начинает указывать не туда, и разбор зеркала читает её неверно.
   */
  const keepAbsolute = (value) => {
    const raw = String(value).trim();
    /* Якорь ведёт внутрь этой же страницы. Развернув его в полный адрес, мы превратим прокрутку
       в перезагрузку документа — а на копии ещё и в поход по сети. */
    if (!raw || raw.charAt(0) === '#') return null;
    // mailto:, tel:, javascript:, data: — никуда не ведут, разворачивать нечего.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return null;

    const abs = tryNormalize(raw, pageUrl);
    return abs && abs !== raw ? abs : null;
  };

  const rewriteStats = rewriteDocument(document, {
    mapAsset: (value) => {
      const rel = resolved.get(value);
      return rel ? `../../${rel}` : keepAbsolute(value);
    },
    mapPage: (href) => {
      const abs = tryNormalize(href, pageUrl);
      const known = abs && knownPages.get(abs);
      if (known) return `../${known}/page.html`;
      return keepAbsolute(href);
    },
    scripts,
    passport,
  });

  const html = `<!doctype html>\n${document.documentElement.outerHTML}`;
  await fs.writeFile(path.join(dir, 'page.html'), html, 'utf8');

  if (stats.failed) {
    warnings.push(`Не удалось скачать ресурсов: ${stats.failed}. В зеркале они останутся битыми.`);
  }

  return {
    siteId: site,
    pageId,
    url: pageUrl,
    dir,
    files: { page: path.join(dir, 'page.html'), raw: raw ? path.join(dir, 'raw.html') : null },
    assets: stats,
    rewritten: rewriteStats,
    warnings: warnings.length ? warnings : null,
  };
}
