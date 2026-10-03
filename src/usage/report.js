/**
 * Сводка журналов использования — то, ради чего журнал пишется.
 *
 * Чистые функции над массивом записей: чтение файлов и вывод живут в bin/lt.mjs. Журналы
 * разных пользователей сводятся простым объединением записей — install и mcpSession различают,
 * чьё и откуда.
 *
 * Что считается сигналом неудобства инструмента:
 *   - доля ошибок и их повторяющиеся тексты — схема или описание вводят в заблуждение;
 *   - повтор того же инструмента сразу после ошибки — агент подбирает аргументы;
 *   - серии одинаковых вызовов — не хватает пакетного режима или ответ не даёт нужного;
 *   - обращение к help и регламенту посреди работы — описания не хватило;
 *   - параметры, которые не передают никогда, и устаревшие ключи;
 *   - инструменты, которые не вызывают вовсе.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Все *.jsonl под каталогом, на любой глубине: так сводятся папки, присланные разными людьми. */
export function readUsageDir(dir) {
  const records = [];
  let skipped = 0;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line));
          } catch {
            /* Последняя строка файла, оборванная падением процесса. */
            skipped += 1;
          }
        }
      }
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return { records, skipped };
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const inc = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const top = (map, limit) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

/**
 * Текст ошибки без частностей: два вызова с разными адресами и числами — одна и та же ошибка.
 */
