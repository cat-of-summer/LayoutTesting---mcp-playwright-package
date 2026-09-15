import fs from 'node:fs/promises';
import path from 'node:path';
import stylelint from 'stylelint';
import { HtmlValidate } from 'html-validate';
import { CONFIG, DIRS } from '../config.js';
import { resolveInRoot } from '../paths.js';

/**
 * Nu HTML Checker — эталонный валидатор разметки. Отправляем содержимое,
 * а не URL: так же проверяется отрендеренный DOM и локальные файлы.
 */
export async function validateHtmlWithVnu(html, { maxMessages = 50, strict = false, ignore = null } = {}) {
  const res = await fetch(`${CONFIG.vnuUrl}/?out=json`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  });
  if (!res.ok) {
    throw new Error(`vnu ответил ${res.status}. Проверьте, что контейнер vnu поднят (${CONFIG.vnuUrl}).`);
  }
  const data = await res.json();
  return splitVnuMessages(data.messages || [], { maxMessages, strict, ignore });
}

/**
 * Соглашения проекта, которые валидатор не знает: пользовательские теги, атрибуты компонентов,
 * классы-контейнеры библиотеки шаблона.
 *
 * Это не known: known — отставание валидатора от платформы, общее для всех; ignore — решение
 * человека для этого проекта. Отфильтрованное не исчезает, а считается отдельно в ignored:
 * 38 сообщений, из которых 29 — библиотечные, и 9 настоящих — это разные ситуации, и обе
 * должны быть видны.
 */
export function buildIgnore(ignore) {
  if (!ignore) return null;
  const messages = (ignore.messages || []).map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch {
      return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  });
  const tags = (ignore.tags || []).map((tag) => new RegExp(`(Element|element|tag) .${String(tag).toLowerCase()}.`, 'i'));
  const attributes = (ignore.attributes || []).map((attribute) => new RegExp(`Attribute .${String(attribute).toLowerCase()}.`, 'i'));
  const rules = [
    ...messages.map((re, index) => ({ id: `message:${ignore.messages[index]}`, test: re })),
    ...tags.map((re, index) => ({ id: `tag:${ignore.tags[index]}`, test: re })),
    ...attributes.map((re, index) => ({ id: `attribute:${ignore.attributes[index]}`, test: re })),
  ];
  if (!rules.length) return null;
  return (message) => rules.find((rule) => rule.test.test(String(message || '')))?.id || null;
}

/** Отфильтрованное по ignore — отдельной корзиной, чтобы объём шума оставался частью отчёта. */
export function applyIgnore(messages, matcher) {
  if (!matcher) return { kept: messages, ignored: null };
  const byRule = {};
  const kept = [];
  for (const message of messages) {
    const id = matcher(message.message);
    if (!id) {
      kept.push(message);
      continue;
    }
    byRule[id] = (byRule[id] || 0) + 1;
  }
  const count = messages.length - kept.length;
  return {
    kept,
    ignored: count
      ? {
          count,
          byRule,
          note: 'Отфильтровано по ignore — соглашения проекта, а не ошибки разметки. В total не входит; список правил и счёт по каждому здесь, чтобы фильтр не спрятал лишнего.',
        }
      : null,
  };
}

/**
 * Атрибуты, которых валидатор не знает, а платформа уже умеет.
 *
 * Отставание Nu не ограничено встроенным CSS: словарь атрибутов у него тоже свой, и popover,
 * inert, fetchpriority дают десятки «ошибок» ровно там, где разметка верна. Держать их в общем
 * счёте — значит заставлять выискивать две настоящие ошибки среди тридцати ожидаемых.
 *
 * Список именной, а не выведенный из спецификации: у стенда нет способа узнать, что валидатор
 * отстал, — есть только знание, по каким именно местам. Отсюда и слабость, которую надо называть
 * вслух: опечатка popver прячется вместе с правильными, и достать её можно только strict: true.
 */
const KNOWN_LIMITS = [
  { id: 'popover', why: 'Popover API', test: /Attribute .(popover|popovertarget|popovertargetaction)./i },
  { id: 'invoker', why: 'Invoker Commands API', test: /Attribute .(command|commandfor)./i },
  { id: 'inert', why: 'inert', test: /Attribute .inert./i },
  { id: 'priorityHints', why: 'Priority Hints', test: /Attribute .(fetchpriority|blocking)./i },
  { id: 'writingsuggestions', why: 'writingsuggestions', test: /Attribute .writingsuggestions./i },
  { id: 'shadowrootmode', why: 'декларативный Shadow DOM', test: /Attribute .shadowroot(mode|delegatesfocus|clonable|serializable)./i },
  { id: 'svgXlink', why: 'xlink в инлайновом SVG из экспорта', test: /xlink:href|xmlns:xlink/i },
];

const classifyKnown = (message) => KNOWN_LIMITS.find((entry) => entry.test.test(String(message || '')))?.id || null;

/* Показаны не все записи. Молчаливое усечение читается как «больше ничего нет» — а это не так. */
const clippedNote = (total, shown) =>
  total > shown
    ? `Показано ${shown} из ${total}. Остальные не проверены — повторите с maxMessages: ${total}, прежде чем считать разметку разобранной.`
    : null;

