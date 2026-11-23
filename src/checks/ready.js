/**
 * Готова ли страница к сдаче: обязательные проверки одним вызовом.
 *
 * Регламент требовал перед отчётом попиксельную сверку каждой секции, прокликанный интерактив
 * и пустой notSynced — и всё это было текстом, который код не проверял. Агент писал «готово»
 * после восьми смысловых сверок без единой попиксельной, ни разу не запускал interaction_audit
 * и пропускал notSynced в хвосте ответа. Ошибки дошли до дизайнера.
 *
 * Здесь проверки не советуются, а выполняются: свежие прогоны из журнала (runs.js) берутся как
 * есть, недостающие стенд догоняет сам, и ответ — ready: true | false со списком блокеров, у
 * каждого из которых готовый следующий вызов.
 */
import { gotoAndSettle } from '../browser/pool.js';
import { fresh, frameRuns, pageRuns, recordPage } from '../runs.js';
import { layoutAuditAcrossWidths } from './layout.js';
import { inStatesAcrossWidths } from './states.js';
import { runInteractions } from './interaction.js';
import { auditForms } from './forms.js';
import { lintLiveCss } from './css-live.js';
import { auditSettled, initialStateDrift, likelyDefects } from './settled.js';

/* Категории layout_audit, при которых страница не готова. Остальные — повод посмотреть, не блокер. */
export const BLOCKING_CATEGORIES = [
  'documentOverflow',
  'overlaps',
  'controlOverlaps',
  'clippedText',
  'coveredText',
  'contentOverflow',
  'brokenImages',
  'tinyTargets',
  'textOverImage',
];

/* Ширины по умолчанию, если кадров нет: телефон, планшет, ноутбук, десктоп. */
const DEFAULT_WIDTHS = [375, 768, 1024, 1440];
const STANDARD_WIDTHS = [320, 375, 768, 1024, 1280, 1440, 1920];

/** Ширины прогона: ширины кадров и стандартные между ними — как suggested у figma_sync. */
export function readyWidths(frameWidths = []) {
  const design = [...new Set(frameWidths.filter((w) => w >= 320 && w <= 2560))].sort((a, b) => a - b);
  if (!design.length) return DEFAULT_WIDTHS;
  if (design.length === 1) return [...new Set([375, ...design])].sort((a, b) => a - b);
  const [min, max] = [design[0], design.at(-1)];
  return [...new Set([...design, ...STANDARD_WIDTHS.filter((w) => w > min && w < max)])].sort((a, b) => a - b);
}

/** Находки, которые textOverImage отдаёт с чернилами: без них это подсказка, а не дефект. */
const blocking = (category, report) => {
  if (category !== 'textOverImage') return report.counts?.[category] || 0;
  const list = report.issues?.textOverImage || report.top?.filter((item) => item.category === 'textOverImage') || [];
  return list.filter((item) => typeof item.ink === 'number' && item.ink > 0.05).length;
};

/**
 * Списания сигналов: только поштучно, с причиной.
 *
 * На ТОПГАН controlOverlaps списали категорией — «это reveal», — и под ней остались перекрытая
 * кнопка и блок поверх шапки. Поэтому ключ здесь всегда пара «проверка + конкретный селектор»:
 * категорию целиком списать нечем, а списание, которое ни к чему не подошло, видно в ответе.
 */
export function waiverBook(list = []) {
  const entries = list.map((waiver) => ({ ...waiver, used: 0 }));
  return {
    covers(check, selector) {
      const hit = entries.find((entry) => entry.check === check && entry.selector === selector);
      if (hit) hit.used += 1;
      return Boolean(hit);
    },
    applied: () => entries.filter((entry) => entry.used).map(({ check, selector, reason }) => ({ check, selector, reason })),
    unused: () => entries.filter((entry) => !entry.used).map(({ check, selector }) => ({ check, selector })),
  };
}

const itemSelectors = (item) => [item.selector, item.a?.selector, item.b?.selector].filter(Boolean);

