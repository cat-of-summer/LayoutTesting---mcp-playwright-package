/**
 * robots.txt и sitemap.xml.
 *
 * Разбор свой, а не библиотечный: правил тут немного, а поведение на краях важно понимать
 * дословно — от него зависит, постучимся ли мы туда, куда нас не звали.
 *
 * Что реализовано по спецификации, а не «примерно»:
 *   - выигрывает самое длинное совпавшее правило, а при равной длине — Allow;
 *   - группы User-agent слипаются: несколько строк подряд задают одну группу правил;
 *   - точная наша группа перебивает *, а не дополняет её;
 *   - пустой Disallow разрешает всё, Disallow: / запрещает всё.
 *
 * Последний пункт — не педантизм: перепутать пустой Disallow с отсутствующим значит либо
 * закрыть себе весь сайт, либо пойти обходить закрытый.
 */

const clean = (line) => line.replace(/#.*$/, '').trim();

export function parseRobots(text) {
  const groups = new Map();
  const sitemaps = [];

  let current = [];
  /* Пока идут подряд строки User-agent, они задают одну группу. Первая директива после них
     закрывает набор агентов, и следующий User-agent начнёт новую группу. */
  let collectingAgents = false;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = clean(rawLine);
    if (!line) continue;

    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!collectingAgents) {
        current = [];
        collectingAgents = true;
      }
      const agent = value.toLowerCase();
      current.push(agent);
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [], crawlDelay: null });
      continue;
    }

    collectingAgents = false;
    if (!current.length) continue;

    for (const agent of current) {
      const group = groups.get(agent);
      if (field === 'allow' && value) group.allow.push(value);
      else if (field === 'disallow') group.disallow.push(value);
      else if (field === 'crawl-delay') {
        const n = Number(value.replace(',', '.'));
        if (Number.isFinite(n)) group.crawlDelay = n;
      }
    }
  }

  return { groups, sitemaps };
}

/** Шаблон robots понимает только * и $ — остальное экранируем, иначе точка совпадёт с чем угодно. */
function patternToRegExp(pattern) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '$') source += '$';
    else source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source);
}

function matchLength(rules, target) {
  let best = -1;
  for (const rule of rules) {
    if (rule === '') continue;
    if (patternToRegExp(rule).test(target)) best = Math.max(best, rule.length);
  }
  return best;
}

/**
 * Правила для нашего агента.
 *
 * Точное совпадение полностью заменяет группу *, а не складывается с ней: сайт, отдельно
 * разрешивший что-то нашему боту, не должен получить сверху ещё и общие запреты.
 */
export function groupFor(parsed, userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  for (const [name, group] of parsed.groups) {
    if (name !== '*' && ua.includes(name)) return group;
  }
  return parsed.groups.get('*') || { allow: [], disallow: [], crawlDelay: null };
}

export function isAllowed(parsed, userAgent, url) {
  const group = groupFor(parsed, userAgent);
  if (!group.disallow.length) return true;

  const target = (() => {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  })();

  /* Пустой Disallow — это «ничего не запрещено», и в подсчёт длин он не входит:
     иначе он совпал бы с любым путём с длиной 0 и перебил бы разрешения. */
  const denied = matchLength(group.disallow, target);
  if (denied < 0) return true;
  const allowed = matchLength(group.allow, target);
  return allowed >= denied;
}

/** Задержка из robots уважается, но не ниже своей: сайт может попросить и медленнее. */
export function crawlDelayMs(parsed, userAgent, fallbackMs) {
  const group = groupFor(parsed, userAgent);
  if (group.crawlDelay === null) return fallbackMs;
  return Math.max(fallbackMs, Math.round(group.crawlDelay * 1000));
}

/**
 * Разбор sitemap.
 *
 * Отдельного XML-парсера не заводим: теги sitemap строчные и плоские, а linkedom их разбирает.
 * Индексный sitemap отличается от обычного корневым тегом, и это единственная развилка.
 */
export async function parseSitemap(xml) {
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(String(xml || ''));

  const textOf = (el, tag) => {
    const found = el.querySelector(tag);
    return found ? String(found.textContent || '').trim() : null;
  };

  const isIndex = Boolean(document.querySelector('sitemapindex'));
  const nodes = Array.from(document.querySelectorAll(isIndex ? 'sitemap' : 'url'));

  const entries = nodes
    .map((el) => ({
      loc: textOf(el, 'loc'),
      lastmod: textOf(el, 'lastmod'),
      changefreq: textOf(el, 'changefreq'),
      priority: textOf(el, 'priority'),
    }))
    .filter((e) => e.loc);

  return { isIndex, entries, total: entries.length };
}
