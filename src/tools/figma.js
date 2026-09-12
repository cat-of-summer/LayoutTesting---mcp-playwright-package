/**
 * Инструменты: макеты Figma.
 *
 * Группа держится на одном правиле — макет снимается один раз. Лимит REST API на Starter — десять
 * запросов в минуту к файлам, у места View/Collab двадцать в месяц, и разбор, который ходит в Figma
 * на каждый вопрос, кончается раньше, чем начинается вёрстка. Поэтому figma_sync складывает узлы в
 * снимок, остальные инструменты читают снимок и докачивают только то, чего в нём нет.
 *
 * Каналов два: редактор в браузере стенда (Plugin API, без лимита) и REST. Выбирает стенд, агент
 * про вход и токены не знает ничего, кроме того, что показывает figma_status.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { t } from '../i18n.js';
import { DIRS } from '../config.js';
import { capped, json, linkBlocks } from './shared.js';
import { inlineImage } from '../checks/visual.js';
import { checkFigmaApi } from '../figma/api-check.js';
import { issueTokenNow, lastTokenIssue, resolveToken } from '../figma/auth.js';
import { FIGMA } from '../config.js';
import { editorChannel, editorLogin, editorLogout, editorStatus } from '../figma/editor.js';
import { exportImages, exportRender, exportSvg } from '../figma/export.js';
import { cssItems, outlineLines } from '../figma/inspect.js';
import { getRestClient } from '../figma/rest.js';
import { addRequests, ensureNode, ensureNodes, findNode, syncFigma } from '../figma/snapshot.js';
import { groupRefs, refOf } from '../figma/url.js';
import { loadProject, projectSummary } from '../figma/project.js';
import { inferStructure } from '../figma/analyze/structure.js';
import { findComponents } from '../figma/analyze/components.js';
import { collectTokens } from '../figma/analyze/tokens.js';
import { compareBreakpoints } from '../figma/analyze/breakpoints.js';
import { buildThreads, collectAnnotations, fetchComments } from '../figma/analyze/comments.js';
import { describeBehavior } from '../figma/analyze/behavior.js';
import { compareWithDesign } from '../figma/compare.js';
import { getSession, gotoAndSettle, withSession } from '../browser/pool.js';

/* /v1/me стоит запроса tier 3. figma_status зовут, когда что-то не работает, — то есть подряд. */
const ME_TTL_MS = 10 * 60 * 1000;
let meCache = null;

async function whoami(client, refresh) {
  if (!refresh && meCache && Date.now() - meCache.at < ME_TTL_MS) return meCache.value;
  const me = await client.me();
  /* Почту не отдаём: агенту для работы достаточно знать, что вход под кем-то есть. */
  meCache = { at: Date.now(), value: { handle: me.handle ?? null } };
  return meCache.value;
}