/** Блокеры из одного отчёта layout_audit: полного или выжимки по ширине. */
function reportBlockers(report, where, book = null) {
  const out = [];
  for (const category of BLOCKING_CATEGORIES) {
    let count = blocking(category, report);
    if (!count) continue;
    const listed = (report.issues?.[category] || report.top?.filter((item) => item.category === category) || []).filter(
      (item) => category !== 'textOverImage' || (typeof item.ink === 'number' && item.ink > 0.05),
    );
    const kept = book ? listed.filter((item) => !itemSelectors(item).some((selector) => book.covers(category, selector))) : listed;
    count -= listed.length - kept.length;
    if (count <= 0) continue;
    const sample = kept[0];
    out.push({
      check: 'layout_audit',
      what: `${category}: ${count}`,
      where,
      ...(sample ? { example: sample.selector || sample.text || null } : {}),
    });
  }
  return out;
}

/**
 * Блокеры из ответа layout_audit любой формы: одна ширина, несколько ширин, состояния, состояния
 * по ширинам.
 */
export function layoutBlockers(result, book = null) {
  if (!result) return [];
  const out = [];
  const byWidth = (map, label) => {
    for (const [width, report] of Object.entries(map || {})) {
      if (report.skipped) continue;
      if (report.error) out.push({ check: 'layout_audit', what: `состояние не создано: ${report.error}`, where: `${label}, ${width}px` });
      else out.push(...reportBlockers(report, `${label}, ${width}px`, book));
    }
  };
  if (result.byWidth) byWidth(result.byWidth, 'страница');
  else if (result.base?.byWidth) byWidth(result.base.byWidth, 'страница');
  else if (result.base) out.push(...layoutBlockers(result.base, book));
  else if (result.counts) out.push(...reportBlockers(result, 'страница', book));

  for (const [name, state] of Object.entries(result.states || {})) {
    if (state.byWidth) {
      byWidth(state.byWidth, `состояние «${name}»`);
      if (state.error) out.push({ check: 'layout_audit', what: state.error, where: `состояние «${name}»` });
    } else if (state.error) {
      out.push({ check: 'layout_audit', what: state.error, where: `состояние «${name}»` });
    } else if (!state.skipped) {
      out.push(...layoutBlockers(state, book).map((item) => ({ ...item, where: `состояние «${name}»` })));
    }
  }
  return out;
}

/** Дефекты страницы в покое: чужой элемент поверх контрола или закреплённого слоя. */
export function settledBlockers(report, where, book = null) {
  const session = '<сессия со страницей>';
  const out = [];
  for (const item of report?.controlsCovered || []) {
    if (book?.covers('controlsCovered', item.selector)) continue;
    out.push({
      check: 'settled',
      what: `контрол перекрыт после окончания анимаций: сверху ${item.by}`,
      where: `${where}, scrollY ${item.scrollY}`,
      selector: item.selector,
      waiver: 'controlsCovered',
      next: { tool: 'element_layers', args: { sessionId: session, selector: item.selector } },
    });
  }
  for (const item of report?.overPinned || []) {
    if (book?.covers('overPinned', item.selector)) continue;
    out.push({
      check: 'settled',
      what: `блок лежит поверх закреплённого ${item.pinned}`,
      where: `${where}, scrollY ${item.scrollY}`,
      selector: item.selector,
      waiver: 'overPinned',
      next: { tool: 'element_layers', args: { sessionId: session, selector: item.selector } },
    });
  }
  return out;
}

/** Предупреждения библиотек в консоли: Swiper Loop на ТОПГАН означал пустой слайд. */
export function consoleBlockers(entries, book = null) {
  return likelyDefects(entries)
    .filter((defect) => !book?.covers('page_logs', defect.kind))
    .map((defect) => ({
      check: 'page_logs',
      what: `${defect.kind}: ${defect.why}`,
      where: defect.text,
      selector: defect.kind,
      waiver: 'page_logs',
      next: { tool: 'page_logs', args: { sessionId: '<сессия со страницей>', kind: 'console' } },
    }));
}

/** Пункты микро-ТЗ: незакрытый «- [ ]» значит, что требование не выполнено или не проверено. */
export function checklistItems(text) {
  const open = [];
  let done = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === ' ') open.push(match[2]);
    else done += 1;
  }
  return { open, done, total: open.length + done };
}