/**
 * Сообщения vnu: настоящие находки отдельно, заведомо ложные — отдельно.
 *
 * CSS-валидатор внутри Nu отстаёт от браузеров на годы: @property, container-type, cqw,
 * field-sizing, :modal для него «ошибки». На странице с современными стилями это сотни записей,
 * и две настоящие ошибки разметки приходится выискивать среди них глазами. CSS-сообщения Nu
 * помечает префиксом «CSS:» — по нему и делим; тем же способом уезжает в known то, что назвал
 * KNOWN_LIMITS. Счёт и примеры у обеих корзин остаются, в общий итог они не идут.
 */
export function splitVnuMessages(raw, { maxMessages = 50, strict = false, ignore = null } = {}) {
  const all = raw.map((m) => ({
    type: m.subType || m.type,
    message: m.message,
    line: m.lastLine ?? null,
    column: m.firstColumn ?? null,
    extract: (m.extract || '').trim().slice(0, 160),
  }));
  const isCss = (m) => /^CSS:/.test(String(m.message || '').trim());

  /* strict снимает оба разделения разом: иногда нужно именно всё, включая заведомо ложное. */
  const css = strict ? [] : all.filter(isCss);
  const rest = strict ? all : all.filter((m) => !isCss(m));
  const known = strict ? [] : rest.filter((m) => classifyKnown(m.message));
  const { kept: messages, ignored } = applyIgnore(strict ? rest : rest.filter((m) => !classifyKnown(m.message)), buildIgnore(ignore));

  const byReason = {};
  for (const m of known) {
    const id = classifyKnown(m.message);
    byReason[id] = (byReason[id] || 0) + 1;
  }

  const note = clippedNote(messages.length, Math.min(messages.length, maxMessages));
  return {
    total: messages.length,
    byType: {
      error: messages.filter((m) => m.type === 'error').length,
      warning: messages.filter((m) => m.type === 'warning' || m.type === 'info').length,
    },
    messages: messages.slice(0, maxMessages),
    ...(note ? { truncated: true, note } : {}),
    ...(ignored ? { ignored } : {}),
    ...(css.length
      ? {
          css: {
            count: css.length,
            sample: css.slice(0, 5),
            note: 'Сообщения о встроенном CSS в итог не входят: валидатор не знает многого из современного CSS (@property, container-type, cqw, field-sizing, :modal) и считает это ошибками. Проверять CSS — lint_css.',
          },
        }
      : {}),
    ...(known.length
      ? {
          known: {
            count: known.length,
            byReason,
            sample: known.slice(0, 3),
            note: 'В итог не входят: это места, где валидатор отстал от платформы, а не ошибки разметки. Список именной, поэтому вместе с правильными атрибутами сюда попадёт и опечатка в них — покажет strict: true.',
          },
        }
      : {}),
  };
}

export async function validateHtmlLocal(html, { maxMessages = 50, ignore = null } = {}) {
  const validator = new HtmlValidate({
    extends: ['html-validate:recommended'],
    rules: {
      // Шаблон страницы приходит из браузера уже отрендеренным, void-стиль неинформативен.
      'void-style': 'off',
      'no-trailing-whitespace': 'off',
    },
  });
  const report = await validator.validateString(html);
  const found = report.results.flatMap((r) =>
    r.messages.map((m) => ({
      severity: m.severity === 2 ? 'error' : 'warning',
      ruleId: m.ruleId,
      message: m.message,
      line: m.line,
      column: m.column,
      selector: m.selector || null,
    })),
  );
  const { kept: messages, ignored } = applyIgnore(found, buildIgnore(ignore));
  const note = clippedNote(messages.length, Math.min(messages.length, maxMessages));
  return {
    valid: report.valid,
    total: messages.length,
    byType: {
      error: messages.filter((m) => m.severity === 'error').length,
      warning: messages.filter((m) => m.severity === 'warning').length,
    },
    messages: messages.slice(0, maxMessages),
    ...(note ? { truncated: true, note } : {}),
    ...(ignored ? { ignored } : {}),
  };
}

export async function lintCss({ files, code, config, maxMessages = 100 } = {}) {
  const options = {
    config: config || { extends: 'stylelint-config-standard' },
    configBasedir: DIRS.root,
  };
  if (code) {
    options.code = code;
  } else if (files) {
    options.files = [].concat(files).map(resolveInRoot);
  } else {
    throw new Error('Нужен либо code, либо files.');
  }

  const result = await stylelint.lint(options);
  const messages = result.results.flatMap((r) =>
    r.warnings.map((w) => ({
      severity: w.severity,
      rule: w.rule,
      message: w.text,
      line: w.line,
      column: w.column,
      source: r.source ? path.relative(DIRS.root, r.source) : '(inline)',
    })),
  );

  const note = clippedNote(messages.length, Math.min(messages.length, maxMessages));
  return {
    errored: result.errored,
    total: messages.length,
    byType: {
      error: messages.filter((m) => m.severity === 'error').length,
      warning: messages.filter((m) => m.severity === 'warning').length,
    },
    messages: messages.slice(0, maxMessages),
    ...(note ? { truncated: true, note } : {}),
  };
}

export async function readLocalFile(target) {
  return fs.readFile(resolveInRoot(target), 'utf8');
}
