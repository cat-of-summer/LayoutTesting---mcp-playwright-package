/**
 * Факты об HTTP-ответе, которых нет в DOM.
 *
 * Заголовки и цепочка редиректов живут только в Response, а gotoAndSettle до сих пор снимал с
 * него один статус и тут же терял остальное. Без заголовков не считаются X-Robots-Tag,
 * Cache-Control и HSTS — то есть страница с noindex в заголовке выглядит индексируемой.
 */

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
