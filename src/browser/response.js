/**
 * Факты об HTTP-ответе, которых нет в DOM.
 *
 * Заголовки и цепочка редиректов живут только в Response, а gotoAndSettle до сих пор снимал с
 * него один статус и тут же терял остальное. Без заголовков не считаются X-Robots-Tag,
 * Cache-Control и HSTS — то есть страница с noindex в заголовке выглядит индексируемой.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * Подсказка к отказу соединения.
 *
 * Про адресацию из контейнера сказано в instructions и в help, но читают это до работы, а
 * вспоминают — после ERR_CONNECTION_REFUSED, и тогда уходит четыре-пять вызовов на догадки:
 * 172.18.0.1, потом 403 от Vite, потом allowedHosts. Рецепт должен стоять в самой ошибке.
 */
export function navigationErrorHint(message, url) {
  if (!/ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_UNKNOWN_HOST|Could not connect|ECONNREFUSED/i.test(String(message))) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (LOCAL_HOSTS.has(parsed.hostname)) {
    const target = new URL(url);
    target.hostname = 'host.docker.internal';
    return (
      `Стенд работает в контейнере: ${parsed.hostname} внутри него — сам стенд, а не машина человека. ` +
      `Dev-сервер с хоста открывайте как ${target.toString()}, а сам сервер поднимайте на 0.0.0.0 ` +
      '(vite --host, astro dev --host 0.0.0.0, next dev -H 0.0.0.0). Vite и Astro без server.allowedHosts ' +
      "с 'host.docker.internal' ответят 403. Проект в общей docker-сети — по имени его контейнера."
    );
  }
  if (parsed.hostname === 'host.docker.internal') {
    return (
      `На ${parsed.host} никто не отвечает: сервер не запущен либо слушает только 127.0.0.1 — ` +
      'снаружи контейнера его так не видно. Поднимите его на 0.0.0.0.'
    );
  }
  return null;
}

/** 403 от dev-сервера, отвергшего имя хоста: у Vite это «Blocked request», у webpack — «Invalid Host header». */
export function blockedHostHint(status, body, url) {
  if (status !== 403 || !/Blocked request|is not allowed|allowedHosts|Invalid Host header/i.test(String(body || ''))) return null;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* Имя в подсказке тогда целым адресом — это не повод её терять. */
  }
  return `Dev-сервер отверг имя хоста ${host}. Vite и Astro: server.allowedHosts: ['${host}'] в конфиге; webpack-dev-server: allowedHosts: 'all'. После правки конфига сервер перезапустите.`;
}

/** Тот же адрес без якоря: переход на него — перепроверка, а не новая страница. */
export function sameDocument(current, next) {
  try {
    const a = new URL(current);
    const b = new URL(next);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

export async function responseFacts(response) {
  if (!response) return { status: null, headers: null, redirects: [] };

  /* Цепочка разворачивается от последнего запроса к первому — переворачиваем, чтобы читалась
     в порядке переходов, как её видел браузер. */
  const redirects = [];
  let hop = response.request().redirectedFrom();
  while (hop) {
    redirects.unshift(hop.url());
    hop = hop.redirectedFrom();
  }

  let headers = null;
  try {
    headers = await response.allHeaders();
  } catch {
    // После следующего перехода заголовки бывают уже недоступны. Это не повод терять статус.
    headers = null;
  }

  return { status: response.status(), headers, redirects };
}
