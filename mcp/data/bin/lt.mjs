#!/usr/bin/env node
/**
 * CLI стенда — тот же набор проверок, что и в MCP, но из шелла контейнера:
 *   docker compose exec playwright lt audit --url http://nginx_app/ --checks all
 */
import { readFile } from 'node:fs/promises';
import { CONFIG, DIRS, VIEWPORTS } from '../src/config.js';
import { runAudit, ALL_CHECKS } from '../src/audit.js';
import { runMatrix } from '../src/matrix.js';
import { runLighthouse } from '../src/checks/perf.js';
import { auditStorybook } from '../src/checks/storybook.js';
import { listRuns, pruneRuns, publicUrl, newRunId, slug } from '../src/artifacts.js';
import { createSession, closeSession, gotoAndSettle, closeAll } from '../src/browser/pool.js';
import { takeScreenshot } from '../src/checks/visual.js';
import { listBaselines } from '../src/checks/visual.js';

const argv = process.argv.slice(2);
const command = argv[0];

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const [key, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (args[i + 1] && !args[i + 1].startsWith('--')) flags[key] = args[++i];
    else flags[key] = true;
  }
  return flags;
}

const list = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const bool = (v) => v === true || v === 'true' || v === '1';

function profileFrom(flags) {
  return {
    browser: flags.browser || 'chromium',
    viewport: flags.viewport || 'desktop',
    colorScheme: bool(flags.dark) ? 'dark' : flags.colorScheme || 'light',
    forcedColors: bool(flags['forced-colors']) ? 'active' : 'none',
    rtl: bool(flags.rtl),
    zoom: flags.zoom ? Number(flags.zoom) : 100,
    textZoom: flags['text-zoom'] ? Number(flags['text-zoom']) : 100,
    pseudoLoc: bool(flags.pseudo),
    deviceScaleFactor: flags.dpr ? Number(flags.dpr) : 1,
    freezeTime: bool(flags['freeze-time']),
  };
}

function requireUrl(flags) {
  if (!flags.url) {
    console.error('Нужен --url');
    process.exit(2);
  }
  return flags.url;
}

function printSummary(summary) {
  const order = [
    ['вердикт', summary.verdict],
    ['эвристики вёрстки', summary.layoutIssues],
    ['горизонтальный скролл', summary.documentOverflow ? 'да' : null],
    ['axe', summary.axeViolations],
    ['pa11y ошибок', summary.pa11yErrors],
    ['HTML-ошибок', summary.htmlErrors],
    ['CLS', summary.cls],
    ['LCP, мс', summary.lcp],
    ['Lighthouse perf', summary.performanceScore],
    ['визуально', summary.visual],
    ['расхождение, %', summary.diffPercentage],
    ['ошибок JS', summary.jsErrors || null],
    ['неудачных запросов', summary.failedRequests || null],
  ];
  for (const [key, value] of order) {
    if (value === null || value === undefined || value === '') continue;
    console.log(`  ${key.padEnd(24)} ${value}`);
  }
  if (summary.checkErrors?.length) console.log(`  ${'проверки с ошибкой'.padEnd(24)} ${summary.checkErrors.join(', ')}`);
}

const HELP = `Стенд тестирования вёрстки — CLI

  lt info                                 состояние стенда, пути, пресеты
  lt shot       --url URL [--name N]      скриншот
  lt audit      --url URL [--checks ...]  комплексная проверка (${ALL_CHECKS.join(', ')}, all)
  lt compare    --url URL --name N        сравнение с эталоном (--update перезаписывает эталон)
  lt matrix     --url URL [оси]           прогон по матрице условий
  lt lighthouse --url URL                 отчёт Lighthouse
  lt storybook  --url URL                 обход всех историй Storybook
  lt baselines                            список эталонов
  lt runs                                 список прогонов
  lt clean      [--keep N]                удалить старые прогоны

Условия просмотра (для shot, audit, compare, storybook):
  --browser chromium|firefox|webkit   --viewport 375x812 или ${Object.keys(VIEWPORTS).join('|')}
  --dark   --rtl   --forced-colors    --zoom 200   --text-zoom 200   --pseudo
  --dpr 2  --freeze-time              --full=false  (по умолчанию снимок всей страницы)
  --mask ".ads,.clock"                закрасить нестабильные зоны

Оси матрицы (списки через запятую):
  --browsers  --viewports  --schemes light,dark  --rtl-axis true,false
  --zooms 100,200  --forced none,active  --pseudo-axis true,false  --dprs 1,2
  --checks     --concurrency 2   --update
`;

