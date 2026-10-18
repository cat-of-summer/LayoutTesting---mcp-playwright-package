/**
 * Проверка в состояниях страницы: открытая модалка, раскрытое меню, форма с ошибками.
 *
 * Аудит смотрит на то, что страница показывает в момент вызова. Крестик модалки 15×15 и
 * наложение текста ошибки на чекбокс в этот момент скрыты, и отчёт честно говорит «ноль» —
 * по странице, на которой ничего не открыто. Здесь состояние сначала создаётся теми же
 * действиями, что у browser_act, проверяется, и страница возвращается перезагрузкой.
 */
import { perform } from '../browser/act.js';
import { gotoAndSettle } from '../browser/pool.js';
import { layoutAudit, widthSummary } from './layout.js';

const frames = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/*
 * Таймаут шага состояния. Раньше шаг ждал умолчание контекста — 30 секунд, — и кнопка фильтров,
 * которой нет на десктопе, стоила полминуты на каждую ширину. Модалку и меню открывают элементы,
 * которые уже на странице; пяти секунд хватает с запасом, как у form_audit.
 */
export const STEP_TIMEOUT_MS = 5000;

/* Действия над элементом: перед ними проверяется, виден ли он вообще. */
const ELEMENT_ACTIONS = new Set(['click', 'hover', 'fill', 'type', 'select', 'upload', 'tap']);

/* Сколько ждать появления цели первого шага, прежде чем счесть состояние неприменимым. */
const APPEAR_MS = 1500;

/* Потолок раскрытия each: карта на сорок пинов — это сорок перезагрузок. */
const EACH_MAX = 12;

/** Шаг не выполнен, потому что его цели на этой ширине нет на экране. */
class NotApplicable extends Error {}

/**
 * Раскрыть элементы states с each в отдельные состояния.
 *
 * { each: "[data-pin]", action: "click", steps?: [...] } — кликнуть каждый пин по очереди и
 * проверить страницу после каждого клика. Карточка «Восточный», закрывающая подпись
 * «Байконур», есть только после клика по своему пину, а в макете нарисован один Байконур:
 * перечислять пины руками никто не станет.
 */
export async function expandStates(page, states = []) {
  const out = [];
  for (const [index, state] of states.entries()) {
    if (!state.each) {
      out.push({ ...state, name: state.name || `state${index + 1}` });
      continue;
    }
    const group = page.locator(state.each);
    const count = await group.count();
    const base = state.name || state.each;
    if (!count) {
      out.push({ name: base, missing: `each: по селектору ${state.each} на странице ничего нет` });
      continue;
    }
    const limit = Math.min(count, state.max || EACH_MAX);
    for (let i = 0; i < limit; i += 1) {
      const selector = `${state.each} >> nth=${i}`;
      const label = await group
        .nth(i)
        .evaluate((el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 30))
        .catch(() => '');
      out.push({
        name: `${base} [${i + 1}]${label ? ` ${label}` : ''}`,
        steps: [{ action: state.action || 'click', selector }, ...(state.steps || [])],
        ...(i === 0 && count > limit ? { note: `each: показаны первые ${limit} из ${count}` } : {}),
      });
    }
  }
  return out;
}

/**
 * Создать состояние: шаги по очереди, с коротким таймаутом.
 *
 * Цель первого шага не видна — состояние на этой ширине неприменимо (NotApplicable), а не
 * сломано: кнопка фильтров есть только на мобильном, и на 1440 её отсутствие — норма.
 * Не видна цель следующего шага — это уже дефект: меню открылось, а пункта в нём нет.
 */
async function createState(session, state) {
  const done = [];
  let first = true;
  for (const step of state.steps || []) {
    if (first && step.selector && ELEMENT_ACTIONS.has(step.action)) {
      const visible = await session.page
        .locator(step.selector)
        .first()
        .waitFor({ state: 'visible', timeout: APPEAR_MS })
        .then(() => true)
        .catch(() => false);
      if (!visible) throw new NotApplicable(`шаг ${done.length + 1}: ${step.selector} не виден`);
    }
    if (step.selector || step.action !== 'wait') first = false;
    try {
      done.push(await perform(session, { ...step, timeout: step.timeout ?? STEP_TIMEOUT_MS }));
    } catch (err) {
      err.done = done;
      err.step = done.length + 1;
      throw err;
    }
  }
  await frames(session.page);
  return done;
}