export const checklistBlockers = (text) =>
  checklistItems(text).open.map((item) => ({
    check: 'spec',
    what: 'пункт микро-ТЗ не закрыт',
    where: item.slice(0, 160),
    next: { do: 'Выполните и проверьте пункт, отметьте его [x] в файле микро-ТЗ и передайте файл в checklist снова.' },
  }));

/**
 * Подсказки выравнивания из ответа layout_audit любой формы — не блокеры. Блок, выпавший из ряда,
 * бывает задуман, и вердикт выносит агент по скриншоту; но «ready: true» без них читается как
 * «смотреть нечего». Один и тот же элемент на нескольких ширинах — одна запись с перечнем мест.
 */
export function alignmentHints(result) {
  if (!result) return [];
  const found = new Map();
  const add = (alignment, where) => {
    for (const item of alignment?.top || alignment?.findings || []) {
      const key = `${item.kind} ${item.selector}`;
      const known = found.get(key);
      if (known) known.where.push(where);
      else found.set(key, { kind: item.kind, selector: item.selector, edge: item.edge, delta: item.delta, where: [where] });
    }
  };
  const walk = (report, label) => {
    if (!report) return;
    if (report.byWidth) for (const [width, summary] of Object.entries(report.byWidth)) add(summary.alignment, `${label}, ${width}px`);
    else if (report.base) walk(report.base, label);
    else add(report.alignment, label);
    for (const [name, state] of Object.entries(report.states || {})) walk(state, `состояние «${name}»`);
  };
  walk(result, 'страница');
  return [...found.values()];
}

/** Мёртвые кнопки и ховеры без видимого изменения. */
export function interactionBlockers(result) {
  if (!result) return [];
  const out = [];
  for (const entry of result.silent || []) {
    out.push({ check: 'interaction_audit', what: 'не отвечает ни на что — обработчика нет или он ничего не меняет', where: entry });
  }
  for (const entry of result.hoverInvisible || []) {
    out.push({ check: 'interaction_audit', what: 'ховер объявлен, но видимо ничего не меняется', where: entry });
  }
  return out;
}

export function formBlockers(result) {
  if (!result?.forms?.length) return [];
  return result.forms.flatMap((form) =>
    (form.issues || []).map((issue) => ({
      check: 'form_audit',
      what: `${issue.kind}${issue.note ? `: ${issue.note}` : ''}`,
      where: issue.selector || form.selector || 'form',
    })),
  );
}

/** Что не так со сверкой кадра: не было semantic или sections, или они устарели. */
export function frameBlockers(ref, entry, url) {
  const out = [];
  const missing = ['semantic', 'sections'].filter((kind) => !entry?.[kind]);
  if (missing.length) {
    out.push({
      check: 'figma_compare',
      what: `по кадру не было: ${missing.join(', ')}`,
      where: ref,
      next: { tool: 'figma_compare', args: { figma: ref, url, sections: true } },
    });
  }
  return out;
}

/**
 * Цвета правил состояний вне палитры макета — блокер: ховер, придуманный самим агентом. Переменные
 * библиотеки, оставшиеся по умолчанию, — предупреждение: это повод проверить, а не дефект сам по себе.
 */
export function cssBlockers(result) {
  return (result?.stateColorOffPalette || []).map((item) => ({
    check: 'lint_css',
    what: `цвет ${item.color} в ${item.prop} правила состояния — в состояниях макета такого нет${item.closest ? `; ближайший — ${item.closest}` : ''}`,
    where: item.selector,
  }));
}

/** Порядок блокеров в ответе: сначала то, что дошло бы до дизайнера первым. */
const ORDER = ['spec', 'figma_behavior', 'figma_compare', 'settled', 'interaction_audit', 'lint_css', 'layout_audit', 'page_logs', 'form_audit'];
const sortBlockers = (list) => [...list].sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check));