async function cachedFiles() {
  try {
    const entries = await fs.readdir(DIRS.figma, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

const refsSchema = z
  .array(z.string())
  .min(1)
  .describe(d('Ссылки figma.com или записи ключ:id. Узлы одного файла уходят одним запросом'));

const projectSchema = z
  .object({ url: z.string().optional(), css: z.string().optional(), scss: z.string().optional() })
  .optional()
  .describe(d('Проект для сверки: url страницы — стенд сам заберёт её CSS, либо текст CSS или SCSS'));

/** Кадры для разбора: из кэша, недостающие докачиваются одним снятием на файл. */
async function loadFrames(refs, client) {
  const frames = [];
  const requests = { tier1: 0, tier2: 0, tier3: 0 };
  for (const group of groupRefs(refs)) {
    if (!group.nodeIds.length) throw new Error('Нужны узлы, а не файл целиком: ссылка с node-id или запись ключ:id.');
    const { found, requests: spent } = await ensureNodes(group.fileKey, group.nodeIds, { client, editor: editorChannel });
    addRequests(requests, spent);
    for (const id of group.nodeIds) {
      const { snapshot } = found.get(id);
      const node = snapshot.nodes[id];
      frames.push({ snapshot, rootId: id, ref: refOf(group.fileKey, id), width: node.box?.w, name: node.name });
    }
  }
  return { frames, requests };
}

const withProject = async (project) => (project && (project.url || project.css || project.scss) ? loadProject(project) : null);

export function register(server) {
  server.registerTool(
    'figma_status',
    {
      title: t({ ru: 'Доступ к Figma', en: 'Figma access' }),
      description: t({
        ru: 'Доступ к Figma: работает ли токен REST и сколько осталось лимита, вошёл ли стенд в редактор, не отстала ли версия API. Секретов не показывает. Первый шаг, если figma_* отказывают; action: login входит в редактор заново или дозавершает вход кодом.',
        en: 'Figma access: whether the REST token works and how much of the limit is left, whether the stand is logged into the editor, whether the API version fell behind. Never reveals secrets. The first step when figma_* fail; action: login logs into the editor again or finishes a login with a code.',
      }),
      inputSchema: {
        action: z
          .enum(['check', 'login', 'logout', 'token'])
          .optional()
          .describe(d('check (по умолчанию) — проверить; login — войти в редактор заново или дозавершить вход кодом; logout — забыть сохранённый вход; token — выпустить токен REST через настройки аккаунта')),
        otp: z.string().optional().describe(d('Код двухфакторной аутентификации, если Figma его запросила')),
        refresh: z.boolean().optional().describe(d('Заново спросить Figma, а не взять проверку из кэша на 10 минут')),
      },
    },
    async ({ action = 'check', otp, refresh = false }) => {
      let loginError = null;
      let tokenError = null;
      if (action === 'login') {
        try {
          await editorLogin({ otp });
        } catch (err) {
          loginError = err.message;
        }
      } else if (action === 'logout') {
        await editorLogout();
      } else if (action === 'token') {
        try {
          await issueTokenNow();
          meCache = null;
        } catch (err) {
          tokenError = err.message;
        }
      }

      const client = getRestClient();
      const auth = await resolveToken();
      const rest = { configured: Boolean(auth.token), source: auth.source };
      if (auth.expiresAt) rest.expiresAt = auth.expiresAt;
      if (auth.token) {
        try {
          rest.user = (await whoami(client, refresh)).handle;
          rest.ok = true;
        } catch (err) {
          rest.ok = false;
          rest.error = err.message;
        }
      } else {
        rest.ok = false;
        rest.hint = FIGMA.autoIssueToken
          ? 'Токена нет. Стенд выпустит его сам через настройки аккаунта при первом запросе, которому нужен REST (комментарии, отказ редактора), — или сразу по action: token. Либо задайте FIGMA_TOKEN в .env стенда.'
          : 'Токена нет, а самостоятельный выпуск выключен (FIGMA_TOKEN_AUTOISSUE=0). Задайте FIGMA_TOKEN в .env стенда. Без токена работает только канал редактора, и без комментариев.';
      }
      rest.autoIssue = FIGMA.autoIssueToken;
      if (lastTokenIssue()) rest.lastIssue = lastTokenIssue();
      if (tokenError) rest.tokenError = tokenError;
      rest.budget = await client.budget();

      return json({
        rest,
        editor: { ...(await editorStatus()), ...(loginError ? { loginError } : {}) },
        api: await checkFigmaApi(),
        cache: { files: await cachedFiles() },
      });
    },
  );

  server.registerTool(
    'figma_sync',
    {
      title: t({ ru: 'Снять макет', en: 'Pull the design' }),
      description: t({
        ru: 'Снимает узлы макета в локальный снимок одним запросом на файл: десктоп, мобильную, модалки — все сразу. Дальше разбор идёт по снимку без обращений к Figma. Возвращает сводку по кадрам, канал и сколько запросов потрачено.',
        en: 'Pulls design nodes into a local snapshot with one request per file: desktop, mobile, modals — all at once. Later analysis reads the snapshot without calling Figma. Returns a per-frame summary, the channel used and how many requests were spent.',
      }),
      inputSchema: {
        figma: refsSchema,
        refresh: z.boolean().optional().describe(d('Сверить версию файла с Figma, даже если снимок свежий')),
        channel: z
          .enum(['auto', 'rest', 'editor'])
          .optional()
          .describe(d('auto (по умолчанию) — редактор, если в него есть вход, иначе REST; rest и editor — только этот канал')),
        css: z.boolean().optional().describe(d('Добавить CSS, который считает сама Figma. Только канал редактора, около 13 мс на узел')),
      },
    },
    async ({ figma, refresh = false, channel = 'auto', css = false }) => {
      const client = getRestClient();
      const result = await syncFigma(figma, { refresh, client, editor: editorChannel, channel, css });
      return json({ ...result, budget: (await client.budget()).tiers });
    },
  );

  server.registerTool(
    'figma_inspect',
    {
      title: t({ ru: 'Узел макета', en: 'Design node' }),
      description: t({
        ru: 'Узел макета по снимку: outline — дерево слоёв с размерами, раскладкой и текстами, одинаковые соседи свёрнуты; css — компактные стили узлов. Замена get_metadata и get_design_context без лимита вызовов.',
        en: 'A design node from the snapshot: outline — the layer tree with sizes, layout and texts, identical siblings collapsed; css — compact node styles. Replaces get_metadata and get_design_context without a call limit.',
      }),
      inputSchema: {
        figma: z.string().describe(d('Узел: ссылка figma.com или запись ключ:id')),
        mode: z
          .enum(['outline', 'css'])
          .optional()
          .describe(d('outline (по умолчанию) — дерево слоёв с раскладкой и текстами; css — стили узлов')),
        depth: z.number().optional().describe(d('Глубина обхода. По умолчанию 6 для outline и 2 для css')),
        hidden: z.boolean().optional().describe(d('Показывать скрытые слои')),
        limit: z.number().optional().describe(d('По умолчанию 200 строк outline или 60 узлов css')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, mode = 'outline', depth, hidden = false, limit, offset = 0 }) => {
      const { snapshot, node, fileKey, requests } = await ensureNode(figma, { client: getRestClient(), editor: editorChannel });
      const head = {
        ref: refOf(fileKey, node.id),
        version: snapshot.version,
        channel: snapshot.channel,
        mode,
        ...(requests ? { requests } : {}),
      };
      if (mode === 'css') {
        const items = cssItems(snapshot, node.id, { depth: depth ?? 2, hidden });
        return json({
          ...head,
          ...(snapshot.variables ? { variables: snapshot.variables } : {}),
          ...capped(items, { limit: limit ?? 60, offset }),
        });
      }
      return json({
        ...head,
        ...capped(outlineLines(snapshot, node.id, { depth: depth ?? 6, hidden }), { limit: limit ?? 200, offset }),
      });
    },
  );

  server.registerTool(
    'figma_structure',
    {
      title: t({ ru: 'Структура разметки', en: 'Markup structure' }),
      description: t({
        ru: 'Во что кадр превращается в разметке: дерево тегов и классов, собранное по геометрии, а не по слоям. Фон, декор и наложения выносятся отдельно, перепутанные слои переподчиняются, повторы сворачиваются в список. Рядом — слоты контента для layout_stress.',
        en: 'What the frame becomes in markup: a tree of tags and classes built from geometry rather than from layers. Backgrounds, decorations and overlays are pulled out, shuffled layers are reparented, repeats collapse into a list. Content slots for layout_stress come with it.',
      }),
      inputSchema: {
        figma: z.string().describe(d('Узел: ссылка figma.com или запись ключ:id')),
        depth: z.number().optional().describe(d('Глубина дерева. По умолчанию 10')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, depth, limit, offset = 0 }) => {
      const { snapshot, node, fileKey, requests } = await ensureNode(figma, { client: getRestClient(), editor: editorChannel });
      const result = inferStructure(snapshot, node.id, { depth: depth ?? 10 });
      return json({
        ref: refOf(fileKey, node.id),
        version: snapshot.version,
        channel: snapshot.channel,
        ...(requests ? { requests } : {}),
        body: result.body,
        headings: result.headings,
        ...capped(result.lines, { limit: limit ?? 150, offset }),
        notes: result.notes.slice(0, 30),
        slots: {
          lists: result.slots.lists,
          images: result.slots.images.length,
          texts: result.slots.texts.filter((slot) => slot.chars >= 20).slice(0, 40),
        },
      });
    },
  );

  server.registerTool(
    'figma_components',
    {
      title: t({ ru: 'Компоненты макета', en: 'Design components' }),
      description: t({
        ru: 'Группирует UI-элементы кадров, чтобы не плодить классы: инстансы одного компонента и одинаковые по составу блоки сводятся в один с модификаторами. Отдельно показывает дрейф — различия в пару пикселей или полтона, которые стоит свести, и совпадения с классами проекта.',
        en: 'Groups UI elements across frames so classes do not multiply: instances of one component and blocks with the same content collapse into one with modifiers. Separately shows drift — differences of a pixel or half a tone worth normalizing — and matches with existing project classes.',
      }),
      inputSchema: {
        figma: refsSchema,
        project: projectSchema,
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, project, limit, offset = 0 }) => {
      const client = getRestClient();
      const { frames, requests } = await loadFrames(figma, client);
      const loaded = await withProject(project);
      const result = findComponents(frames, { project: loaded });
      return json({
        frames: frames.map((frame) => frame.ref),
        ...(requests.tier1 || requests.tier2 || requests.tier3 ? { requests } : {}),
        ...(loaded ? { project: projectSummary(loaded) } : {}),
        counted: result.counted,
        ...capped(result.clusters, { limit: limit ?? 25, offset }),
        singles: result.singles,
      });
    },
  );

  server.registerTool(
    'figma_tokens',
    {
      title: t({ ru: 'Токены макета', en: 'Design tokens' }),
      description: t({
        ru: 'Что из макета становится CSS-переменной: палитра, типографика, шкалы отступов и радиусов, тени, длительности. Показывает, сколько раз значение вбито литералом при живой переменной Figma, сводит неразличимые цвета, даёт переменные компонентов по вариантам и clamp() для значений, меняющихся по ширине.',
        en: 'What becomes a CSS variable: palette, typography, spacing and radius scales, shadows, durations. Shows how often a value is hardcoded while a Figma variable exists, merges colors the eye cannot tell apart, derives component variables from variants and clamp() for values that change with width.',
      }),
      inputSchema: {
        figma: refsSchema,
        project: projectSchema,
        minUses: z.number().optional().describe(d('Значение становится токеном с этого числа использований. По умолчанию 2')),
      },
    },
    async ({ figma, project, minUses }) => {
      const client = getRestClient();
      const { frames, requests } = await loadFrames(figma, client);
      const loaded = await withProject(project);
      const tokens = collectTokens(frames, { project: loaded, minUses: minUses ?? 2 });
      return json({
        frames: frames.map((frame) => frame.ref),
        ...(requests.tier1 || requests.tier2 || requests.tier3 ? { requests } : {}),
        ...(loaded ? { project: projectSummary(loaded) } : {}),
        ...tokens,
      });
    },
  );

  server.registerTool(
    'figma_breakpoints',
    {
      title: t({ ru: 'Один экран на разных ширинах', en: 'One screen across widths' }),
      description: t({
        ru: 'Сопоставляет кадры одного экрана разной ширины по содержимому, а не по позиции: что тот же элемент, что изменилось (кегли, отступы, направление раскладки), что исчезло, чем заменено и где разошёлся порядок чтения. Линейно меняющиеся значения отдаёт готовым clamp().',
        en: 'Matches frames of one screen at different widths by content rather than position: what is the same element, what changed (sizes, spacing, layout direction), what disappeared, what replaced it and where the reading order diverges. Linearly changing values come back as a ready clamp().',
      }),
      inputSchema: {
        figma: z.array(z.string()).min(2).describe(d('Кадры одного экрана разной ширины: десктоп, планшет, мобильная')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
      },
    },
    async ({ figma, limit }) => {
      const client = getRestClient();
      const { frames, requests } = await loadFrames(figma, client);
      return json({
        ...(requests.tier1 || requests.tier2 || requests.tier3 ? { requests } : {}),
        ...compareBreakpoints(frames, { limit: limit ?? 40 }),
      });
    },
  );

  server.registerTool(
    'figma_compare',
    {
      title: t({ ru: 'Сверстано ли как в макете', en: 'Does the build match the design' }),
      description: t({
        ru: 'Сравнивает страницу с кадром макета: тексты сопоставляются по содержимому, и по каждому видно смещение, размер и расхождения типографики — с селектором и id узла. Попиксельное сравнение идёт вторым слоем, картой различий. Отдельно показывает, чего на странице нет и чего нет в макете.',
        en: 'Compares a page against a design frame: texts are matched by content, and each one shows its offset, size and typography differences — with a selector and a node id. The pixel diff comes as a second layer, a difference map. Separately lists what the page lacks and what the design lacks.',
      }),
      inputSchema: {
        figma: z.string().describe(d('Узел: ссылка figma.com или запись ключ:id')),
        sessionId: z.string().optional().describe(d('Сессия с открытой страницей: сравнение идёт по ней')),
        url: z.string().optional().describe(d('Адрес страницы: стенд откроет её сам шириной кадра макета')),
        selector: z.string().optional().describe(d('Блок на странице, которому соответствует кадр макета')),
        mode: z
          .enum(['both', 'semantic', 'pixel'])
          .optional()
          .describe(d('both (по умолчанию) — и смысловое, и попиксельное; semantic — только смысловое; pixel — только попиксельное')),
        tolerance: z.number().optional().describe(d('Допуск смещения в пикселях. По умолчанию 2')),
        threshold: z.number().optional().describe(d('Допустимое расхождение в процентах пикселей')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
      },
    },
    async ({ figma, sessionId, url, selector, mode = 'both', tolerance, threshold, limit }) => {
      const client = getRestClient();
      const { snapshot, node, fileKey } = await ensureNode(figma, { client, editor: editorChannel });
      const options = {
        figmaRef: refOf(fileKey, node.id),
        snapshot,
        rootId: node.id,
        selector,
        mode,
        client,
        editor: editorChannel,
        ...(tolerance ? { tolerance } : {}),
        ...(threshold ? { threshold } : {}),
        ...(limit ? { limit } : {}),
      };

      if (sessionId) return json(await compareWithDesign({ ...options, page: getSession(sessionId).page }));
      if (!url) throw new Error('Нужен sessionId открытой сессии или url страницы.');

      /* Своя сессия открывается шириной кадра: сравнивать десктопный макет с мобильной вёрсткой
         бессмысленно, а ширину по умолчанию агент задать забывает. */
      const width = Math.max(320, Math.round(node.box?.w || 1440));
      return withSession({ viewport: `${width}x900` }, async (session) => {
        const navigation = await gotoAndSettle(session, url);
        const result = await compareWithDesign({ ...options, page: session.page });
        return json({ ...result, navigation });
      });
    },
  );

  server.registerTool(
    'figma_comments',
    {
      title: t({ ru: 'Комментарии к макету', en: 'Design comments' }),
      description: t({
        ru: 'Комментарии Figma с ответами и аннотации Dev Mode, привязанные к элементам: видно, к чему относится «поправить отступ». Половина требований живёт здесь, а не в самом макете. Только канал REST: у Plugin API доступа к комментариям нет.',
        en: 'Figma comments with replies and Dev Mode annotations anchored to elements, so "fix the spacing" says what it is about. Half the requirements live here rather than in the design itself. REST channel only: the Plugin API has no access to comments.',
      }),
      inputSchema: {
        figma: refsSchema,
        resolved: z.boolean().optional().describe(d('Показывать и закрытые треды. По умолчанию только открытые')),
        refresh: z.boolean().optional().describe(d('Спросить Figma заново, а не взять список из кэша на 5 минут')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, resolved = false, refresh = false, limit, offset = 0 }) => {
      const client = getRestClient();
      const requests = { tier1: 0, tier2: 0, tier3: 0 };
      const frames = [];
      const threads = [];
      const seen = new Set();

      for (const group of groupRefs(figma)) {
        if (group.nodeIds.length) {
          const { found, requests: spent } = await ensureNodes(group.fileKey, group.nodeIds, { client, editor: editorChannel });
          addRequests(requests, spent);
          for (const id of group.nodeIds) {
            const { snapshot } = found.get(id);
            frames.push({ snapshot, rootId: id, ref: refOf(group.fileKey, id) });
          }
        }
        if (seen.has(group.fileKey)) continue;
        seen.add(group.fileKey);
        const data = await fetchComments(group.fileKey, { client, refresh });
        if (!data.fromCache) requests.tier2 += 1;
        threads.push(...buildThreads(data.comments, frames, { resolved }));
      }

      return json({
        frames: frames.map((frame) => frame.ref),
        ...(requests.tier1 || requests.tier2 || requests.tier3 ? { requests } : {}),
        ...capped(threads, { limit: limit ?? 30, offset }),
        annotations: collectAnnotations(frames).slice(0, 30),
      });
    },
  );

  server.registerTool(
    'figma_behavior',
    {
      title: t({ ru: 'Поведение по прототипу', en: 'Behavior from the prototype' }),
      description: t({
        ru: 'Что с чем связано: какая кнопка открывает какую модалку, что переключает вариант компонента, где прокрутка к якорю, что закреплено при прокрутке. Связи сгруппированы по цели — шесть одинаковых шевронов это один обработчик. Переходы отдаются готовой строкой transition.',
        en: 'What is wired to what: which button opens which modal, what switches a component variant, where scrolling to an anchor happens, what stays pinned while scrolling. Links are grouped by target — six identical chevrons are one handler. Transitions come back as a ready transition line.',
      }),
      inputSchema: {
        figma: refsSchema,
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, limit, offset = 0 }) => {
      const client = getRestClient();
      const { frames, requests } = await loadFrames(figma, client);
      const behavior = describeBehavior(frames);

      /* Цель связи часто лежит за пределами снятых кадров: модалка, другой экран, вариант
         компонента. Сначала ищем её в уже снятом, а чего нет — называем честно, а не молчим. */
      const files = [...new Set(groupRefs(figma).map((group) => group.fileKey))];
      const unresolved = [];
      for (const group of behavior.grouped) {
        if (!group.to || group.toName) continue;
        for (const fileKey of files) {
          const hit = await findNode(fileKey, group.to);
          if (hit) {
            group.toName = hit.node.name;
            group.toRef = refOf(fileKey, group.to);
            break;
          }
        }
        if (!group.toName) unresolved.push(refOf(files[0], group.to));
      }

      return json({
        frames: frames.map((frame) => frame.ref),
        ...(requests.tier1 || requests.tier2 || requests.tier3 ? { requests } : {}),
        edges: behavior.edges,
        ...capped(behavior.grouped, { limit: limit ?? 30, offset }),
        overlays: behavior.overlays,
        states: behavior.states,
        sticky: behavior.sticky,
        scrollAreas: behavior.scrollAreas,
        ...(behavior.motion.length ? { motion: behavior.motion } : {}),
        ...(behavior.unconfirmed ? { unconfirmed: behavior.unconfirmed } : {}),
        ...(unresolved.length
          ? {
              notSynced: {
                note: 'Цели этих связей не сняты — что это за экраны и варианты, покажет figma_sync по этим ссылкам.',
                refs: [...new Set(unresolved)].slice(0, 15),
              },
            }
          : {}),
      });
    },
  );

  server.registerTool(
    'figma_export',
    {
      title: t({ ru: 'Выгрузка из макета', en: 'Export from the design' }),
      description: t({
        ru: 'Файлы из макета в артефакты с постоянными ссылками: render — PNG узла, высокие кадры режутся на читаемые части; svg — иконки с currentColor; image — растровые заливки, кадрированные как в макете.',
        en: 'Files from the design into artifacts with permanent links: render — a PNG of a node, tall frames cut into readable parts; svg — icons with currentColor; image — raster fills cropped as in the design.',
      }),
      inputSchema: {
        figma: refsSchema,
        kind: z
          .enum(['render', 'svg', 'image'])
          .optional()
          .describe(d('render (по умолчанию) — PNG узла; svg — векторы и иконки; image — растровые заливки, кадрированные как в макете')),
        scale: z
          .number()
          .min(0.5)
          .max(4)
          .optional()
          .describe(d('Масштаб 0.5–4. Для render по умолчанию подбирается под читаемую ширину около 1000px, для image — 1 и 2')),
        clip: z
          .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .optional()
          .describe(d('Для render: вырезать прямоугольник в координатах узла')),
        inline: z.boolean().optional().describe(d('Вложить картинку в ответ. По умолчанию только ссылки')),
      },
    },
    async ({ figma, kind = 'render', scale, clip, inline = false }) => {
      const options = { client: getRestClient(), editor: editorChannel };
      if (kind === 'svg') return json(await exportSvg(figma, options));
      if (kind === 'image') return json(await exportImages(figma, { ...options, scales: scale ? [scale] : [1, 2] }));

      if (clip && figma.length !== 1) throw new Error('clip относится к одному узлу: передайте ровно одну ссылку.');
      const result = await exportRender(figma, { ...options, scale, clip });
      const content = [{ type: 'text', text: JSON.stringify(result) }, ...linkBlocks(result)];
      if (inline) {
        /* Не больше трёх картинок: части высокого кадра по отдельности читаются, а десяток разом
           занимает контекст целиком. Остальное — по ссылкам. */
        const files = result.renders
          .flatMap((render) => (render.parts ? render.parts.map((part) => part.image.path) : render.image ? [render.image.path] : []))
          .slice(0, 3);
        for (const file of files) {
          const img = await inlineImage(file, 900);
          content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
      }
      return { content };
    },
  );
}