/**
 * Прогнать check в базовом состоянии и в каждом из states.
 *
 * states: [{ name, steps: [{ action, selector, value, … }] }] или { each, action }. Между
 * состояниями страница перезагружается по тому же адресу: закрывать модалку «обратным»
 * действием ненадёжно — у каждого компонента свой способ, и незакрытая модалка отравила бы
 * следующее состояние.
 */
export async function inStates(session, states, check, { settleMs = 400 } = {}) {
  const url = session.page.url();
  const base = await check();
  const out = {};
  const width = session.page.viewportSize()?.width;
  for (const state of await expandStates(session.page, states)) {
    const { name } = state;
    if (state.missing) {
      out[name] = { error: state.missing };
      continue;
    }
    try {
      await createState(session, state);
      if (settleMs) await session.page.waitForTimeout(settleMs);
    } catch (err) {
      out[name] =
        err instanceof NotApplicable
          ? { skipped: `${err.message} на ширине ${width}px — состояние здесь не применимо; другую ширину задайте через widths` }
          : { error: `Состояние не создано на шаге ${err.step}: ${err.message}`, done: err.done };
      await gotoAndSettle(session, url);
      continue;
    }
    try {
      out[name] = { ...(await check()), ...(state.note ? { note: state.note } : {}) };
    } catch (err) {
      out[name] = { error: `Состояние создано, но проверка в нём упала: ${err.message}` };
    } finally {
      await gotoAndSettle(session, url);
    }
  }
  return { base, states: out };
}

/**
 * layout_audit в состояниях на нескольких ширинах: ширина снаружи, состояние внутри.
 *
 * Раньше шаги выполнялись один раз на исходной ширине, а по ширинам гонялся уже готовый снимок.
 * Кнопка фильтров, которой нет на 1440, роняла состояние целиком — и для мобильных ширин тоже,
 * после тридцати секунд ожидания. Теперь состояние создаётся заново на каждой ширине, и ширина,
 * где его цели не видно, помечается skipped, не трогая остальные.
 */
export async function inStatesAcrossWidths(session, states, widths, options = {}, { settleMs = 400 } = {}) {
  const { page } = session;
  const url = page.url();
  const original = page.viewportSize() || { width: 1440, height: 900 };
  const auditOptions = { ...options, maxItems: Math.min(options.maxItems || 50, 10) };
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  const base = {};
  const out = {};
  const slot = (name) => (out[name] ||= { byWidth: {} });

  try {
    for (const width of sorted) {
      await page.setViewportSize({ width, height: original.height });
      await gotoAndSettle(session, url);
      base[width] = widthSummary(await layoutAudit(page, auditOptions));
      for (const state of await expandStates(page, states)) {
        const entry = slot(state.name);
        if (state.missing) {
          entry.byWidth[width] = { error: state.missing };
          continue;
        }
        if (state.note) entry.note = state.note;
        try {
          await createState(session, state);
          if (settleMs) await page.waitForTimeout(settleMs);
          entry.byWidth[width] = widthSummary(await layoutAudit(page, auditOptions));
        } catch (err) {
          entry.byWidth[width] =
            err instanceof NotApplicable
              ? { skipped: `${err.message} на ${width}px — состояние на этой ширине не применимо` }
              : { error: err.step ? `шаг ${err.step}: ${err.message}` : `проверка упала: ${err.message}` };
        } finally {
          await gotoAndSettle(session, url);
        }
      }
    }
  } finally {
    await page.setViewportSize(original);
    await gotoAndSettle(session, url);
  }

  for (const entry of Object.values(out)) {
    const results = Object.entries(entry.byWidth);
    entry.applicable = results.filter(([, r]) => !r.skipped && !r.error).map(([w]) => Number(w));
    const skipped = results.filter(([, r]) => r.skipped).map(([w]) => Number(w));
    if (skipped.length) entry.skippedOn = skipped;
    if (!entry.applicable.length) {
      entry.error = skipped.length === results.length
        ? `Состояние не применимо ни на одной ширине (${sorted.join(', ')}): цель первого шага нигде не видна — проверьте селектор`
        : 'Состояние не создано ни на одной ширине — подробности в byWidth';
    }
  }
  const worst = Object.entries(base)
    .map(([width, r]) => ({ width: Number(width), total: r.total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
  return {
    widths: sorted,
    base: { byWidth: base, worst },
    states: out,
    note: 'Состояние создаётся заново на каждой ширине; skipped — цели первого шага на этой ширине не видно (кнопка только для мобильного), это не ошибка. Окно возвращено к исходному размеру.',
  };
}
