/**
 * Факты об HTTP-ответе, которых нет в DOM.
 *
 * Заголовки и цепочка редиректов живут только в Response, а gotoAndSettle до сих пор снимал с
 * него один статус и тут же терял остальное. Без заголовков не считаются X-Robots-Tag,
 * Cache-Control и HSTS — то есть страница с noindex в заголовке выглядит индексируемой.
 */

import net from 'node:net';

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

/**
 * Проба сервера, когда переход не дождался ни байта ответа.
 *
 * Отказ соединения ловится сразу (navigationErrorHint), но бывает хуже: dev-сервер остановлен,
 * а порт держит прокси — Docker Desktop, WSL relay, traefik. Соединение принимается, ответа нет,
 * и browser_goto молча ждал 30 с load, чтобы вернуть navigationTimedOut. Проба за секунды
 * говорит, что именно с сервером: отказ, тишина на TCP, принятое соединение без ответа или
 * ответ, пришедший просто поздно (первая сборка).
 *
 * hostMap — подмена адресов сессии: браузер ходит по ней, и проба идёт туда же.
 */
export async function probeServer(url, { hostMap = null, connectMs = 2000, httpMs = 3000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const mapped = hostMap?.[parsed.hostname];
  const host = mapped || parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  const tcp = await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(connectMs, () => done('timeout'));
    socket.once('connect', () => done('accepted'));
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED' ? 'refused' : err.code || 'error'));
  });
  if (tcp !== 'accepted') return { state: tcp === 'refused' ? 'refused' : 'unreachable', tcp, host, port };
  const started = Date.now();
  try {
    const target = new URL(url);
    if (mapped) target.hostname = mapped;
    const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(httpMs), headers: mapped ? { host: parsed.host } : {} });
    await res.body?.cancel().catch(() => {});
    return { state: 'responds', status: res.status, ms: Date.now() - started, host, port };
  } catch (err) {
    const message = String(err.cause?.message || err.message);
    const silent = err.name === 'TimeoutError' || err.name === 'AbortError' || /other side closed|socket hang up|ECONNRESET/i.test(message);
    return { state: silent ? 'acceptedNoResponse' : 'error', error: message.slice(0, 160), host, port };
  }
}

/** Подсказка по итогу пробы: что делать, а не только что случилось. */
export function probeHint(probe, url) {
  if (!probe) return null;
  const where = `${probe.host}:${probe.port}`;
  switch (probe.state) {
    case 'refused':
      return navigationErrorHint('ECONNREFUSED', url) || `На ${where} никто не слушает: сервер не запущен.`;
    case 'unreachable':
      return `${where} не отвечает даже на TCP (${probe.tcp}): адрес недоступен из контейнера стенда — неверный IP, фаервол или сеть Docker.`;
    case 'acceptedNoResponse':
      return (
        `${where} принимает соединение, но не присылает ни байта ответа: процесс dev-сервера, скорее всего, остановлен или завис, ` +
        'а порт держит прокси (Docker Desktop, WSL relay, traefik). Перезапустите dev-сервер — фоновая задача прошлой сессии агента ' +
        'останавливается вместе с ней — и повторите browser_goto. Если сервер жив и просто собирает страницу дольше таймаута — поднимите timeout.'
      );
    case 'responds':
      return `Сейчас сервер отвечает (${probe.status} за ${probe.ms} мс): первый ответ просто задержался — обычно это первая сборка dev-сервера. Повторите browser_goto.`;
    default:
      return `Проба ${where} не удалась: ${probe.error}.`;
  }
}

/**
 * Стоит ли вкладка на странице-ошибке браузера, а не на документе.
 *
 * Перезапуск dev-сервера уводит вкладку на chrome-error://chromewebdata/, и после этого каждый
 * инструмент честно отвечает «элемент не найден»: по пустой странице это правда, но на вопрос
 * агента ответ не тот, и поиск уходит в вёрстку, где искать нечего.
 *
 * about:blank сюда намеренно не входит, хотя после падения вкладка попадает и туда: это же —
 * обычное начальное состояние только что открытой сессии. Признак, срабатывающий на каждом
 * первом переходе, перестают читать, и вместе с ним перестают читать настоящий случай.
 *
 * Оговорка по движкам: адрес страницы-ошибки подставляет chromium. firefox и webkit оставляют в
 * page.url() запрошенный адрес, и отличить их состояние отсюда нельзя — там о неудаче говорит
 * сама ошибка перехода и page_logs.
 */
export function isErrorPage(url) {
  return String(url || '').startsWith('chrome-error://');
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
