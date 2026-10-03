/**
 * Маскировка аргументов перед записью в журнал использования.
 *
 * Журнал пишет аргументы целиком: без них не разобрать, какой параметр агент понял не так. Но
 * в аргументах бывают доступы, заголовки, куки и вводимые в формы пароли, а журнал потом уходит
 * с машины пользователя. Поэтому значения таких полей заменяются длиной, а не выбрасываются:
 * «передан ли пароль и какой длины» для разбора полезно, сам пароль — нет.
 */

/** Предел одной строки в журнале. browser_eval.expression и тексты ошибок длиннее не бывают полезны. */
export const MAX_STRING = 4096;

/** Ключи, чьё значение не пишется ни на какой глубине. */
const SECRET_KEY = /^(auth|authorization|password|passwd|pass|token|secret|cookies?|storageState|apiKey|api_key)$/i;

/** Действия, у которых value — то, что вводится в поле, а не клавиша или ответ диалога. */
const TYPED_ACTIONS = new Set(['fill', 'type']);

const hidden = (value) => {
  const size = typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
  return `[скрыто: ${size} симв.]`;
};

/** user:pass@ в адресе: README прямо предупреждает, что так делают. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

export function scrubString(value) {
  const clean = value.replace(URL_CREDENTIALS, '$1[скрыто]@');
  return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}… [обрезано, всего ${clean.length} симв.]` : clean;
}

function walk(value, depth) {
  if (typeof value === 'string') return scrubString(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > 8) return '[глубже 8 уровней]';
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) out[key] = hidden(item);
    else if (key === 'extraHTTPHeaders' && item && typeof item === 'object') out[key] = hideValues(item);
    /* Шаг browser_act — и сам вызов, и шаги states/open внутри проверок. */
    else if (key === 'value' && TYPED_ACTIONS.has(value.action)) out[key] = hidden(item);
    else out[key] = walk(item, depth + 1);
  }
  return out;
}

/** Имена заголовков оставляем: по ним видно, зачем агент их ставил. */
function hideValues(object) {
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, hidden(item)]));
}

/**
 * Аргументы вызова в виде, пригодном для журнала.
 *
 * Правила по имени инструмента — для тех полей, чьё имя ничего не говорит: value у
 * browser_storage — это JSON с куками, values у form_audit — годные значения полей, среди
 * которых бывает пароль.
 */
export function redactArgs(tool, args) {
  if (!args || typeof args !== 'object') return args ?? null;
  const out = walk(args, 0);
  if (tool === 'browser_storage' && 'value' in args) out.value = hidden(args.value);
  if (tool === 'form_audit' && args.values && typeof args.values === 'object') out.values = hideValues(args.values);
  return out;
}
