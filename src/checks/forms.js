/**
 * Аудит форм: состояния ошибок и переходы между ними.
 *
 * Формы проверяли по конечным точкам: пустая отправка показала ошибки, полная — «Спасибо».
 * А сдали три бага, которые живут между ними:
 *   - маска телефона гасила beforeinput и не слала input, и ошибка поля не снималась, хотя
 *     номер введён верно, — ввод через fill ставит значение разом и этого не видит;
 *   - текст ошибки чекбокса при исправлении исчезал, появлялся и исчезал снова — дёргался;
 *   - ошибка поля подписки наезжала на чекбокс под ним.
 * layout_audit этого не видит: в момент аудита ошибок на странице нет.
 *
 * Здесь каждая форма проходит сценарии заново с чистой страницы, ввод идёт посимвольно, как с
 * клавиатуры, а после каждого шага снимается то, что видно: какие поля помечены, есть ли у них
 * видимый текст ошибки, что наложилось, как изменилась высота формы.
 */
import path from 'node:path';
import { perform } from '../browser/act.js';
import { gotoAndSettle } from '../browser/pool.js';
import { artifactRef, newRunId, runDir } from '../artifacts.js';
import { layoutAudit } from './layout.js';
import { describeRequestBody } from '../browser/routes.js';

/** Значения по типу поля: заведомо годные и заведомо негодные. */
export const SAMPLE = {
  email: { valid: 'test@example.com', invalid: 'test@' },
  tel: { valid: '9991234567', invalid: '12' },
  url: { valid: 'https://example.com', invalid: 'example' },
  number: { valid: '5', invalid: 'abc' },
  date: { valid: '2026-01-15', invalid: '' },
  password: { valid: 'Passw0rd!2026', invalid: '1' },
  textarea: { valid: 'Проверка формы стендом', invalid: '' },
  text: { valid: 'Иван Иванов', invalid: '' },
};

/** Какое значение вводить в поле: своё из values, иначе по типу. */
export function sampleFor(field, kind, values = {}) {
  const own = values[field.selector] ?? (field.name ? values[field.name] : undefined);
  if (kind === 'valid' && own !== undefined) return own;
  const byType = SAMPLE[field.type] || SAMPLE.text;
  if (kind === 'invalid') {
    if (field.minLength > 1) return 'x';
    if (field.pattern) return '!';
    return byType.invalid;
  }
  return byType.valid;
}

/** Есть ли для поля осмысленное невалидное значение, кроме пустоты. */
export function hasInvalidSample(field) {
  return ['email', 'tel', 'url', 'number', 'password'].includes(field.type) || field.minLength > 1 || Boolean(field.pattern);
}

/*
 * Функции ниже уходят в страницу через page.evaluate и должны быть самодостаточны.
 */