/** Готовый вызов, повторяющий проверку, если блокер его не назвал сам. */
function nextCall(blocker, { url, widths, frames }) {
  if (blocker.next) return blocker.next;
  if (blocker.check === 'layout_audit') return { tool: 'layout_audit', args: { widths, categories: [blocker.what.split(':')[0]] } };
  if (blocker.check === 'interaction_audit') return { tool: 'interaction_audit', args: { selectors: [String(blocker.where).replace(/ \((click|hover)\)$/, '')] } };
  if (blocker.check === 'form_audit') return { tool: 'form_audit', args: {} };
  /* sessionId — сессия, где открыта страница: page_ready работает в своей и закрывает её. */
  if (blocker.check === 'lint_css') return { tool: 'lint_css', args: { figma: frames, sessionId: '<сессия со страницей>' } };
  return { tool: blocker.check, args: { url } };
}

/**
 * Прогнать готовность. deps — то, что живёт в инструментах Figma и сюда не тянется импортом:
 * frameInfo(ref) → { ref, version, width }, compareFrame(ref, session) → покрытие,
 * behaviorOf(refs) → blocking | null.
 */
export async function pageReady(session, { url, frames = [], widths, states, maxAgeMin = 30, run = 'missing', waivers = [], checklist = null }, deps = {}) {
  const ran = [];
  const reused = [];
  const blockers = [...(checklist ? checklistBlockers(checklist) : [])];
  const sectionsWorst = [];
  const reuse = (entry) => run !== 'all' && fresh(entry, maxAgeMin);
  const book = waiverBook(waivers);
  const logStart = session.logs.console.length;
  /* Сессия живая, но проверкам нужна страница целиком, с проявленными блоками ниже экрана. */
  session.revealOnGoto = true;

  /* Начальное состояние — на нетронутой странице: стабилизация уже прокручивает её. */
  let initial = pageRuns(url)?.initial;
  if (!reuse(initial)) {
    await gotoAndSettle(session, url, { stabilizePage: false });
    initial = recordInitial(url, await initialStateDrift(session.page).catch(() => []));
    ran.push('initial_state');
  } else reused.push({ check: 'initial_state', at: initial.at });
  const initialState = initial.items;

  await gotoAndSettle(session, url);

  /* Кадры: смысловая и посекционная сверка, каждая в окне шириной кадра. */
  const infos = [];
  for (const ref of frames) {
    const info = await deps.frameInfo(ref);
    infos.push(info);
    let entry = frameRuns(info.ref, info.version);
    const stale = !entry?.semantic || !entry?.sections || !fresh({ at: entry.sections.at }, maxAgeMin);
    if (run === 'all' || stale) {
      await deps.compareFrame(info, url);
      entry = frameRuns(info.ref, info.version);
      ran.push(`figma_compare ${info.ref}`);
    } else reused.push({ check: `figma_compare ${info.ref}`, at: entry.sections.at });
    blockers.push(...frameBlockers(info.ref, entry, url));
    if (entry?.sections?.worst?.length) sectionsWorst.push({ frame: info.ref, worst: entry.sections.worst, ...(entry.sections.seams ? { seams: entry.sections.seams } : {}) });
  }

  if (frames.length && deps.behaviorOf) {
    const found = await deps.behaviorOf(infos.map((info) => info.ref));
    if (found) blockers.push({ check: 'figma_behavior', what: found.what, where: found.targets.map((target) => target.ref).join(', '), next: found.next });
    ran.push('figma_behavior');
  }

  const runWidths = widths?.length ? widths : readyWidths(infos.map((info) => info.width));
  const known = pageRuns(url) || {};

  /* Интерактив: click и hover по всему, что стенд считает интерактивным. */
  let interaction = known.interaction;
  if (!(reuse(interaction) && interaction.scope === FULL_SCOPE)) {
    await gotoAndSettle(session, url);
    const result = await runInteractions(session.page, { actions: ['click', 'hover'] });
    interaction = recordInteraction(url, result, FULL_SCOPE);
    await gotoAndSettle(session, url);
    ran.push('interaction_audit');
  } else reused.push({ check: 'interaction_audit', at: interaction.at });
  blockers.push(...interactionBlockers(interaction));

  /* Вёрстка по ширинам и в состояниях. */
  let layout = known.layout;
  const signature = layoutSignature(runWidths, states);
  if (!(reuse(layout) && layout.signature === signature)) {
    const result = states?.length
      ? await inStatesAcrossWidths(session, states, runWidths, {})
      : await layoutAuditAcrossWidths(session.page, runWidths, {});
    layout = recordLayout(url, result, signature);
    ran.push('layout_audit');
  } else reused.push({ check: 'layout_audit', at: layout.at });
  blockers.push(...layoutBlockers(layout.result, book));
  const lookAt = alignmentHints(layout.result);

  /*
   * Проверки в покое — на макетных ширинах, а без кадров на крайних: каждая ходит по всей
   * странице с ожиданием анимаций, и прогон по семи ширинам занял бы минуты.
   */
  const designWidths = infos.map((info) => info.width).filter(Boolean);
  const settledWidths = [...new Set(designWidths.length ? designWidths : [runWidths[0], runWidths.at(-1)])];
  const settledSignature = JSON.stringify([...settledWidths].sort((a, b) => a - b));
  let settled = known.settled;
  if (!(reuse(settled) && settled.signature === settledSignature)) {
    const original = session.page.viewportSize();
    const byWidth = {};
    try {
      for (const width of settledWidths) {
        await session.page.setViewportSize({ width, height: original?.height ?? 900 });
        await gotoAndSettle(session, url, { stabilizePage: false });
        byWidth[width] = await auditSettled(session.page);
      }
    } finally {
      if (original) await session.page.setViewportSize(original);
    }
    settled = recordSettled(url, byWidth, settledSignature);
    await gotoAndSettle(session, url);
    ran.push('settled');
  } else reused.push({ check: 'settled', at: settled.at });
  for (const [width, report] of Object.entries(settled.byWidth)) blockers.push(...settledBlockers(report, `${width}px`, book));
  blockers.push(...consoleBlockers(session.logs.console.slice(logStart), book));

  const firstOf = (key) => Object.entries(settled.byWidth).flatMap(([width, report]) => (report[key] || []).map((item) => ({ width: Number(width), ...item })));
  const hints = {
    ...(firstOf('rowChildren').length ? { rowChildren: firstOf('rowChildren').slice(0, 8) } : {}),
    ...(firstOf('glyphOffset').length ? { glyphOffset: firstOf('glyphOffset').slice(0, 8) } : {}),
    ...(initialState.length ? { initialState: initialState.slice(0, 6) } : {}),
    ...(interaction.transitionIssues?.length ? { transitionIssues: interaction.transitionIssues.slice(0, 8) } : {}),
    ...(interaction.touchHover?.length ? { touchHover: interaction.touchHover.slice(0, 8) } : {}),
  };

  /* Цвета состояний против палитры макета: только когда есть кадры. */
  const warnings = [];
  if (frames.length && deps.paletteOf) {
    const palette = await deps.paletteOf(infos.map((info) => info.ref));
    if (palette.length) {
      const css = await lintLiveCss(session.page, { palette });
      blockers.push(...cssBlockers(css));
      for (const item of css.libraryDefault || []) warnings.push(`${item.name}: переменная состояния библиотеки (${item.readIn}) осталась по умолчанию`);
      ran.push('lint_css');
    }
  }

  /* Формы — только если они есть. */
  const hasForms = await session.page.evaluate(() => document.querySelectorAll('form').length).catch(() => 0);
  if (hasForms) {
    let forms = known.forms;
    if (!reuse(forms)) {
      const result = await auditForms(session, {});
      forms = recordForms(url, result);
      ran.push('form_audit');
    } else reused.push({ check: 'form_audit', at: forms.at });
    blockers.push(...formBlockers(forms.result));
  }

  const sorted = sortBlockers(blockers).map((blocker) => ({ ...blocker, next: nextCall(blocker, { url, widths: runWidths, frames }) }));
  return {
    ready: sorted.length === 0,
    url,
    widths: runWidths,
    ...(sorted.length ? { blockers: sorted.slice(0, 30), ...(sorted.length > 30 ? { blockersTotal: sorted.length } : {}) } : {}),
    ...(sectionsWorst.length ? { sections: sectionsWorst } : {}),
    ran,
    ...(reused.length ? { reused } : {}),
    ...(warnings.length ? { warnings: warnings.slice(0, 10) } : {}),
    ...(checklist ? { checklist: (({ open, ...counts }) => ({ ...counts, open: open.length }))(checklistItems(checklist)) } : {}),
    ...(book.applied().length ? { waived: book.applied() } : {}),
    ...(book.unused().length
      ? { unusedWaivers: book.unused(), unusedWaiversNote: 'Эти списания ни к чему не подошли: сигнал ушёл или селектор другой. Уберите их.' }
      : {}),
    ...(Object.keys(hints).length
      ? {
          hints: {
            ...hints,
            note: 'Не блокеры, но смотреть обязательно: кнопки ряда не на одной линии, текст не по центру контрола, состояние шапки после загрузки отличается от состояния после возврата, качество переходов, hover на таче. Поправьте или назовите в отчёте как задуманное.',
          },
        }
      : {}),
    ...(lookAt.length
      ? {
          alignment: {
            hints: lookAt.slice(0, 10),
            ...(lookAt.length > 10 ? { hintsTotal: lookAt.length } : {}),
            note: 'Не блокеры: однотипные блоки, выпавшие из линии соседей. Посмотрите каждый на скриншоте до отчёта — поправьте или назовите в отчёте как задуманное. Подробности и подсказки — layout_audit на этой ширине.',
          },
        }
      : {}),
    ...(frames.length
      ? {}
      : { framesNote: 'Кадры не переданы: сверка с макетом не проверялась. Для страницы по макету передайте frames — ссылки на кадры всех ширин.' }),
    note: sorted.length
      ? 'Страница не готова: отчёт «готово» не пишется, пока blockers не пуст. Каждому блокеру — готовый вызов в next; исправили — повторите page_ready.'
      : 'Обязательные проверки пройдены. sections — секции с наибольшим расхождением: просмотрите их diff перед отчётом.',
  };
}

