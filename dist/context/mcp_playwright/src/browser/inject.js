/**
 * Инъекции CSS и JS, переживающие навигацию.
 *
 * Основной приём при работе с чужим стендом — вкатить свой патч поверх боевой страницы
 * и посмотреть, что получилось. Без реестра патч приходится повторять после каждого
 * перехода, и половина вызовов уходит на это.
 *
 * Реестр живёт в сессии; применяется сразу при добавлении и заново после каждого
 * gotoAndSettle — уже после stabilize, чтобы патч был последним в каскаде.
 */

const MARK = 'data-lt-inject';

let counter = 0;
const nextId = (kind) => `${kind}-${(counter += 1)}`;

export function listInjections(session) {
  return (session.injections || []).map(({ id, kind, href, source }) => ({
    id,
    kind,
    href,
    size: source ? source.length : null,
  }));
}

/** Применяет одну инъекцию к текущей странице. */
async function applyOne(page, item) {
  if (item.kind === 'js') {
    await page.evaluate(item.source);
    return;
  }
  if (item.href) {
    await page.addStyleTag({ url: item.href });
    return;
  }
  // Метку ставим отдельным вызовом: addStyleTag не умеет атрибуты.
  await page.evaluate(
    ([mark, id, css]) => {
      document.querySelectorAll(`style[${mark}="${id}"]`).forEach((n) => n.remove());
      const el = document.createElement('style');
      el.setAttribute(mark, id);
      el.textContent = css;
      document.head.appendChild(el);
    },
    [MARK, item.id, item.source],
  );
}

/** Переприменение после навигации. Ошибки не роняют переход: страница важнее патча. */
export async function reapplyInjections(session) {
  for (const item of session.injections || []) {
    await applyOne(session.page, item).catch(() => {});
  }
}

export async function addInjection(session, { css, js, href, id }) {
  if (!css && !js && !href) throw new Error('Нужен css, js или href.');
  session.injections = session.injections || [];

  const item = {
    id: id || nextId(js ? 'js' : 'css'),
    kind: js ? 'js' : 'css',
    source: js || css || null,
    href: href || null,
  };
  // Повторное добавление под тем же id заменяет прежнюю инъекцию, а не копит дубли.
  session.injections = session.injections.filter((x) => x.id !== item.id);
  session.injections.push(item);

  await applyOne(session.page, item);
  return item;
}

export async function removeInjection(session, id) {
  const before = (session.injections || []).length;
  session.injections = (session.injections || []).filter((x) => x.id !== id);
  await session.page
    .evaluate(
      ([mark, target]) => {
        document.querySelectorAll(`style[${mark}="${target}"]`).forEach((n) => n.remove());
      },
      [MARK, id],
    )
    .catch(() => {});
  // JS отменить нельзя: он уже выполнился. Об этом честно сообщаем вызывающему.
  return { removed: before !== session.injections.length, note: 'Снимается только CSS: выполненный JS не откатывается — перезагрузите страницу.' };
}

export async function clearInjections(session) {
  const count = (session.injections || []).length;
  session.injections = [];
  await session.page
    .evaluate((mark) => {
      document.querySelectorAll(`style[${mark}]`).forEach((n) => n.remove());
    }, MARK)
    .catch(() => {});
  return count;
}
