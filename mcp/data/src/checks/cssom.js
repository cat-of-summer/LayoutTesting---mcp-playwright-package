/**
 * «Какое правило победило и где оно лежит».
 *
 * getComputedStyle отвечает только чем всё кончилось. Когда правок несколько, а таблица
 * стилей собрана и минифицирована, вопрос всегда другой: какие правила вообще матчатся,
 * в каком порядке и кто кого перебил. Это ровно то, что показывает панель Styles в
 * DevTools, и берётся оттуда же — из CDP.
 *
 * Только chromium: у firefox и webkit протокола нет.
 */

const PSEUDO_ALIASES = {
  '::before': 'before',
  '::after': 'after',
  '::marker': 'marker',
  '::placeholder': 'placeholder',
  '::selection': 'selection',
  '::first-line': 'first-line',
  '::first-letter': 'first-letter',
};

export function normalizePseudo(value) {
  if (!value) return null;
  const key = value.startsWith('::') ? value : `::${value.replace(/^:/, '')}`;
  const mapped = PSEUDO_ALIASES[key];
  if (!mapped) throw new Error(`Неизвестный псевдоэлемент: ${value}. Ожидается ${Object.keys(PSEUDO_ALIASES).join(', ')}`);
  return mapped;
}

/**
 * Приблизительная специфичность: id / класс-атрибут-псевдокласс / тег-псевдоэлемент.
 * Приблизительная потому, что :is(), :where() и :not() считаются по внутреннему
 * содержимому, а разбирать вложенные списки ради подписи в отчёте не стоит.
 * Когда протокол отдаёт свою specificity, берём её — она точная.
 */
