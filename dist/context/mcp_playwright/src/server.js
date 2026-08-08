import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { CONFIG, DIRS, BROWSERS, VIEWPORTS } from './config.js';
import { artifactRef, ensureDirs, listRuns, newRunId, pruneRuns, publicUrl, slug } from './artifacts.js';
import { createSession, closeSession, getSession, listSessions, gotoAndSettle } from './browser/pool.js';
import { profileKey } from './browser/profile.js';
import { layoutAudit, computedStyles } from './checks/layout.js';
import { pageSnapshot } from './checks/snapshot.js';
import { takeScreenshot, compareWithBaseline, inlineImage, listBaselines } from './checks/visual.js';
import { runAxe, runPa11y } from './checks/a11y.js';
import { installVitalsCollector, readVitals, runLighthouse } from './checks/perf.js';
import { validateHtmlWithVnu, validateHtmlLocal, lintCss, readLocalFile } from './checks/static.js';
import { auditStorybook } from './checks/storybook.js';
import { runAudit, ALL_CHECKS } from './audit.js';
import { runMatrix, AXES } from './matrix.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const profileSchema = {
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe('Движок браузера'),
  viewport: z.string().optional().describe(`Размер: WxH или имя (${Object.keys(VIEWPORTS).join(', ')})`),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  forcedColors: z.enum(['none', 'active']).optional().describe('Режим высокой контрастности Windows'),
  reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  rtl: z.boolean().optional().describe('Развернуть страницу справа налево'),
  zoom: z.number().optional().describe('Масштаб страницы в процентах: 200 сжимает viewport вдвое'),
  textZoom: z.number().optional().describe('Масштаб только шрифта в процентах (WCAG 1.4.4)'),
  pseudoLoc: z.boolean().optional().describe('Псевдолокализация: диакритика и +40% длины строк'),
  deviceScaleFactor: z.number().optional().describe('DPR: 1, 2, 3'),
  locale: z.string().optional(),
  timezoneId: z.string().optional(),
  freezeTime: z.boolean().optional().describe('Заморозить Date и Math.random для стабильных снимков'),
  throttle: z
    .object({ network: z.string().optional(), cpu: z.number().optional() })
    .optional()
    .describe('Троттлинг (только chromium): network 3g|slow-3g|4g, cpu — множитель замедления'),
};

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

