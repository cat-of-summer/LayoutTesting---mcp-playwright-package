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
export async function validateHtmlWithVnu(html, { maxMessages = 50 } = {}) {
  const res = await fetch(`${CONFIG.vnuUrl}/?out=json`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  });
  if (!res.ok) {
    throw new Error(`vnu ответил ${res.status}. Проверьте, что контейнер vnu поднят (${CONFIG.vnuUrl}).`);
  }
  const data = await res.json();
  return splitVnuMessages(data.messages || [], { maxMessages });
}

/**
 * Сообщения vnu: разметка отдельно, встроенный CSS отдельно.
 *
 * CSS-валидатор внутри Nu отстаёт от браузеров на годы: @property, container-type, cqw,
 * field-sizing, :modal для него «ошибки». На странице с современными стилями это сотни записей,
 * и две настоящие ошибки разметки приходится выискивать среди них глазами. CSS-сообщения Nu
 * помечает префиксом «CSS:» — по нему и делим; счёт и примеры остаются, в общий итог не идут.
 */
export function splitVnuMessages(raw, { maxMessages = 50 } = {}) {
  const all = raw.map((m) => ({
    type: m.subType || m.type,
    message: m.message,
    line: m.lastLine ?? null,
    column: m.firstColumn ?? null,
    extract: (m.extract || '').trim().slice(0, 160),
  }));
  const isCss = (m) => /^CSS:/.test(String(m.message || '').trim());
  const messages = all.filter((m) => !isCss(m));
  const css = all.filter(isCss);
  return {
    total: messages.length,
    byType: {
      error: messages.filter((m) => m.type === 'error').length,
      warning: messages.filter((m) => m.type === 'warning' || m.type === 'info').length,
    },
    messages: messages.slice(0, maxMessages),
    ...(css.length
      ? {
          css: {
            count: css.length,
            sample: css.slice(0, 5),
            note: 'Сообщения о встроенном CSS в итог не входят: валидатор не знает многого из современного CSS (@property, container-type, cqw, field-sizing, :modal) и считает это ошибками. Проверять CSS — lint_css.',
          },
        }
      : {}),
  };
}

export async function validateHtmlLocal(html, { maxMessages = 50 } = {}) {
  const validator = new HtmlValidate({
    extends: ['html-validate:recommended'],
    rules: {
      // Шаблон страницы приходит из браузера уже отрендеренным, void-стиль неинформативен.
      'void-style': 'off',
      'no-trailing-whitespace': 'off',
    },
  });
  const report = await validator.validateString(html);
  const messages = report.results.flatMap((r) =>
    r.messages.map((m) => ({
      severity: m.severity === 2 ? 'error' : 'warning',
      ruleId: m.ruleId,
      message: m.message,
      line: m.line,
      column: m.column,
      selector: m.selector || null,
    })),
  );
  return {
    valid: report.valid,
    total: messages.length,
    byType: {
      error: messages.filter((m) => m.severity === 'error').length,
      warning: messages.filter((m) => m.severity === 'warning').length,
    },
    messages: messages.slice(0, maxMessages),
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

  return {
    errored: result.errored,
    total: messages.length,
    byType: {
      error: messages.filter((m) => m.severity === 'error').length,
      warning: messages.filter((m) => m.severity === 'warning').length,
    },
    messages: messages.slice(0, maxMessages),
  };
}

export async function readLocalFile(target) {
  return fs.readFile(resolveInRoot(target), 'utf8');
}