export function normalizeError(text) {
  return String(text ?? '')
    .split('\n')[0]
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/(["'«`])(?:(?!\1).){1,200}\1/g, '<str>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .slice(0, 200);
}

/** Ключи аргументов на любой глубине через точку — profile.viewport, steps[].action. */
function argPaths(args, prefix = '', out = new Set(), depth = 0) {
  if (!args || typeof args !== 'object' || depth > 3) return out;
  if (Array.isArray(args)) {
    for (const item of args) argPaths(item, `${prefix}[]`, out, depth + 1);
    return out;
  }
  for (const [key, value] of Object.entries(args)) {
    const name = prefix ? `${prefix}.${key}` : key;
    out.add(name);
    if (value && typeof value === 'object') argPaths(value, name, out, depth + 1);
  }
  return out;
}

/**
 * Сводка.
 *
 * manifest — [{ name, params: [...] }] поднятых инструментов; без него разделы о неиспользуемых
 * инструментах и параметрах пропускаются. since — Date: записи раньше отбрасываются.
 */
export function buildUsageReport(records, { manifest = null, since = null, limit = 10 } = {}) {
  const inRange = records.filter((r) => r && (!since || Date.parse(r.ts) >= since.getTime()));
  const calls = inRange.filter((r) => r.event === 'call');

  const installs = new Set(inRange.map((r) => r.install).filter(Boolean));
  const sessions = new Set(inRange.map((r) => r.mcpSession).filter(Boolean));
  const versions = new Map();
  const clients = new Map();
  const toolsets = new Map();
  for (const r of inRange.filter((item) => item.event === 'session_open')) {
    inc(clients, r.client ? `${r.client.name ?? '?'} ${r.client.version ?? ''}`.trim() : '?');
  }
  for (const r of calls) {
    inc(versions, r.standVersion ?? 'unknown');
    inc(toolsets, r.toolset ?? 'all');
  }

  /* По инструментам. */
  const byTool = new Map();
  for (const r of calls) {
    const t = byTool.get(r.tool) ?? { calls: 0, errors: 0, durations: [], bytes: 0, truncated: 0, errorTexts: new Map(), params: new Map(), legacy: new Map() };
    t.calls += 1;
    if (r.outcome !== 'ok') {
      t.errors += 1;
      inc(t.errorTexts, normalizeError(r.error));
    }
    t.durations.push(r.durationMs ?? 0);
    t.bytes += r.result?.textBytes ?? 0;
    const scalars = r.result?.shape?.scalars ?? {};
    if (scalars.truncated === true || r.result?.shape?.unparsed) t.truncated += 1;
    for (const key of argPaths(r.args)) inc(t.params, key);
    for (const key of r.legacyKeys ?? []) inc(t.legacy, key);
    byTool.set(r.tool, t);
  }

  const tools = [...byTool.entries()]
    .map(([name, t]) => {
      const sorted = [...t.durations].sort((a, b) => a - b);
      return {
        tool: name,
        calls: t.calls,
        errors: t.errors,
        errorRate: t.errors / t.calls,
        p50Ms: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
        avgBytes: Math.round(t.bytes / t.calls),
        truncated: t.truncated,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const errors = [...byTool.entries()]
    .filter(([, t]) => t.errors)
    .map(([name, t]) => ({ tool: name, errors: t.errors, top: top(t.errorTexts, 3).map(([text, count]) => ({ text, count })) }))
    .sort((a, b) => b.errors - a.errors)
    .slice(0, limit);

  /* Последовательности внутри сессии: повторы, серии, переходы, путь к help. */
  const bySession = new Map();
  for (const r of inRange) {
    if (r.event !== 'call' && r.event !== 'resource' && r.event !== 'prompt') continue;
    const key = `${r.install}/${r.mcpSession}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(r);
  }

  const retries = new Map();
  const retriesFixed = new Map();
  const streaks = new Map();
  const transitions = new Map();
  const beforeHelp = new Map();
  const step = (r) => (r.event === 'call' ? r.tool : `${r.event}:${r.target ?? '?'}`);
  for (const list of bySession.values()) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.seq ?? 0) - (b.seq ?? 0));
    let run = 1;
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      inc(transitions, `${step(prev)} → ${step(cur)}`);
      if (prev.event === 'call' && cur.event === 'call' && prev.tool === cur.tool && prev.outcome !== 'ok') {
        inc(retries, cur.tool);
        if (cur.outcome === 'ok') inc(retriesFixed, cur.tool);
      }
      if (step(prev) === step(cur)) run += 1;
      else {
        if (run >= 3) inc(streaks, step(prev));
        run = 1;
      }
      const lost = (cur.event === 'call' && cur.tool === 'help') || cur.event === 'resource' || cur.event === 'prompt';
      if (lost && prev.event === 'call' && prev.tool !== 'help') inc(beforeHelp, prev.tool);
    }
    if (run >= 3 && list.length) inc(streaks, step(list.at(-1)));
  }

  const report = {
    period: {
      from: inRange.length ? inRange.reduce((m, r) => (r.ts < m ? r.ts : m), inRange[0].ts) : null,
      to: inRange.length ? inRange.reduce((m, r) => (r.ts > m ? r.ts : m), inRange[0].ts) : null,
    },
    overview: {
      installs: installs.size,
      sessions: sessions.size,
      calls: calls.length,
      errors: calls.filter((r) => r.outcome !== 'ok').length,
      versions: Object.fromEntries(top(versions, limit)),
      clients: Object.fromEntries(top(clients, limit)),
      toolsets: Object.fromEntries(top(toolsets, limit)),
    },
    tools,
    errors,
    retries: top(retries, limit).map(([tool, count]) => ({ tool, count, fixed: retriesFixed.get(tool) ?? 0 })),
    streaks: top(streaks, limit).map(([tool, count]) => ({ tool, count })),
    beforeHelp: top(beforeHelp, limit).map(([tool, count]) => ({ tool, count })),
    transitions: top(transitions, limit).map(([pair, count]) => ({ pair, count })),
    legacyKeys: [...byTool.entries()]
      .flatMap(([tool, t]) => [...t.legacy.entries()].map(([key, count]) => ({ tool, key, count })))
      .sort((a, b) => b.count - a.count),
  };

  if (manifest) {
    report.unusedTools = manifest.map((m) => m.name).filter((name) => !byTool.has(name));
    report.unusedParams = manifest
      .filter((m) => byTool.has(m.name))
      .map((m) => ({ tool: m.name, params: m.params.filter((p) => !byTool.get(m.name).params.has(p)) }))
      .filter((m) => m.params.length);
  }
  return report;
}

const pct = (value) => `${(value * 100).toFixed(value && value < 0.1 ? 1 : 0)}%`;

/** Отчёт для чтения глазами. Машинный вид — тот же объект через --json. */
export function formatUsageReport(report) {
  const lines = [];
  const o = report.overview;
  const section = (title) => lines.push('', `## ${title}`);
  const kv = (object) => Object.entries(object).map(([k, v]) => `${k}: ${v}`).join(', ') || '—';

  lines.push(`Период: ${report.period.from ?? '—'} … ${report.period.to ?? '—'}`);
  lines.push(`Установок: ${o.installs}, сессий: ${o.sessions}, вызовов: ${o.calls}, с ошибкой: ${o.errors}`);
  lines.push(`Версии стенда: ${kv(o.versions)}`);
  lines.push(`Клиенты: ${kv(o.clients)}`);
  lines.push(`Наборы: ${kv(o.toolsets)}`);

  section('Инструменты');
  lines.push(`${'инструмент'.padEnd(22)} ${'вызовы'.padStart(7)} ${'ошибки'.padStart(7)} ${'p50 мс'.padStart(8)} ${'p95 мс'.padStart(8)} ${'ответ Б'.padStart(9)} ${'обрез.'.padStart(6)}`);
  for (const t of report.tools) {
    lines.push(
      `${t.tool.padEnd(22)} ${String(t.calls).padStart(7)} ${pct(t.errorRate).padStart(7)} ${String(t.p50Ms).padStart(8)} ${String(t.p95Ms).padStart(8)} ${String(t.avgBytes).padStart(9)} ${String(t.truncated).padStart(6)}`,
    );
  }

  section('Частые ошибки');
  if (!report.errors.length) lines.push('нет');
  for (const e of report.errors) {
    lines.push(`${e.tool} — ${e.errors}`);
    for (const item of e.top) lines.push(`    ${item.count}× ${item.text}`);
  }

  section('Повтор после ошибки (подбор аргументов)');
  lines.push(...(report.retries.length ? report.retries.map((r) => `${r.tool}: ${r.count}, из них удачно ${r.fixed}`) : ['нет']));

  section('Серии из 3+ одинаковых шагов подряд');
  lines.push(...(report.streaks.length ? report.streaks.map((r) => `${r.tool}: ${r.count}`) : ['нет']));

  section('После чего агент идёт в help, регламент или промпты');
  lines.push(...(report.beforeHelp.length ? report.beforeHelp.map((r) => `${r.tool}: ${r.count}`) : ['нет']));

  section('Частые переходы');
  lines.push(...(report.transitions.length ? report.transitions.map((r) => `${r.count}× ${r.pair}`) : ['нет']));

  if (report.legacyKeys.length) {
    section('Устаревшие ключи');
    lines.push(...report.legacyKeys.map((r) => `${r.tool}.${r.key}: ${r.count}`));
  }
  if (report.unusedTools) {
    section('Не вызывались');
    lines.push(report.unusedTools.join(', ') || 'все вызывались');
    section('Параметры, которые не передают');
    lines.push(...(report.unusedParams.length ? report.unusedParams.map((r) => `${r.tool}: ${r.params.join(', ')}`) : ['все передают']));
  }
  return lines.join('\n');
}
