/**
 * Пакет шагов browser_act: несколько действий одним вызовом.
 *
 * Каждое действие отдельным вызовом — это сотни миллисекунд между ними на круг до агента и
 * обратно. В игре в реальном времени эта задержка меняет результат: восемь пробелов в
 * танчиках, разнесённые по восьми вызовам, — другая игра, чем восемь пробелов подряд. Агенты
 * обходили это через browser_eval с dispatchEvent и setTimeout внутри (в журнале таких 85), а
 * синтетические события страница отличает по isTrusted.
 *
 * Здесь шаги идут подряд в одном процессе, паузы — wait с duration, промежуточные кадры —
 * screenshot, чтение состояния игры — eval. Время каждого шага отдаётся от начала пакета.
 */
import { z } from 'zod';
import { ACTIONS, perform } from './act.js';
import { evaluateOnPage } from './evaluate.js';
import { takeScreenshot } from '../checks/visual.js';
import { newRunId, slug } from '../artifacts.js';
import { exportFile } from '../exports.js';

/** Больше — это уже сценарий, а не пакет: его пишут кодом и гоняют иначе. */
export const MAX_STEPS = 200;

/** Значение eval в пакете: шагов много, и один innerHTML не должен вытеснить остальные. */
const MAX_EVAL_CHARS = 4000;

/**
 * Строгая схема шага. В манифесте steps объявлен массивом объектов без полей — поля те же, что
 * у самого вызова, и платить за них в манифесте второй раз незачем. Проверяется здесь, а
 * лишнее поле — ошибка, а не молчание: опечатка в duration иначе дала бы паузу в ноль.
 */
const stepParser = z
  .object({
    action: z.enum([...ACTIONS, 'screenshot', 'eval']),
    selector: z.string().optional(),
    value: z.string().optional(),
    files: z.array(z.string()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    to: z.object({ x: z.number(), y: z.number() }).optional(),
    duration: z.number().nonnegative().optional(),
    timeout: z.number().optional(),
    force: z.boolean().optional(),
    /* screenshot */
    name: z.string().optional(),
    fullPage: z.boolean().optional(),
    saveTo: z.string().optional(),
    /* eval */
    expression: z.string().optional(),
  })
  .strict();

function parseStep(raw, i) {
  const parsed = stepParser.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'шаг'}: ${issue.message}`).join('; ');
  throw new Error(`Шаг ${i}: ${issues}`);
}

/**
 * Выполнить шаги по порядку. На первой ошибке — стоп: дальше шаги шли бы по состоянию, которого
 * агент не ждёт. Выполненное возвращается вместе с ошибкой, чтобы не повторять его вслепую.
 */
export async function runSteps(session, steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps — непустой массив шагов.');
  if (steps.length > MAX_STEPS) throw new Error(`В пакете ${steps.length} шагов, предел ${MAX_STEPS}. Разбейте на несколько вызовов.`);
  /* Шаги проверяются до первого действия: ошибка в десятом шаге не должна оставить страницу
     посреди сценария после девяти выполненных. */
  const parsed = steps.map((raw, i) => parseStep(raw, i));

  const started = Date.now();
  const done = [];
  let runId = null;
  for (const [i, step] of parsed.entries()) {
    const at = Date.now() - started;
    try {
      let out;
      if (step.action === 'screenshot') {
        runId ??= newRunId('steps');
        out = await shoot(session, step, i, runId);
      } else if (step.action === 'eval') {
        out = await evaluate(session, step);
      } else {
        out = await perform(session, step);
      }
      done.push({ i, atMs: at, ms: Date.now() - started - at, ...out });
    } catch (err) {
      return { steps: done, failed: { i, action: step.action, atMs: at, error: err.message } };
    }
  }
  return { steps: done, totalMs: Date.now() - started };
}

async function shoot(session, step, i, runId) {
  const name = step.name || `step-${i}`;
  const shot = await takeScreenshot(session.page, {
    runId,
    name: `${slug(name)}__${slug(session.key)}`,
    fullPage: step.fullPage ?? false,
    selector: step.selector,
    timeout: step.timeout,
  });
  const out = { action: 'screenshot', ...(step.selector ? { selector: step.selector } : {}), ...shot };
  if (step.saveTo) out.savedTo = await exportFile(shot.path, step.saveTo, { url: shot.url });
  return out;
}

async function evaluate(session, step) {
  if (!step.expression) throw new Error('Для eval нужен expression.');
  const result = await evaluateOnPage(session.page, step.expression);
  const serialized = JSON.stringify(result.value ?? null) ?? 'null';
  if (serialized.length <= MAX_EVAL_CHARS) return { action: 'eval', type: result.type, value: result.value ?? null, ...(result.note ? { note: result.note } : {}) };
  return {
    action: 'eval',
    type: result.type,
    value: serialized.slice(0, MAX_EVAL_CHARS),
    truncated: true,
    note: `Значение — ${serialized.length} символов, показаны первые ${MAX_EVAL_CHARS}. Верните нужные поля, а не узел целиком.`,
  };
}