const layoutSignature = (widths, states) => JSON.stringify({ widths: [...widths].sort((a, b) => a - b), states: (states || []).map((s) => s.name || s.each || '') });

/**
 * Охват прогона интерактива: без selectors и с обоими действиями — то, что засчитывается
 * page_ready. Прогон по трём кнопкам или только кликом полным не считается.
 */
export const interactionScope = (selectors, actions = ['click']) =>
  selectors?.length ? 'selectors' : `all:${[...new Set(actions)].sort().join('+')}`;
const FULL_SCOPE = interactionScope(null, ['click', 'hover']);

/** Запись прогонов в журнал — то же делают сами инструменты, чтобы page_ready их видел. */
export function recordInteraction(url, result, scope) {
  const entry = {
    scope,
    silent: result.silent || [],
    ...(result.hoverInvisible?.length ? { hoverInvisible: result.hoverInvisible } : {}),
    ...(result.transitionIssues?.length ? { transitionIssues: result.transitionIssues } : {}),
    ...(result.touchHover?.length ? { touchHover: result.touchHover } : {}),
    probed: result.probed,
  };
  recordPage(url, 'interaction', entry);
  return { at: new Date().toISOString(), ...entry };
}

export function recordLayout(url, result, signature = null) {
  recordPage(url, 'layout', { signature, result });
  return { at: new Date().toISOString(), signature, result };
}

export function recordInitial(url, items) {
  recordPage(url, 'initial', { items });
  return { at: new Date().toISOString(), items };
}

export function recordSettled(url, byWidth, signature) {
  recordPage(url, 'settled', { signature, byWidth });
  return { at: new Date().toISOString(), signature, byWidth };
}

export function recordForms(url, result) {
  const compact = { forms: (result.forms || []).map((form) => ({ selector: form.selector, issues: form.issues || [] })) };
  recordPage(url, 'forms', { result: compact });
  return { at: new Date().toISOString(), result: compact };
}

export { layoutSignature };