export async function createServer() {
  await ensureDirs();
  const server = new McpServer({ name: 'layout-testing', version: pkg.version });

  // ---------- Сессия и навигация ----------

  server.registerTool(
    'browser_open',
    {
      title: 'Открыть браузер',
      description:
        'Создаёт сессию браузера с заданными условиями просмотра и, если передан url, сразу переходит на страницу. Возвращает sessionId для остальных инструментов.',
      inputSchema: { url: z.string().optional(), ...profileSchema },
    },
    async ({ url, ...profile }) => {
      const session = await createSession(profile);
      const result = {
        sessionId: session.id,
        profileKey: session.key,
        profile: session.profile,
        unsupported: session.unsupported,
      };
      if (url) result.navigation = await gotoAndSettle(session, url);
      return json(result);
    },
  );

  server.registerTool(
    'browser_goto',
    {
      title: 'Перейти по адресу',
      description: 'Навигация в существующей сессии со стабилизацией страницы (стоп-анимации, ожидание шрифтов).',
      inputSchema: {
        sessionId: z.string(),
        url: z.string(),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
      },
    },
    async ({ sessionId, url, waitUntil }) => json(await gotoAndSettle(getSession(sessionId), url, { waitUntil })),
  );

  server.registerTool(
    'browser_act',
    {
      title: 'Действие на странице',
      description: 'Клик, ввод текста, нажатие клавиши, наведение, прокрутка или ожидание селектора.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['click', 'fill', 'press', 'hover', 'scroll', 'wait', 'select']),
        selector: z.string().optional(),
        value: z.string().optional().describe('Текст для fill, клавиша для press, значение для select'),
        x: z.number().optional().describe('Прокрутка по горизонтали'),
        y: z.number().optional().describe('Прокрутка по вертикали'),
      },
    },
    async ({ sessionId, action, selector, value, x = 0, y = 0 }) => {
      const { page } = getSession(sessionId);
      switch (action) {
        case 'click': await page.locator(selector).first().click(); break;
        case 'fill': await page.locator(selector).first().fill(value ?? ''); break;
        case 'press': await page.locator(selector).first().press(value ?? 'Enter'); break;
        case 'hover': await page.locator(selector).first().hover(); break;
        case 'select': await page.locator(selector).first().selectOption(value ?? ''); break;
        case 'scroll': await page.evaluate(([sx, sy]) => window.scrollBy(sx, sy), [x, y]); break;
        case 'wait': await page.locator(selector).first().waitFor({ state: 'visible' }); break;
        default: throw new Error(`Неизвестное действие: ${action}`);
      }
      return json({ ok: true, action, selector, url: page.url() });
    },
  );

  server.registerTool(
    'browser_eval',
    {
      title: 'Выполнить JS на странице',
      description: 'Выполняет выражение или тело функции в контексте страницы и возвращает результат.',
      inputSchema: { sessionId: z.string(), expression: z.string() },
    },
    async ({ sessionId, expression }) => {
      const { page } = getSession(sessionId);
      const result = await page.evaluate(
        (src) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (async () => { ${src.includes('return') ? src : `return (${src})`} })()`);
          return fn();
        },
        expression,
      );
      return json({ result });
    },
  );

  server.registerTool(
    'browser_sessions',
    { title: 'Список сессий', description: 'Показывает открытые сессии браузера.', inputSchema: {} },
    async () => json({ sessions: listSessions() }),
  );

  server.registerTool(
    'browser_close',
    { title: 'Закрыть сессию', description: 'Закрывает сессию браузера и освобождает память.', inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) => json({ closed: await closeSession(sessionId) }),
  );

  // ---------- Наблюдение ----------

  server.registerTool(
    'page_snapshot',
    {
      title: 'Текстовый слепок страницы',
      description:
        'Дерево ролей, имён и селекторов. Дешевле скриншота по объёму и содержит готовые селекторы для действий.',
      inputSchema: {
        sessionId: z.string(),
        maxNodes: z.number().optional(),
        interactiveOnly: z.boolean().optional().describe('Только ссылки, кнопки и поля'),
      },
    },
    async ({ sessionId, maxNodes, interactiveOnly }) => {
      const snap = await pageSnapshot(getSession(sessionId).page, { maxNodes, interactiveOnly });
      return text(
        `${snap.title} — ${snap.url}\nlang=${snap.lang} dir=${snap.dir}${snap.truncated ? ' (обрезано)' : ''}\n\n${snap.text}`,
      );
    },
  );

  server.registerTool(
    'page_logs',
    {
      title: 'Логи страницы',
      description: 'Консоль, необработанные ошибки JS и неудачные сетевые запросы, собранные с момента открытия сессии.',
      inputSchema: {
        sessionId: z.string(),
        kind: z.enum(['all', 'console', 'errors', 'network']).optional(),
        onlyProblems: z.boolean().optional(),
      },
    },
    async ({ sessionId, kind = 'all', onlyProblems = true }) => {
      const { logs } = getSession(sessionId);
      const network = onlyProblems
        ? logs.network.filter((n) => n.failure || (n.status && n.status >= 400))
        : logs.network;
      const console_ = onlyProblems ? logs.console.filter((c) => c.type === 'error' || c.type === 'warning') : logs.console;
      const all = { console: console_, errors: logs.errors, network };
      return json(kind === 'all' ? all : { [kind]: all[kind === 'errors' ? 'errors' : kind] });
    },
  );

  // ---------- Вёрстка ----------

  server.registerTool(
    'layout_audit',
    {
      title: 'Эвристики вёрстки',
      description:
        'Ищет горизонтальный скролл, вылеты за viewport, наложения элементов, обрезанный текст, битые картинки, картинки без размеров, мелкие тач-таргеты и низкий контраст.',
      inputSchema: {
        sessionId: z.string(),
        minTarget: z.number().optional().describe('Минимальный размер тач-таргета, px (по умолчанию 24)'),
        contrastRatio: z.number().optional().describe('Требуемый контраст обычного текста (по умолчанию 4.5)'),
      },
    },
    async ({ sessionId, minTarget, contrastRatio }) =>
      json(await layoutAudit(getSession(sessionId).page, { minTarget, contrastRatio })),
  );

  server.registerTool(
    'computed_styles',
    {
      title: 'Вычисленные стили',
      description: 'Геометрия и итоговые CSS-свойства элемента — чтобы понять, почему блок не там, где ожидается.',
      inputSchema: { sessionId: z.string(), selector: z.string(), props: z.array(z.string()).optional() },
    },
    async ({ sessionId, selector, props }) => json(await computedStyles(getSession(sessionId).page, selector, props)),
  );

  // ---------- Скриншоты и визуальная регрессия ----------

  server.registerTool(
    'screenshot',
    {
      title: 'Скриншот',
      description:
        'Снимок страницы или элемента. Возвращает путь и URL; картинку в ответ вкладывает только при inline=true.',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional(),
        fullPage: z.boolean().optional(),
        selector: z.string().optional().describe('Снять только этот элемент'),
        mask: z.array(z.string()).optional().describe('Селекторы нестабильных зон — закрашиваются'),
        inline: z.boolean().optional().describe('Вложить уменьшенную картинку в ответ'),
        runId: z.string().optional(),
      },
    },
    async ({ sessionId, name = 'screenshot', fullPage = true, selector, mask, inline = false, runId }) => {
      const session = getSession(sessionId);
      const shot = await takeScreenshot(session.page, {
        runId: runId || newRunId(slug(name)),
        name: `${slug(name)}__${slug(session.key)}`,
        fullPage,
        selector,
        mask,
      });
      const content = [{ type: 'text', text: JSON.stringify(shot, null, 2) }];
      if (inline) {
        const img = await inlineImage(shot.path);
        content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
      return { content };
    },
  );

  server.registerTool(
    'visual_compare',
    {
      title: 'Сравнить с эталоном',
      description:
        'Снимает страницу и сравнивает с эталоном. Если эталона нет, снимок становится эталоном и это сообщается явно.',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().describe('Имя эталона'),
        fullPage: z.boolean().optional(),
        selector: z.string().optional(),
        mask: z.array(z.string()).optional(),
        threshold: z.number().optional().describe('Допустимое расхождение в процентах пикселей'),
        updateBaseline: z.boolean().optional().describe('Перезаписать эталон текущим снимком'),
      },
    },
    async ({ sessionId, name, fullPage = true, selector, mask, threshold, updateBaseline }) => {
      const session = getSession(sessionId);
      const runId = newRunId(slug(name));
      const shot = await takeScreenshot(session.page, {
        runId,
        name: `${slug(name)}__${slug(session.key)}`,
        fullPage,
        selector,
        mask,
      });
      const result = await compareWithBaseline({
        runId,
        name,
        profileKey: session.key,
        actualPath: shot.path,
        threshold,
        updateBaseline,
      });
      return json({ runId, ...result });
    },
  );

  server.registerTool(
    'visual_baselines',
    { title: 'Эталоны', description: 'Список сохранённых эталонов визуальной регрессии.', inputSchema: {} },
    async () => json({ dir: DIRS.baselines, baselines: await listBaselines(DIRS.baselines) }),
  );

  // ---------- Доступность ----------

  server.registerTool(
    'a11y_axe',
    {
      title: 'Проверка axe-core',
      description: 'Правила WCAG внутри открытой страницы: видит её в текущем состоянии, после логина и раскрытых меню.',
      inputSchema: {
        sessionId: z.string(),
        tags: z.array(z.string()).optional().describe('Например wcag2aa, wcag21aa, best-practice'),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      },
    },
    async ({ sessionId, tags, include, exclude }) =>
      json(await runAxe(getSession(sessionId).page, { tags, include, exclude })),
  );

  server.registerTool(
    'a11y_pa11y',
    {
      title: 'Проверка pa11y',
      description: 'Второй набор правил (HTML CodeSniffer) по URL — ловит не то же, что axe.',
      inputSchema: {
        url: z.string(),
        standard: z.enum(['WCAG2A', 'WCAG2AA', 'WCAG2AAA']).optional(),
      },
    },
    async ({ url, standard }) => json(await runPa11y(url, { standard })),
  );

  // ---------- Метрики ----------

  server.registerTool(
    'web_vitals',
    {
      title: 'Web Vitals',
      description:
        'CLS, LCP, FCP, TTFB для указанного URL с перечислением элементов, сдвинувших layout. Ловит то, чего не видно на статичном скриншоте.',
      inputSchema: { url: z.string(), settleMs: z.number().optional(), ...profileSchema },
    },
    async ({ url, settleMs, ...profile }) => {
      const session = await createSession(profile);
      try {
        await installVitalsCollector(session.page);
        const nav = await gotoAndSettle(session, url, { stabilizePage: false });
        return json({ navigation: nav, profileKey: session.key, vitals: await readVitals(session.page, { settleMs }) });
      } finally {
        await closeSession(session.id);
      }
    },
  );

  server.registerTool(
    'lighthouse',
    {
      title: 'Отчёт Lighthouse',
      description: 'Полный прогон Lighthouse. Возвращает оценки, метрики и провалившиеся аудиты, HTML-отчёт кладёт в артефакты.',
      inputSchema: {
        url: z.string(),
        categories: z.array(z.enum(['performance', 'accessibility', 'best-practices', 'seo'])).optional(),
        preset: z.enum(['mobile', 'desktop']).optional(),
      },
    },
    async ({ url, categories, preset }) => json(await runLighthouse(url, { runId: newRunId('lighthouse'), categories, preset })),
  );

  // ---------- Статические проверки ----------

  server.registerTool(
    'validate_html',
    {
      title: 'Валидация HTML',
      description:
        'Проверяет разметку через Nu HTML Checker. Источник — открытая сессия, произвольный URL или переданный текст.',
      inputSchema: {
        sessionId: z.string().optional(),
        url: z.string().optional(),
        html: z.string().optional(),
      },
    },
    async ({ sessionId, url, html }) => {
      let source = html;
      if (!source && sessionId) source = await getSession(sessionId).page.content();
      if (!source && url) source = await (await fetch(url)).text();
      if (!source) throw new Error('Нужен sessionId, url или html.');
      try {
        return json({ source: 'vnu', ...(await validateHtmlWithVnu(source)) });
      } catch (err) {
        return json({ source: 'html-validate', fallbackReason: err.message, ...(await validateHtmlLocal(source)) });
      }
    },
  );

  server.registerTool(
    'lint_css',
    {
      title: 'Проверка CSS',
      description: 'Stylelint по файлам рабочего каталога или по переданному коду.',
      inputSchema: {
        files: z.array(z.string()).optional().describe('Пути относительно рабочего каталога, глоб поддерживается'),
        code: z.string().optional(),
        config: z.record(z.any()).optional(),
      },
    },
    async ({ files, code, config }) => json(await lintCss({ files, code, config })),
  );

  // ---------- Комплексные прогоны ----------

  server.registerTool(
    'audit',
    {
      title: 'Комплексная проверка страницы',
      description:
        `Открывает URL под заданными условиями и прогоняет выбранные проверки: ${ALL_CHECKS.join(', ')} или all. Возвращает сводку и складывает артефакты.`,
      inputSchema: {
        url: z.string(),
        checks: z.array(z.enum([...ALL_CHECKS, 'all'])).optional(),
        name: z.string().optional().describe('Имя прогона; используется в именах файлов и эталонов'),
        mask: z.array(z.string()).optional(),
        fullPage: z.boolean().optional(),
        updateBaseline: z.boolean().optional(),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
          .optional()
          .describe('Чего ждать при переходе. Для тяжёлых боевых сайтов — domcontentloaded'),
        timeout: z.number().optional().describe('Таймаут навигации, мс'),
        ...profileSchema,
      },
    },
    async ({ url, checks, name = 'page', mask, fullPage, updateBaseline, waitUntil, timeout, ...profile }) => {
      const report = await runAudit({ url, profile, checks, name, mask, fullPage, updateBaseline, waitUntil, timeout });
      return json({
        runId: report.runId,
        profileKey: report.profileKey,
        summary: report.summary,
        artifacts: `${CONFIG.publicBaseUrl}/${report.runId}/`,
        results: report.results,
        errors: report.errors,
      });
    },
  );

  server.registerTool(
    'matrix_run',
    {
      title: 'Матрица условий',
      description:
        'Прогоняет страницу по декартову произведению осей (браузеры × viewport × тема × RTL × zoom × forced-colors × псевдолокализация × DPR) и собирает сводный HTML-отчёт.',
      inputSchema: {
        url: z.string(),
        name: z.string().optional(),
        checks: z.array(z.enum([...ALL_CHECKS, 'all'])).optional(),
        browsers: z.array(z.enum(BROWSERS)).optional(),
        viewports: z.array(z.string()).optional(),
        colorSchemes: z.array(z.enum(['light', 'dark'])).optional(),
        rtl: z.array(z.boolean()).optional(),
        zooms: z.array(z.number()).optional(),
        forcedColors: z.array(z.enum(['none', 'active'])).optional(),
        pseudoLoc: z.array(z.boolean()).optional(),
        deviceScaleFactors: z.array(z.number()).optional(),
        concurrency: z.number().optional().describe('Сколько комбинаций гнать параллельно (по умолчанию 2)'),
        updateBaseline: z.boolean().optional(),
        mask: z.array(z.string()).optional(),
      },
    },
    async ({
      url, name = 'matrix', checks, browsers, viewports, colorSchemes, rtl, zooms,
      forcedColors, pseudoLoc, deviceScaleFactors, concurrency, updateBaseline, mask,
    }) => {
      const result = await runMatrix({
        url,
        name,
        checks,
        concurrency,
        updateBaseline,
        mask,
        axes: {
          browser: browsers,
          viewport: viewports,
          colorScheme: colorSchemes,
          rtl,
          zoom: zooms,
          forcedColors,
          pseudoLoc,
          deviceScaleFactor: deviceScaleFactors,
        },
      });
      return json({ ...result, report: publicUrl(result.report), axes: AXES });
    },
  );

  server.registerTool(
    'storybook_audit',
    {
      title: 'Обход Storybook',
      description: 'Проходит все истории Storybook, для каждой снимает скриншот и гоняет layout-эвристики и axe.',
      inputSchema: {
        storybookUrl: z.string().describe('Например http://node_myapp:6006'),
        include: z.string().optional().describe('Регулярное выражение по id и заголовку истории'),
        limit: z.number().optional(),
        visual: z.boolean().optional().describe('Сравнивать каждую историю с эталоном'),
        ...profileSchema,
      },
    },
    async ({ storybookUrl, include, limit, visual, ...profile }) =>
      json(await auditStorybook({ storybookUrl, include, limit, visual, profile })),
  );

  // ---------- Артефакты ----------

  server.registerTool(
    'artifacts_list',
    {
      title: 'Артефакты прогонов',
      description: 'Список прогонов и ссылок на их отчёты.',
      inputSchema: { limit: z.number().optional() },
    },
    async ({ limit = 20 }) => {
      const runs = (await listRuns()).slice(0, limit);
      return json({
        baseUrl: CONFIG.publicBaseUrl,
        runs: runs.map((r) => ({ runId: r, url: `${CONFIG.publicBaseUrl}/${r}/` })),
      });
    },
  );

  server.registerTool(
    'artifacts_clean',
    {
      title: 'Очистить артефакты',
      description: 'Удаляет старые прогоны, оставляя последние keep штук.',
      inputSchema: { keep: z.number().optional() },
    },
    async ({ keep }) => json({ removed: await pruneRuns(keep) }),
  );

  server.registerTool(
    'read_artifact',
    {
      title: 'Прочитать артефакт',
      description: 'Читает JSON или текстовый файл из каталога артефактов.',
      inputSchema: { file: z.string().describe('Путь относительно каталога артефактов') },
    },
    async ({ file }) => {
      const abs = path.resolve(DIRS.artifacts, file);
      if (!abs.startsWith(DIRS.artifacts)) throw new Error('Путь выходит за пределы каталога артефактов.');
      return text(await readFile(abs, 'utf8'));
    },
  );

  server.registerTool(
    'read_project_file',
    {
      title: 'Прочитать файл стенда',
      description: 'Читает файл из рабочего каталога стенда — фикстуру, конфиг матрицы, CSS.',
      inputSchema: { file: z.string() },
    },
    async ({ file }) => text(await readLocalFile(file)),
  );

  server.registerTool(
    'stand_info',
    {
      title: 'Состояние стенда',
      description: 'Версии, пути, доступные браузеры и viewport-пресеты, адреса артефактов и валидатора.',
      inputSchema: {},
    },
    async () => {
      const vnu = await fetch(`${CONFIG.vnuUrl}/`, { method: 'HEAD' })
        .then((r) => (r.ok ? 'доступен' : `ответил ${r.status}`))
        .catch((e) => `недоступен: ${e.message}`);
      return json({
        version: pkg.version,
        dirs: DIRS,
        publicBaseUrl: CONFIG.publicBaseUrl,
        vnu: { url: CONFIG.vnuUrl, state: vnu },
        chromePath: CONFIG.chromePath || '(не задан)',
        browsers: BROWSERS,
        viewports: VIEWPORTS,
        checks: ALL_CHECKS,
        sessions: listSessions(),
      });
    },
  );

  return server;
}