/** Поля формы: селектор, тип, признаки валидации. */
function describeForm(formSelector) {
  const form = document.querySelector(formSelector);
  if (!form) return null;
  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let node = el; node && node !== form; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.getAttribute('name')) part += `[name="${node.getAttribute('name')}"]`;
      else {
        const same = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    return `${formSelector} ${parts.join(' > ')}`;
  };
  const labelOf = (el) =>
    (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60);
  const fields = [];
  for (const el of form.querySelectorAll('input, textarea, select')) {
    const type = el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : (el.type || 'text');
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    /* Кастомный чекбокс прячет сам input, а кликают по его label — такой считается видимым. */
    const shown = (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden') || Boolean(el.labels?.length);
    if (!shown || el.disabled) continue;
    fields.push({
      selector: cssPath(el),
      type,
      name: el.name || null,
      label: labelOf(el),
      required: el.required || el.getAttribute('aria-required') === 'true',
      pattern: el.getAttribute('pattern') || null,
      minLength: el.minLength > 0 ? el.minLength : 0,
      hiddenInput: !(rect.width > 0 && rect.height > 0),
    });
  }
  const submit =
    form.querySelector('[type="submit"]') ||
    [...form.querySelectorAll('button')].find((b) => !b.getAttribute('type') || b.getAttribute('type') === 'submit');
  const rect = form.getBoundingClientRect();
  return {
    fields,
    submit: submit ? cssPath(submit) : null,
    novalidate: form.noValidate,
    box: { w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}

/**
 * Что сейчас видно у полей: помечено ли, какой текст ошибки рядом.
 *
 * Текст ошибки ищется там, где его кладут: aria-errormessage и aria-describedby, иначе —
 * видимый текст в обёртке поля, которого не было до шага (before). Обёртка — ближайший предок,
 * в котором нет других полей.
 */
function readState({ formSelector, fields, before }) {
  const form = document.querySelector(formSelector);
  if (!form) return { gone: true };
  const visibleText = (el) => {
    if (!el) return '';
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return '';
    return (el.innerText || '').trim().replace(/\s+/g, ' ');
  };
  const wrapperOf = (el) => {
    let wrap = el.parentElement;
    while (wrap && wrap !== form && wrap.parentElement && wrap.parentElement !== form) {
      const next = wrap.parentElement;
      if (next.querySelectorAll('input:not([type="hidden"]), textarea, select').length > 1) break;
      wrap = next;
    }
    return wrap || el.parentElement;
  };
  const out = {};
  for (const field of fields) {
    const el = document.querySelector(field.selector);
    if (!el) {
      out[field.selector] = { missing: true };
      continue;
    }
    const invalid = el.getAttribute('aria-invalid') === 'true' || el.matches(':invalid');
    const ids = `${el.getAttribute('aria-errormessage') || ''} ${el.getAttribute('aria-describedby') || ''}`.trim().split(/\s+/).filter(Boolean);
    let error = ids.map((id) => visibleText(document.getElementById(id))).filter(Boolean).join(' ');
    const wrapText = visibleText(wrapperOf(el));
    if (!error && before && before[field.selector] !== undefined) {
      const was = before[field.selector];
      /* Новое в тексте обёртки — то, чего до шага не было: подпись поля там и так была. */
      if (wrapText && wrapText !== was) error = wrapText.replace(was, '').trim();
    }
    out[field.selector] = {
      invalid,
      markedAria: el.getAttribute('aria-invalid') === 'true',
      native: el.matches(':invalid') && !form.noValidate,
      ...(error ? { error: error.slice(0, 120) } : {}),
      value: el.type === 'checkbox' || el.type === 'radio' ? el.checked : String(el.value ?? '').slice(0, 60),
      wrapText,
    };
  }
  const rect = form.getBoundingClientRect();
  /* Форму прячут после успешной отправки — сама или через предка: checkVisibility видит и то и другое. */
  const hidden = !rect.width || !rect.height || (form.checkVisibility ? !form.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : false);
  return { fields: out, box: { w: Math.round(rect.width), h: Math.round(rect.height) }, ...(hidden ? { hidden: true } : {}) };
}

/** Видимые строки текста страницы: по разнице до и после отправки находится «Спасибо». */
function visibleLines() {
  const lines = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim().replace(/\s+/g, ' ');
    const el = node.parentElement;
    if (!text || !el || (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) lines.add(text.slice(0, 200));
  }
  return [...lines];
}

/**
 * Успешная отправка по состоянию формы после неё.
 *
 * Форма после успеха исчезает, прячется или сбрасывается и уступает место «Спасибо». Раньше
 * это читалось как провал: сброшенные обязательные поля снова :invalid, скрытый текст ошибки
 * пуст, высота формы ноль — и шаг valid приносил пачку errorStays и heightChanged.
 */
export function successOf(state, { linesBefore = [], linesAfter = [] } = {}) {
  const fresh = linesAfter.filter((line) => !linesBefore.includes(line));
  const message = fresh.join(' ').slice(0, 160) || undefined;
  if (state.gone) return { kind: 'gone', ...(message ? { message } : {}) };
  if (state.hidden) return { kind: 'hidden', ...(message ? { message } : {}) };
  const fields = Object.values(state.fields || {}).filter((field) => !field.missing);
  const cleared = fields.length && fields.every((field) => field.value === '' || field.value === false);
  if (cleared && message) return { kind: 'reset', message };
  return null;
}

/**
 * Запустить в странице покадровую запись положений полей и их обёрток.
 * Снимается каждые кадр до stop(): так видно, что ошибка исчезла, появилась и исчезла снова.
 */
function startTrace({ formSelector }) {
  const form = document.querySelector(formSelector);
  const targets = form ? [...form.querySelectorAll('input, textarea, select, button, label')] : [];
  const frames = [];
  let alive = true;
  const shot = () => {
    if (!alive) return;
    frames.push(
      targets.map((el) => {
        const r = el.getBoundingClientRect();
        return Math.round(r.top * 10) / 10;
      }),
    );
    if (frames.length < 600) requestAnimationFrame(shot);
  };
  requestAnimationFrame(shot);
  window.__ltTrace = {
    stop: () => {
      alive = false;
      return { frames, names: targets.map((el) => el.name || el.id || el.tagName.toLowerCase()) };
    },
  };
}

/**
 * Дёрганье: элемент сдвинулся в одну сторону больше чем на порог, а потом обратно.
 * Одиночный сдвиг — нормально: ошибка ушла, соседи поднялись. Туда-обратно — нет.
 */
export function findJitter({ frames, names }, { threshold = 2 } = {}) {
  const out = [];
  if (frames.length < 3) return out;
  for (let i = 0; i < names.length; i += 1) {
    const ys = frames.map((f) => f[i]);
    let direction = 0;
    let turns = 0;
    let amplitude = 0;
    let last = ys[0];
    for (const y of ys.slice(1)) {
      const step = y - last;
      if (Math.abs(step) <= threshold) continue;
      const sign = Math.sign(step);
      if (direction && sign !== direction) turns += 1;
      direction = sign;
      amplitude = Math.max(amplitude, Math.abs(y - ys[0]));
      last = y;
    }
    if (turns > 0) out.push({ element: names[i], turns, amplitudePx: Math.round(amplitude) });
  }
  return out;
}

/** Находки шага: помеченное без текста ошибки, наложения, рост высоты. */
export function judgeStep(step, state, { baseHeight, expectInvalid = null, expectValid = [], success = null } = {}) {
  const issues = [];
  /* После успешной отправки состояние полей уже ничего не говорит: их сбросили или спрятали. */
  if (success) return issues;
  for (const [selector, field] of Object.entries(state.fields || {})) {
    if (field.missing) continue;
    if (field.invalid && !field.error && !field.native) {
      issues.push({ kind: 'invalidWithoutText', selector, note: 'Поле помечено невалидным, а видимого текста ошибки рядом нет.' });
    }
    if (field.invalid && field.native && !field.error) {
      issues.push({
        kind: 'nativeOnly',
        selector,
        note: 'Ошибку показывает только встроенная подсказка браузера: на форме нет novalidate, своей подписи у поля нет. В макете так почти никогда не нарисовано.',
      });
    }
  }
  for (const selector of expectValid) {
    const field = state.fields?.[selector];
    if (field?.invalid || field?.error) {
      issues.push({
        kind: 'errorStays',
        selector,
        note: 'Поле исправлено годным значением, а ошибка осталась. Частая причина — маска ввода гасит beforeinput и не шлёт input, и валидатор формы не узнаёт о новом значении.',
      });
    }
  }
  if (expectInvalid) {
    const field = state.fields?.[expectInvalid];
    if (field && !field.invalid && !field.error) {
      issues.push({ kind: 'invalidAccepted', selector: expectInvalid, note: 'Негодное значение прошло без ошибки.' });
    }
  }
  if (baseHeight && state.box && Math.abs(state.box.h - baseHeight) > 1) {
    issues.push({
      kind: 'heightChanged',
      px: state.box.h - baseHeight,
      note: `Высота формы изменилась на ${state.box.h - baseHeight}px. Если в макете ошибка не раздвигает форму, это расхождение.`,
    });
  }
  return issues.map((issue) => ({ step, ...issue }));
}

const LAYOUT_CATEGORIES = ['overlaps', 'clippedText', 'boxOverflow', 'coveredText'];

/**
 * Прогнать сценарии по формам на странице.
 *
 * options: selector — какие формы (по умолчанию form), open — шаги, открывающие форму (модалка),
 * values — свои годные значения по селектору или name поля, submit — intercept | real | none,
 * maxForms.
 */
export async function auditForms(session, { selector = 'form', open = [], values = {}, submit = 'intercept', maxForms = 5 } = {}) {
  const { page } = session;
  const url = page.url();
  const runId = newRunId('forms');
  const dir = await runDir(runId);
  let shots = 0;

  const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector).catch(() => 0);
  if (!count) {
    return { forms: [], note: `На странице нет ни одной формы по селектору ${selector}. Если форма в модалке — передайте open.` };
  }

  const sent = [];
  const handler = async (route) => {
    const request = route.request();
    if (request.method() === 'GET' || !['fetch', 'xhr', 'document'].includes(request.resourceType())) return route.fallback();
    sent.push({ method: request.method(), url: request.url(), body: describeRequestBody(request) });
    if (submit === 'intercept') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"success":true}' });
    }
    return route.fallback();
  };

  const reset = async () => {
    await gotoAndSettle(session, url);
    for (const step of open) await perform(session, step);
    if (open.length) await page.waitForTimeout(300);
  };
  const shoot = async (formSelector, name) => {
    const file = path.join(dir, `${String(++shots).padStart(2, '0')}-${name}.png`);
    /* Спрятанную форму снять нельзя: ссылка на несуществующий файл хуже, чем её отсутствие. */
    const done = await page.locator(formSelector).first().screenshot({ path: file, animations: 'disabled', timeout: 3000 }).then(() => true, () => false);
    return done ? artifactRef(file).url : null;
  };
  const layoutIn = async (formSelector) => {
    const report = await layoutAudit(page, { include: [formSelector], categories: LAYOUT_CATEGORIES, maxItems: 5 });
    const found = Object.fromEntries(LAYOUT_CATEGORIES.map((c) => [c, report.counts[c] || 0]).filter(([, n]) => n));
    return Object.keys(found).length ? { counts: found, items: report.issues } : null;
  };
  const clickSubmit = async (form) => {
    if (form.submit) await perform(session, { action: 'click', selector: form.submit, timeout: 5000 });
    else await perform(session, { action: 'press', selector: form.fields.at(-1)?.selector, value: 'Enter', timeout: 5000 });
    await page.waitForTimeout(300);
  };
  const enter = async (field, value) => {
    if (field.type === 'checkbox' || field.type === 'radio') {
      const box = page.locator(field.selector).first();
      const checked = await box.isChecked().catch(() => false);
      if (Boolean(value) === checked) return;
      /* Кастомный чекбокс прячет input, и кликнуть по нему нельзя даже с force — кликают по label,
         как человек. Последний путь — click() из страницы: событие то же, что от label. */
      await box.setChecked(Boolean(value), { force: true, timeout: 2000 }).catch(() =>
        box.evaluate((el) => (el.labels?.[0] || el.closest('label') || el).click()),
      );
      return;
    }
    if (field.type === 'select') {
      const options = await page.locator(`${field.selector} option`).evaluateAll((list) => list.map((o) => o.value).filter(Boolean));
      if (options[0]) await page.locator(field.selector).first().selectOption(value || options[0]);
      return;
    }
    await perform(session, { action: 'type', selector: field.selector, value: String(value ?? ''), timeout: 5000 });
    /* Уход с поля: часть валидаторов срабатывает на blur. */
    await page.locator(field.selector).first().press('Tab').catch(() => {});
  };
  const validValue = (field) => (field.type === 'checkbox' || field.type === 'radio' ? true : sampleFor(field, 'valid', values));

  await page.route('**/*', handler);
  const forms = [];
  try {
    for (let index = 0; index < Math.min(count, maxForms); index += 1) {
      const cssSelector = await page.evaluate(
        ({ sel, i }) => {
          const el = document.querySelectorAll(sel)[i];
          if (!el) return null;
          if (!el.hasAttribute('data-lt-form')) el.setAttribute('data-lt-form', String(i));
          return `[data-lt-form="${i}"]`;
        },
        { sel: selector, i: index },
      );
      await reset();
      const mark = () =>
        page.evaluate(
          ({ sel, i }) => document.querySelectorAll(sel)[i]?.setAttribute('data-lt-form', String(i)),
          { sel: selector, i: index },
        );
      await mark();
      const form = await page.evaluate(describeForm, cssSelector);
      if (!form || !cssSelector) {
        forms.push({ index, error: 'Форма не найдена после перезагрузки.' });
        continue;
      }
      const report = { index, selector: `${selector} №${index + 1}`, fields: form.fields.map(({ selector: s, type, required, label }) => ({ selector: s, type, required, label })), steps: [], issues: [] };
      const baseHeight = form.box.h;
      const snapshot = async (before) => page.evaluate(readState, { formSelector: cssSelector, fields: form.fields, before });
      const wrapTexts = async () => {
        const state = await snapshot(null);
        return Object.fromEntries(Object.entries(state.fields || {}).map(([s, f]) => [s, f.wrapText ?? '']));
      };
      const record = async (step, state, extra = {}) => {
        const layout = await layoutIn(cssSelector);
        const shot = await shoot(cssSelector, `${index}-${step}`);
        const invalid = Object.entries(state.fields || {}).filter(([, f]) => f.invalid || f.error).map(([s, f]) => ({ selector: s, ...(f.error ? { error: f.error } : {}) }));
        report.steps.push({ step, invalid, height: state.box?.h, ...(layout ? { layout } : {}), ...(shot ? { screenshot: shot } : {}), ...(extra.success ? { success: extra.success } : {}) });
        report.issues.push(...judgeStep(step, state, { baseHeight, ...extra }));
        if (layout) report.issues.push({ step, kind: 'layout', counts: layout.counts, note: 'В этом состоянии формы что-то наложилось или обрезано — подробности в steps.' });
      };

      /* 1. Пустая отправка. */
      const pristine = await wrapTexts();
      await clickSubmit(form);
      const empty = await snapshot(pristine);
      await record('empty', empty);

      /* 2. Исправление после ошибки: каждое помеченное поле — годным значением, с записью по кадрам. */
      const flagged = form.fields.filter((f) => empty.fields?.[f.selector]?.invalid || empty.fields?.[f.selector]?.error);
      if (flagged.length) {
        for (const field of flagged) {
          await page.evaluate(startTrace, { formSelector: cssSelector });
          await enter(field, validValue(field));
          await page.waitForTimeout(400);
          const trace = await page.evaluate(() => window.__ltTrace?.stop() ?? { frames: [], names: [] });
          for (const jitter of findJitter(trace)) {
            report.issues.push({
              step: 'fix',
              kind: 'jitter',
              selector: field.selector,
              ...jitter,
              note: `При исправлении поля ${field.label || field.selector} элемент ${jitter.element} сдвинулся туда и обратно: ошибка исчезает, появляется и исчезает снова.`,
            });
          }
        }
        const fixed = await snapshot(pristine);
        await record('fix', fixed, { expectValid: flagged.map((f) => f.selector) });
      }

      /* 3. По одному негодному значению на поле, остальные годные. */
      for (const field of form.fields.filter(hasInvalidSample)) {
        await reset();
        await mark();
        const before = await wrapTexts();
        for (const other of form.fields) await enter(other, other === field ? sampleFor(field, 'invalid', values) : validValue(other));
        const sentBefore = sent.length;
        await clickSubmit(form);
        const state = await snapshot(before);
        await record(`invalid-${field.name || field.type}`, state, { expectInvalid: field.selector });
        if (sent.length > sentBefore) {
          report.issues.push({ step: `invalid-${field.name || field.type}`, kind: 'sentInvalid', selector: field.selector, note: 'Форма ушла на сервер с негодным значением.' });
        }
      }

      /* 4. Всё годное. */
      await reset();
      await mark();
      const before = await wrapTexts();
      for (const field of form.fields) await enter(field, validValue(field));
      const sentBefore = sent.length;
      const linesBefore = await page.evaluate(visibleLines).catch(() => []);
      if (submit !== 'none') await clickSubmit(form);
      const valid = await snapshot(before);
      const linesAfter = await page.evaluate(visibleLines).catch(() => []);
      const success = successOf(valid, { linesBefore, linesAfter });
      await record('valid', valid, { expectValid: form.fields.map((f) => f.selector), success });
      if (success) report.success = success;
      report.sent = sent.slice(sentBefore).map(({ method, url: to, body }) => ({ method, url: to, ...(body ? { body } : {}) }));
      if (submit !== 'none' && !report.sent.length && !valid.gone) {
        report.issues.push({ step: 'valid', kind: 'notSent', note: 'Годная форма не отправила ни одного запроса. Если отправка идёт не fetch/xhr/переходом — проверьте руками.' });
      }
      forms.push(report);
    }
  } finally {
    await page.unroute('**/*', handler).catch(() => {});
    await gotoAndSettle(session, url).catch(() => {});
  }

  const issues = forms.reduce((n, f) => n + (f.issues?.length || 0), 0);
  return {
    forms,
    issues,
    submit,
    artifacts: artifactRef(dir).url,
    note:
      'Ввод посимвольный, как с клавиатуры. Страница перезагружается перед каждым сценарием и после аудита. ' +
      (submit === 'intercept' ? 'Запросы отправки перехвачены и не ушли на сервер: ответ 200 подставлен стендом.' : ''),
  };
}
