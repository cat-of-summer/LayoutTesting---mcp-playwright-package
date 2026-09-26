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

const frames = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/**
 * Прогнать check в базовом состоянии и в каждом из states.
 *
 * states: [{ name, steps: [{ action, selector, value, … }] }]. Между состояниями страница
 * перезагружается по тому же адресу: закрывать модалку «обратным» действием ненадёжно — у
 * каждого компонента свой способ, и незакрытая модалка отравила бы следующее состояние.
 */
export async function inStates(session, states, check, { settleMs = 400 } = {}) {
  const url = session.page.url();
  const base = await check();
  const out = {};
  for (const [index, state] of states.entries()) {
    const name = state.name || `state${index + 1}`;
    const done = [];
    try {
      for (const step of state.steps || []) {
        done.push(await perform(session, step));
      }
      await frames(session.page);
      if (settleMs) await session.page.waitForTimeout(settleMs);
      out[name] = await check();
    } catch (err) {
      out[name] = { error: `Состояние не создано на шаге ${done.length + 1}: ${err.message}`, done };
    } finally {
      await gotoAndSettle(session, url);
    }
  }
  return { base, states: out };
}