async function main() {
  const flags = parseFlags(argv.slice(1));

  switch (command) {
    case 'info': {
      const vnu = await fetch(`${CONFIG.vnuUrl}/`, { method: 'HEAD' })
        .then((r) => (r.ok ? 'доступен' : `ответил ${r.status}`))
        .catch((e) => `недоступен (${e.message})`);
      console.log('Рабочий каталог :', DIRS.root);
      console.log('Артефакты       :', DIRS.artifacts, '->', CONFIG.publicBaseUrl);
      console.log('Эталоны         :', DIRS.baselines);
      console.log('Chrome для LH   :', CONFIG.chromePath || '(не задан)');
      console.log('Валидатор vnu   :', CONFIG.vnuUrl, `— ${vnu}`);
      console.log('Проверки        :', ALL_CHECKS.join(', '));
      console.log('Viewport-пресеты:', Object.entries(VIEWPORTS).map(([k, v]) => `${k}=${v.width}x${v.height}`).join(', '));
      break;
    }

    case 'shot': {
      const url = requireUrl(flags);
      const name = flags.name || 'shot';
      const session = await createSession(profileFrom(flags));
      try {
        await gotoAndSettle(session, url);
        const shot = await takeScreenshot(session.page, {
          runId: newRunId(slug(name)),
          name: `${slug(name)}__${slug(session.key)}`,
          fullPage: flags.full !== 'false',
          selector: flags.selector,
          mask: list(flags.mask) || [],
        });
        console.log(`Снимок ${shot.width}x${shot.height}`);
        console.log('  файл :', shot.path);
        console.log('  ссылка:', shot.url);
      } finally {
        await closeSession(session.id);
      }
      break;
    }

    case 'audit': {
      const url = requireUrl(flags);
      const report = await runAudit({
        url,
        profile: profileFrom(flags),
        checks: list(flags.checks) || [],
        name: flags.name || 'page',
        mask: list(flags.mask) || [],
        fullPage: flags.full !== 'false',
        updateBaseline: bool(flags.update),
      });
      console.log(`Прогон ${report.runId} · ${report.profileKey}`);
      printSummary(report.summary);
      console.log('  артефакты:', `${CONFIG.publicBaseUrl}/${report.runId}/`);
      break;
    }

    case 'compare': {
      const url = requireUrl(flags);
      if (!flags.name) {
        console.error('Нужен --name: это имя эталона');
        process.exit(2);
      }
      const report = await runAudit({
        url,
        profile: profileFrom(flags),
        checks: ['screenshot', 'visual'],
        name: flags.name,
        mask: list(flags.mask) || [],
        fullPage: flags.full !== 'false',
        updateBaseline: bool(flags.update),
        threshold: flags.threshold ? Number(flags.threshold) : undefined,
      });
      const v = report.results.visual || {};
      console.log(`Прогон ${report.runId} · ${report.profileKey}`);
      console.log('  статус       :', v.status);
      if (v.diffPercentage !== undefined) console.log('  расхождение  :', `${v.diffPercentage}%`, `(порог ${v.threshold}%)`);
      if (v.note) console.log('  примечание   :', v.note);
      if (v.diff) console.log('  карта отличий:', v.diff.url);
      process.exitCode = v.match === false ? 1 : 0;
      break;
    }

    case 'matrix': {
      const url = requireUrl(flags);
      let axes = {
        browser: list(flags.browsers),
        viewport: list(flags.viewports),
        colorScheme: list(flags.schemes),
        rtl: list(flags['rtl-axis'])?.map(bool),
        zoom: list(flags.zooms)?.map(Number),
        forcedColors: list(flags.forced),
        pseudoLoc: list(flags['pseudo-axis'])?.map(bool),
        deviceScaleFactor: list(flags.dprs)?.map(Number),
      };
      if (flags.config) {
        const cfg = JSON.parse(await readFile(flags.config, 'utf8'));
        axes = { ...axes, ...cfg.axes };
        flags.checks = flags.checks || (cfg.checks || []).join(',');
        flags.name = flags.name || cfg.name;
      }
      const result = await runMatrix({
        url,
        name: flags.name || 'matrix',
        checks: list(flags.checks) || ['layout', 'screenshot', 'vitals'],
        axes,
        concurrency: flags.concurrency ? Number(flags.concurrency) : 2,
        updateBaseline: bool(flags.update),
        mask: list(flags.mask) || [],
        onProgress: ({ done, total, key }) => process.stderr.write(`  [${done}/${total}] ${key}\n`),
      });
      console.log(`\nМатрица ${result.runId}: комбинаций ${result.total}, с проблемами ${result.withProblems}, не удалось ${result.failed}`);
      for (const cell of result.cells) {
        const mark = !cell.ok ? '!' : cell.verdict === 'проблем не найдено' ? '.' : '×';
        console.log(`  ${mark} ${cell.key.padEnd(40)} ${cell.verdict}`);
      }
      console.log('\n  отчёт:', publicUrl(result.report));
      process.exitCode = result.withProblems || result.failed ? 1 : 0;
      break;
    }

    case 'lighthouse': {
      const url = requireUrl(flags);
      const result = await runLighthouse(url, {
        runId: newRunId('lighthouse'),
        preset: flags.preset || 'desktop',
        categories: list(flags.categories),
      });
      console.log('Оценки:', Object.entries(result.scores).map(([k, v]) => `${k}=${v}`).join(' '));
      for (const [id, m] of Object.entries(result.metrics)) console.log(`  ${id.padEnd(28)} ${m.display}`);
      console.log('  отчёт:', result.report.url);
      break;
    }

    case 'storybook': {
      const url = requireUrl(flags);
      const result = await auditStorybook({
        storybookUrl: url,
        profile: profileFrom(flags),
        include: flags.include,
        limit: flags.limit ? Number(flags.limit) : 100,
        visual: bool(flags.visual),
      });
      console.log(`Историй ${result.total}, с проблемами ${result.withProblems}`);
      for (const s of result.stories.filter((x) => x.problems?.length)) {
        console.log(`  × ${s.id}: ${s.problems.join('; ')}`);
      }
      console.log('  отчёт:', publicUrl(result.report));
      process.exitCode = result.withProblems ? 1 : 0;
      break;
    }

    case 'baselines': {
      const items = await listBaselines(DIRS.baselines);
      if (!items.length) console.log('Эталонов пока нет.');
      for (const b of items) console.log(`  ${b.name.padEnd(50)} ${b.mtime}`);
      break;
    }

    case 'runs': {
      const runs = await listRuns();
      for (const r of runs.slice(0, Number(flags.limit || 30))) console.log(`  ${r}  ${CONFIG.publicBaseUrl}/${r}/`);
      if (!runs.length) console.log('Прогонов пока нет.');
      break;
    }

    case 'clean': {
      const removed = await pruneRuns(flags.keep ? Number(flags.keep) : undefined);
      console.log(`Удалено прогонов: ${removed.length}`);
      break;
    }

    default:
      console.log(HELP);
      process.exitCode = command ? 2 : 0;
  }
}

try {
  await main();
} catch (err) {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeAll();
}