export function computeSpecificity(selector) {
  const cleaned = String(selector)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\[[^\]]*\]/g, '[]')
    .trim();

  const a = (cleaned.match(/#[\w-]+/g) || []).length;
  const pseudoElements = (cleaned.match(/::[\w-]+/g) || []).length;
  const b =
    (cleaned.match(/\.[\w-]+/g) || []).length +
    (cleaned.match(/\[\]/g) || []).length +
    (cleaned.match(/(?<!:):[\w-]+(?:\([^)]*\))?/g) || []).length;
  const c = (cleaned.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length + pseudoElements;

  return { a, b, c };
}

export const specificityLabel = ({ a, b, c }) => `${a},${b},${c}`;

/**
 * Кто победил по каждому свойству. Модель простая и для авторских стилей верная:
 * important бьёт обычное объявление, при равенстве выигрывает объявленное позже.
 */
export function resolveWinners(declarations) {
  const byProperty = new Map();
  declarations.forEach((decl, index) => {
    const list = byProperty.get(decl.name) || [];
    list.push({ ...decl, index });
    byProperty.set(decl.name, list);
  });

  const out = [];
  for (const [name, list] of byProperty) {
    const sorted = [...list].sort((x, y) => (x.important === y.important ? x.index - y.index : x.important ? 1 : -1));
    const winner = sorted.at(-1);
    out.push({
      property: name,
      value: winner.value,
      important: winner.important,
      from: winner.from,
      overridden: sorted
        .slice(0, -1)
        .reverse()
        .map((d) => ({ value: d.value, important: d.important, from: d.from })),
    });
  }
  return out;
}

function sourceOf(header, rule) {
  if (!header) return { file: '(неизвестно)', line: null, column: null };
  const range = rule.style?.range || rule.selectorList?.selectors?.[0]?.range;
  const startLine = range?.startLine ?? 0;
  const file = header.sourceURL || (header.isInline ? '(инлайновый <style>)' : '(без URL)');
  return {
    file,
    // Для инлайновых таблиц смещение считается от начала документа.
    line: (header.startLine || 0) + startLine + 1,
    column: startLine === 0 ? (header.startColumn || 0) + (range?.startColumn ?? 0) + 1 : (range?.startColumn ?? 0) + 1,
    minified: Boolean(header.length && header.length > 20000 && (header.startLine || 0) + startLine < 5),
  };
}

/**
 * Протокол отдаёт объявления стиля двумя склеенными наборами: сначала авторские, как их
 * написали в таблице (у них есть range и text), следом — раскрытый набор лонгхендов той же
 * таблицы (range нет). Для правила `color: red` это буквально одно и то же объявление
 * дважды, и без разделения оно приезжает в отчёт как конфликт с самим собой.
 *
 * Наборы нужны разные и для разного:
 * — показываем авторский, как это делает панель Styles: человек ищет строку, которую писал;
 * — в разбор «кто кого перебил» добавляем лонгхенды, которых в авторском тексте нет, иначе
 *   `margin: 0` из одного правила и `margin-top: 5px` из другого не встретятся ни по одному
 *   имени свойства и конфликт останется невидимым.
 *
 * У правил user-agent авторского набора нет вовсе — там раскрытый и есть единственный.
 */
export function splitDeclarations(style) {
  const all = (style?.cssProperties || []).filter((p) => !p.disabled && p.value !== undefined);
  const authored = all.filter((p) => p.range);
  const expanded = all.filter((p) => !p.range);

  const shown = authored.length ? authored : expanded;
  const shownNames = new Set(shown.map((p) => p.name));
  const view = (p) => ({
    name: p.name,
    value: p.value,
    important: Boolean(p.important),
    implicit: Boolean(p.implicit),
  });

  return {
    declarations: shown.map(view),
    // Лонгхенды шорткатов: важность на них протокол проставляет сам, брать её у шортката не нужно.
    expanded: authored.length ? expanded.filter((p) => !shownNames.has(p.name)).map(view) : [],
  };
}

function ruleView(entry, sheets) {
  const { rule, matchingSelectors = [] } = entry;
  const selectors = rule.selectorList?.selectors || [];
  const matchedText = matchingSelectors.map((i) => selectors[i]?.text).filter(Boolean);
  const shown = matchedText.length ? matchedText : [rule.selectorList?.text].filter(Boolean);
  const protocolSpec = matchingSelectors
    .map((i) => selectors[i]?.specificity)
    .filter(Boolean)
    .sort((x, y) => x.a - y.a || x.b - y.b || x.c - y.c)
    .at(-1);
  const specificity = protocolSpec || shown.map(computeSpecificity).sort((x, y) => x.a - y.a || x.b - y.b || x.c - y.c).at(-1) || { a: 0, b: 0, c: 0 };

  return {
    selector: shown.join(', '),
    specificity: specificityLabel(specificity),
    exactSpecificity: Boolean(protocolSpec),
    origin: rule.origin,
    media: (rule.media || []).map((m) => m.text).filter(Boolean),
    source: sourceOf(sheets.get(rule.styleSheetId), rule),
    ...splitDeclarations(rule.style),
  };
}

export async function matchedRules(page, { selector, pseudo, properties, maxRules = 40, maxProperties = 60 } = {}) {
  if (!selector) throw new Error('Нужен selector.');
  const pseudoType = normalizePseudo(pseudo);

  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (err) {
    throw new Error(`matched_rules работает только в chromium: CDP недоступен (${err.message}).`);
  }

  const sheets = new Map();
  cdp.on('CSS.styleSheetAdded', ({ header }) => sheets.set(header.styleSheetId, header));

  try {
    await cdp.send('DOM.enable');
    // CSS.enable дособытит styleSheetAdded по уже загруженным таблицам — подписка выше обязана быть раньше.
    await cdp.send('CSS.enable');

    const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return { found: false, selector, pseudo: pseudo || null };

    const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });

    let entries;
    if (pseudoType) {
      const bucket = (matched.pseudoElements || []).find((p) => p.pseudoType === pseudoType);
      if (!bucket) {
        return {
          found: true,
          selector,
          pseudo,
          rules: [],
          note: `Для ${selector} нет правил на ${pseudo} — псевдоэлемент не создаётся.`,
        };
      }
      entries = bucket.matches || [];
    } else {
      entries = matched.matchedCSSRules || [];
    }

    // Протокол отдаёт правила от менее приоритетного к более приоритетному.
    const rules = entries.slice(-maxRules).map((e) => ruleView(e, sheets));

    const inline = !pseudoType && matched.inlineStyle?.cssProperties?.length
      ? {
          selector: '(style="" на самом элементе)',
          specificity: 'inline',
          exactSpecificity: true,
          origin: 'inline',
          media: [],
          source: { file: '(атрибут style)', line: null, column: null },
          ...splitDeclarations(matched.inlineStyle),
        }
      : null;

    const ordered = inline ? [...rules, inline] : rules;
    const wanted = properties && properties.length ? new Set(properties) : null;

    const declarations = ordered.flatMap((r) =>
      [...r.declarations, ...r.expanded]
        .filter((d) => (wanted ? wanted.has(d.name) : !d.implicit))
        .map((d) => ({ ...d, from: `${r.selector} [${r.specificity}] ${r.source.file}${r.source.line ? `:${r.source.line}` : ''}` })),
    );

    const winners = resolveWinners(declarations);
    // Без явного списка свойств интересны только конфликты: остальное и так видно в computed_styles.
    const conflicts = wanted ? winners : winners.filter((w) => w.overridden.length > 0);

    return {
      found: true,
      selector,
      pseudo: pseudo || null,
      rulesCount: entries.length,
      // Раскрытые лонгхенды нужны были только для разбора конфликтов: в правиле показываем
      // то, что автор написал.
      rules: ordered.map(({ expanded, ...rule }) => rule),
      winners: conflicts.slice(0, maxProperties),
      note: ordered.some((r) => r.source?.minified)
        ? 'Часть правил из минифицированной таблицы: строка там всегда первая, ориентируйтесь на колонку.'
        : undefined,
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}
