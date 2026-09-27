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
import { CONFIG, DIRS, FIGMA } from '../config.js';
import { capped, json, linkBlocks } from './shared.js';
import { inlineImage } from '../checks/visual.js';
import { checkFigmaApi } from '../figma/api-check.js';
import { issueTokenNow, lastTokenIssue, resolveToken } from '../figma/auth.js';
import { editorChannel, editorLogin, editorLogout, editorStatus } from '../figma/editor.js';
import { exportImages, exportRender, exportSvg } from '../figma/export.js';
import { cssItems, outlineLines, textItems, unresolvedOf, usedVariables } from '../figma/inspect.js';
import { assetInventory } from '../figma/assets.js';
import { getRestClient } from '../figma/rest.js';
import { addRequests, ensureNode, ensureNodes, findNode, frameIndex, pathOf, syncFigma } from '../figma/snapshot.js';
import { groupRefs, parseFigmaRef, refOf } from '../figma/url.js';
import { diffSnapshots, fetchVersions, parseMoment, pickVersions, snapshotAt } from '../figma/history.js';
import { loadProject, projectSummary } from '../figma/project.js';
import { browserChrome } from '../figma/analyze/common.js';
import { round } from '../figma/css.js';
import { inferStructure } from '../figma/analyze/structure.js';
import { findComponents } from '../figma/analyze/components.js';
import { collectTokens } from '../figma/analyze/tokens.js';
import { compareBreakpoints } from '../figma/analyze/breakpoints.js';
import {
  baseName,
  buildThreads,
  collectAnnotations,
  commentsDigest,
  fetchComments,
  missingFrames,
  placeThreads,
  readCachedComments,
} from '../figma/analyze/comments.js';
import { describeBehavior, uiKitTarget } from '../figma/analyze/behavior.js';
import { compareWithDesign, probePage, scrollbarGutter } from '../figma/compare.js';
import { measurePairs, measureSpacing, pageBoxes } from '../figma/spacing.js';
import { gotoAndSettle, sessionAt, withSession } from '../browser/pool.js';

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

/**
 * Кадры, в которых стоят комментарии, но которых нет среди снимков запрошенных узлов.
 *
 * Комментарий на кнопке Figma хранит как «кадр верхнего уровня + смещение», и чтобы понять, что
 * он на кнопке внутри запрошенной карточки, нужен снимок этого кадра. Сначала ищем в кэше — это
 * бесплатно. Докачиваем (одним запросом на файл) только когда по снимкам запрошенных узлов не
 * видно их предков: снимок REST их не знает, а снимок редактора знает, и тогда чужой кадр
 * заведомо не наш — тратить на него запрос незачем.
 */
const COMMENT_FRAMES_MAX = 20;

async function commentFrames(fileKey, comments, own, { client, resolved = false, requests = null, sync = false } = {}) {
  const frames = [];
  let missing = [];
  for (const id of missingFrames(comments, own, { resolved })) {
    const hit = await findNode(fileKey, id);
    if (hit) frames.push({ snapshot: hit.snapshot, rootId: id, ref: refOf(fileKey, id), context: true });
    else missing.push(id);
  }
  const blind = own.some((frame) => !frame.snapshot.ancestors?.length);
  /*
   * Копии запрошенных кадров на других страницах («Объяснение» с узлами 588:*): дизайнер пишет
   * замечания на них. Предки таких кадров запрошенному узлу не родня, и без имени кадра их
   * отбрасывали как чужие. Имя берётся из индекса кадров файла; если кадров в нём нет — индекс
   * снимается одним запросом списка кадров файла.
   */
  let copies = [];
  if (sync && missing.length) {
    let index = await frameIndex(fileKey);
    if (missing.some((id) => !index[id])) {
      const listed = await syncFigma([fileKey], { client, editor: editorChannel }).catch(() => null);
      if (listed && requests) addRequests(requests, listed.requests);
      index = await frameIndex(fileKey);
    }
    const wanted = new Set(own.map((frame) => baseName(frame.snapshot.nodes[frame.rootId]?.name)).filter(Boolean));
    copies = missing.filter((id) => index[id] && wanted.has(baseName(index[id].name)));
  }
  if (sync && (blind || copies.length) && missing.length) {
    const batch = (blind ? [...new Set([...copies, ...missing])] : copies).slice(0, COMMENT_FRAMES_MAX);
    const result = await syncFigma(
      batch.map((id) => refOf(fileKey, id)),
      { client, editor: editorChannel },
    );
    if (requests) addRequests(requests, result.requests);
    for (const id of batch) {
      const hit = await findNode(fileKey, id);
      if (hit) frames.push({ snapshot: hit.snapshot, rootId: id, ref: refOf(fileKey, id), context: true });
    }
    /* Кадр, удалённый из макета, остаётся в комментариях: это не ошибка, а просто не наш случай. */
    missing = missing.filter((id) => !frames.some((frame) => frame.rootId === id));
  }
  if (!blind) missing = [];
  return { frames, notSynced: missing.slice(0, 10) };
}

/**
 * Комментарии узла для figma_inspect и figma_spec — только из кэша: эти инструменты запросов не
 * тратят. Списка нет — так и говорим, с тем, чем его получить.
 */
async function commentsOf(fileKey, snapshot, nodeId) {
  const cached = await readCachedComments(fileKey);
  if (!cached) {
    return { unknown: true, how: 'figma_comments по этому узлу: список комментариев ещё не загружался' };
  }
  const own = [{ snapshot, rootId: nodeId, ref: refOf(fileKey, nodeId) }];
  const { frames } = await commentFrames(fileKey, cached.comments, own);
  return commentsDigest(cached.comments, [...own, ...frames], nodeId, { fetchedAt: cached.fetchedAt });
}

/**
 * Ширины для прогонов — из ширин снятых кадров.
 *
 * Макет обычно даёт две точки, а вёрстку проверяли ровно в них: «планшетного макета нет —
 * между ними clamp()», и clamp() так и не сделали. Подсказка стоит здесь, в ответе снятия, потому
 * что именно тут впервые видны все ширины задачи, — дальше её берут layout_stress и layout_audit.
 */
const STANDARD_WIDTHS = [320, 375, 768, 1024, 1280, 1440, 1920];

/**
 * Годится ли снятый узел как экран: только такой задаёт ширину вёрстки.
 *
 * Ссылки задачи ведут и на тексты, и на секции-пояснения: раньше в suggested попадали 52, 104,
 * 154 и 5273 — ширины подписей и холста «Объяснение», и прогон по ним был бессмыслен.
 */
export function screenReason(frame) {
  const w = Number(String(frame.size || '').split('x')[0]);
  if (!(w > 0)) return 'нет размера';
  if (frame.type && !['FRAME', 'COMPONENT', 'INSTANCE'].includes(frame.type)) return `не кадр: ${frame.type}`;
  if (w < 320) return 'уже 320px — элемент, а не экран';
  if (w > 2560) return 'шире 2560px — холст или секция, а не экран';
  return null;
}

/** Нарисованная строка браузера в ответе figma_spec: сколько вычитать из y узлов потока. */
export function chromeNote(chrome) {
  if (!chrome) return null;
  return {
    ...chrome,
    note: t({
      ru: `Похоже на нарисованную строку браузера: страница в браузере начинается под ней. Вычитайте ${round(chrome.height)}px из y узлов потока; fixed-узлы считаются от окна, им вычитать не нужно.`,
      en: `Looks like a drawn browser bar: in the browser the page starts below it. Subtract ${round(chrome.height)}px from the y of flow nodes; fixed nodes count from the window and need no correction.`,
    }),
  };
}

export function suggestWidths(result) {
  const all = (result.files || []).flatMap((file) => file.frames || []);
  const ignored = all
    .map((frame) => ({ frame, reason: screenReason(frame) }))
    .filter(({ reason }) => reason && reason !== 'нет размера')
    .map(({ frame, reason }) => ({ node: frame.ref, name: frame.name, width: Number(String(frame.size).split('x')[0]), reason }));
  const design = [
    ...new Set(
      all
        .filter((frame) => !screenReason(frame))
        .map((frame) => Number(String(frame.size || '').split('x')[0])),
    ),
  ].sort((a, b) => a - b);
  if (design.length < 2) return ignored.length ? { widths: { design, ignored: ignored.slice(0, 10) } } : {};
  const [min, max] = [design[0], design[design.length - 1]];
  const suggested = [...new Set([...design, ...STANDARD_WIDTHS.filter((w) => w > min && w < max)])].sort((a, b) => a - b);
  return {
    widths: {
      design,
      suggested,
      ...(ignored.length ? { ignored: ignored.slice(0, 10) } : {}),
      note: t({
        ru: 'Две макетные ширины — не адаптив: вёрстка проверяется и между ними. Передайте suggested в layout_stress (widths) и layout_audit (widths); добавьте ширину на 1px выше каждого своего брейкпоинта.',
        en: 'Two design widths are not adaptivity: the layout is checked between them too. Pass suggested to layout_stress (widths) and layout_audit (widths); add the width 1px above each of your own breakpoints.',
      }),
    },
  };
}

/*
 * Покрытие сверки по кадру — что для него уже запускали, а что нет.
 *
 * semantic запускали восемь раз, pixel — ни разу, и «готово» написали по высотам секций. Реестр
 * живёт в памяти процесса и ключуется кадром с версией: сверка старой версии макета покрытием
 * новой не считается. Ответ каждой сверки несёт, чего для этого кадра ещё не было.
 */
const coverage = new Map();

/*
 * Экраны, снятые figma_sync: файл → кадр → имя и ширина.
 *
 * Десктопный подвал сверили, мобильный — ни разу, и покрытие этого не показало: оно знало только
 * про кадры, которые уже сравнивали. Теперь каждая сверка перечисляет снятые экраны того же
 * файла, по которым сверки ещё не было.
 */
const screens = new Map();

export function rememberScreens(result) {
  for (const file of result.files || []) {
    for (const frame of file.frames || []) {
      if (!frame.ref || screenReason(frame)) continue;
      const fileKey = String(frame.ref).split(':')[0];
      const known = screens.get(fileKey) || new Map();
      known.set(frame.ref, { name: frame.name, width: Number(String(frame.size).split('x')[0]), breakpoint: frame.breakpoint });
      screens.set(fileKey, known);
    }
  }
}

const stamp = () => new Date().toISOString().slice(11, 16);

export function noteCoverage(ref, version, { mode = 'both', sections = false, width = null, frameWidth = null } = {}) {
  const key = `${ref}@${version}`;
  const entry = coverage.get(key) || { semantic: null, pixel: null, sections: null, widths: [] };
  if (mode !== 'pixel') entry.semantic = stamp();
  if (mode !== 'semantic') entry.pixel = stamp();
  if (sections) entry.sections = stamp();
  if (width && !entry.widths.includes(width)) entry.widths.push(width);
  coverage.set(key, entry);

  const missing = ['semantic', 'sections'].filter((kind) => !entry[kind]);
  const never = t({ ru: 'не запускался', en: 'not run' });
  const fileKey = String(ref).split(':')[0];
  const compared = new Set([...coverage.keys()].map((k) => k.split('@')[0]));
  const notCompared = [...(screens.get(fileKey) || new Map())]
    .filter(([screen]) => !compared.has(screen))
    .map(([screen, info]) => ({ node: screen, name: info.name, width: info.width, ...(info.breakpoint ? { breakpoint: info.breakpoint } : {}) }));
  const offWidth = width && frameWidth && Math.abs(width - frameWidth) > 2;
  return {
    semantic: entry.semantic || never,
    pixel: entry.pixel || never,
    sections: entry.sections || never,
    ...(entry.widths.length ? { widths: entry.widths } : {}),
    ...(missing.length
      ? {
          note: t({
            ru: `Для этого кадра ещё не было: ${missing.join(', ')}. Отчёт о готовности пишется после semantic и sections: true — картинка с картинкой по каждой секции; «высота секции совпала» — не критерий.`,
            en: `Not run for this frame yet: ${missing.join(', ')}. A "done" report follows semantic and sections: true — picture against picture per section; "the section height matches" is not a criterion.`,
          }),
        }
      : {}),
    ...(offWidth
      ? {
          widthWarning: t({
            ru: `Сверка шла в окне ${width}px, а кадр шириной ${frameWidth}px: такая сверка кадр не покрывает. Откройте сессию шириной кадра или передайте url — стенд откроет её сам.`,
            en: `The comparison ran in a ${width}px window while the frame is ${frameWidth}px wide: such a comparison does not cover the frame. Open a session at the frame width or pass url and the stand will open one itself.`,
          }),
        }
      : {}),
    ...(notCompared.length
      ? {
          notCompared: notCompared.slice(0, 10),
          notComparedNote: t({
            ru: `Снятые экраны этого файла, по которым сверки ещё не было: ${notCompared.length}. Отчёт о готовности пишется после сверки каждой ширины макета — мобильный кадр тоже.`,
            en: `Synced screens of this file that have not been compared yet: ${notCompared.length}. A "done" report follows a comparison at every design width — the mobile frame too.`,
          }),
        }
      : {}),
  };
}

const withProject = async (project) => (project && (project.url || project.css || project.scss) ? loadProject(project) : null);

export function register(server) {
  server.registerTool(
    'figma_status',
    {
      title: t({ ru: 'Доступ к Figma', en: 'Figma access' }),
      description: t({
        ru: 'Доступ к Figma: работает ли токен REST и сколько осталось лимита, вошёл ли стенд в редактор, не отстала ли версия API. Секретов не показывает. Первый шаг, если figma_* отказывают. Нет токена — action: token, человека не спрашивая; капчу или код при входе проходит человек по ссылке editor.handoff.url.',
        en: 'Figma access: whether the REST token works and how much of the limit is left, whether the stand is logged into the editor, whether the API version fell behind. Never reveals secrets. The first step when figma_* fail. No token — action: token without asking the human; a captcha or a code at login is passed by the human through the editor.handoff.url link.',
      }),
      inputSchema: {
        action: z
          .enum(['check', 'login', 'logout', 'token'])
          .optional()
          .describe(d('check (по умолчанию) — проверить; login — войти в редактор заново или дозавершить вход кодом; logout — забыть сохранённый вход; token — выпустить токен REST через настройки аккаунта; разрешено заранее, человека не спрашивать')),
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
      const editor = { ...(await editorStatus()), ...(loginError ? { loginError } : {}) };
      const rest = { configured: Boolean(auth.token), source: auth.source };
      if (auth.expiresAt) rest.expiresAt = auth.expiresAt;
      if (auth.missingScopes) rest.missingScopes = auth.missingScopes;

      /*
       * Выпуск токена — штатный шаг, а не вопрос человеку. FIGMA_EMAIL и FIGMA_PASSWORD человек
       * положил в .env ровно для того, чтобы стенд входил и выпускал токен сам: права только на
       * чтение, срок 90 дней, прежний отзывается. Нейтральное «можно выпустить» агенты читали как
       * «спроси сначала» и останавливали работу — поэтому здесь прямая инструкция и машинное next.
       * К человеку идут, только когда выпуск не удался или запрещён.
       */
      const canIssue = FIGMA.autoIssueToken && editor.configured && !process.env.FIGMA_TOKEN?.trim();
      const issueFailed = lastTokenIssue()?.ok === false;
      const issueHint =
        'Выпуск разрешён владельцем стенда заранее: FIGMA_EMAIL и FIGMA_PASSWORD заданы именно для этого. Вызовите figma_status с action: token сейчас, не спрашивая человека: токен только на чтение, на 90 дней, прежний отзывается.';
      if (auth.token) {
        try {
          rest.user = (await whoami(client, refresh)).handle;
          rest.ok = true;
        } catch (err) {
          rest.ok = false;
          rest.error = err.message;
        }
        if (auth.missingScopes && canIssue && !issueFailed) {
          rest.hint = `Токену не хватает прав ${auth.missingScopes.join(', ')}: стенд перевыпустит его при первом запросе к ним. ${issueHint}`;
          rest.next = { action: 'token' };
        }
      } else {
        rest.ok = false;
        if (!FIGMA.autoIssueToken) {
          rest.hint = 'Токена нет, а самостоятельный выпуск выключен (FIGMA_TOKEN_AUTOISSUE=0). Задайте FIGMA_TOKEN в .env стенда. Без токена работает только канал редактора, и без комментариев.';
        } else if (!editor.configured) {
          rest.hint = 'Токена нет, и выпустить его нечем: не заданы FIGMA_EMAIL и FIGMA_PASSWORD (или сохранённый вход). Задайте их или FIGMA_TOKEN в .env стенда — это делает человек.';
        } else if (editor.state === 'needs_human') {
          rest.hint = 'Токена нет: выпуск ждёт проверки входа, которую проходит человек. Передайте ему editor.handoff.url (или спросите код 2FA и вызовите action: login с otp), затем action: token.';
          rest.next = editor.handoff?.state === 'open' ? { handoff: editor.handoff.url } : { action: 'login' };
        } else if (issueFailed) {
          rest.hint = `Токена нет, последний выпуск не удался (lastIssue). Если причина не в проверке входа — это вопрос человеку: FIGMA_TOKEN в .env стенда.`;
        } else {
          rest.hint = `Токена нет. ${issueHint}`;
          rest.next = { action: 'token' };
        }
      }
      rest.autoIssue = FIGMA.autoIssueToken;
      if (lastTokenIssue()) rest.lastIssue = lastTokenIssue();
      if (tokenError) rest.tokenError = tokenError;
      rest.budget = await client.budget();

      return json({
        rest,
        editor,
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
        page: z.string().optional().describe(d('Ссылка без node-id: кадры одной страницы по имени или id')),
        offset: z.number().optional().describe(d('С page: с какого кадра продолжить')),
      },
    },
    async ({ figma, refresh = false, channel = 'auto', css = false, page, offset = 0 }) => {
      const client = getRestClient();
      const result = await syncFigma(figma, { refresh, client, editor: editorChannel, channel, css, page, offset });
      rememberScreens(result);
      /*
       * Указатель на регламент стоит именно здесь, а не в каждом figma_*.
       *
       * Снятие макета — единственный вызов, который в работе по макету случается заведомо и
       * заведомо в начале: все кадры задачи снимаются одним вызовом, это и есть точка старта.
       * Рамка подключения про регламент уже сказала, но между подключением и этим вызовом
       * помещается весь разбор задачи, и напоминание в момент старта дешевле пропущенной фазы.
       */
      return json({
        ...result,
        ...suggestWidths(result),
        budget: (await client.budget()).tiers,
        guide: t({
          ru: 'Порядок работы по макету — help(guide: "index"), дальше по одной фазе; каждая называет следующую. Разведка кадров — фаза 1, help(guide: "frames").',
          en: 'The order of work on a design is help(guide: "index"), then one phase at a time; each names the next. Reading the frames is phase 1, help(guide: "frames").',
        }),
      });
    },
  );

  server.registerTool(
    'figma_inspect',
    {
      title: t({ ru: 'Узел макета', en: 'Design node' }),
      description: t({
        ru: 'Узел макета по снимку: outline — дерево слоёв с размерами, раскладкой, краской (цвет, обводка и её толщина, радиус, эффекты) и текстами, одинаковые соседи свёрнуты; css — компактные стили узлов; text — тексты поддерева целиком. Замена get_metadata и get_design_context без лимита вызовов.',
        en: 'A design node from the snapshot: outline — the layer tree with sizes, layout, paint (color, stroke and its weight, radius, effects) and texts, identical siblings collapsed; css — compact node styles; text — full texts of the subtree. Replaces get_metadata and get_design_context without a call limit.',
      }),
      inputSchema: {
        figma: z.string().describe(d('Узел: ссылка figma.com или запись ключ:id')),
        mode: z
          .enum(['outline', 'css', 'text'])
          .optional()
          .describe(d('outline (по умолчанию) — дерево слоёв с раскладкой, краской и текстами; css — стили узлов; text — тексты целиком')),
        depth: z.number().optional().describe(d('Глубина обхода. По умолчанию 6 для outline и 2 для css')),
        hidden: z.boolean().optional().describe(d('Показывать скрытые слои')),
        limit: z.number().optional().describe(d('По умолчанию 200 строк outline, 60 узлов css или 100 текстов')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, mode = 'outline', depth, hidden = false, limit, offset = 0 }) => {
      const { snapshot, node, fileKey, requests } = await ensureNode(figma, { client: getRestClient(), editor: editorChannel });
      const head = {
        ref: refOf(fileKey, node.id),
        ...pathOf(snapshot, node.id),
        version: snapshot.version,
        channel: snapshot.channel,
        mode,
        ...(requests ? { requests } : {}),
        comments: await commentsOf(fileKey, snapshot, node.id),
      };
      /* Обрезанный абзац выглядит законченным: сколько текстов ушло с многоточием, говорим прямо. */
      const clippedNote = (stats) =>
        stats.clippedTexts
          ? { textsClipped: `${stats.clippedTexts} текстов обрезаны многоточием — полностью их отдаёт mode: text` }
          : {};
      if (mode === 'text') {
        return json({ ...head, ...capped(textItems(snapshot, node.id, { hidden }), { limit: limit ?? 100, offset }) });
      }
      if (mode === 'css') {
        const stats = {};
        const page = capped(cssItems(snapshot, node.id, { depth: depth ?? 2, hidden, stats }), { limit: limit ?? 60, offset });
        const variables = usedVariables(snapshot, page.items.map((item) => item.id));
        return json({ ...head, ...(variables ? { variables } : {}), ...page, ...clippedNote(stats) });
      }
      const stats = {};
      const lines = outlineLines(snapshot, node.id, { depth: depth ?? 6, hidden, stats });
      return json({ ...head, ...capped(lines, { limit: limit ?? 200, offset }), ...clippedNote(stats) });
    },
  );

  /*
   * Спецификация блока одним вызовом.
   *
   * Разбор блока стоил четырёх: figma_structure, figma_inspect outline, figma_inspect text и
   * иногда figma_export. Четыре вызова на блок — это соблазн обойтись двумя, и обходились: чаще
   * всего пропускали тексты (и верстали по обрезанным многоточием строкам) и краску узла (и
   * теряли обводку, которая живёт на узле, а не в скачанном файле).
   *
   * Словарь разделов взят у figma_inspect, а не выдуман заново: outline, css, text — те же
   * названия и то же поведение, плюс assets. Второй словарь пришлось бы учить отдельно.
   *
   * figma_structure сюда намеренно не входит. Он отдаёт другое дерево — с выведенными тегами,
   * классами и переподчинёнными слоями, — и вклеивать его сюда значило бы удвоить ответ, не
   * заменив при этом сам инструмент: план разметки нужен и отдельно.
   */
  server.registerTool(
    'figma_spec',
    {
      title: t({ ru: 'Спецификация блока', en: 'Block specification' }),
      description: t({
        ru: 'Всё про узел одним вызовом: дерево слоёв с раскладкой и краской, стили, полные тексты и список ассетов с тем, что каждому нужно — svg, картинка или рендер. Заменяет связку figma_inspect в трёх режимах и снимает вопрос «что отсюда скачивать». Запросов в Figma не тратит: считает по снимку.',
        en: 'Everything about a node in one call: the layer tree with layout and paint, styles, full texts, and the asset list with what each one needs — svg, image or render. Replaces the figma_inspect trio and settles the question of what to export from here. Spends no Figma requests: it reads the snapshot.',
      }),
      inputSchema: {
        figma: z.string().describe(d('Узел: ссылка figma.com или запись ключ:id')),
        sections: z
          .array(z.enum(['outline', 'css', 'text', 'assets']))
          .optional()
          .describe(d('Что вернуть. По умолчанию все четыре')),
        depth: z.number().optional().describe(d('Глубина дерева outline. По умолчанию 6; стили всегда на два уровня')),
        hidden: z.boolean().optional().describe(d('Показывать скрытые слои')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
      },
    },
    async ({ figma, sections, depth, hidden = false, limit }) => {
      const { snapshot, node, fileKey, requests } = await ensureNode(figma, { client: getRestClient(), editor: editorChannel });
      const want = new Set(sections?.length ? sections : ['outline', 'css', 'text', 'assets']);
      const stats = {};

      const out = {
        ref: refOf(fileKey, node.id),
        ...pathOf(snapshot, node.id),
        version: snapshot.version,
        channel: snapshot.channel,
        ...(requests ? { requests } : {}),
        comments: await commentsOf(fileKey, snapshot, node.id),
      };
      const chrome = chromeNote(browserChrome(snapshot, node.id));
      if (chrome) out.chrome = chrome;

      /*
       * Разделы собираются по очереди и складываются, пока ответ помещается в потолок.
       *
       * Порядок не алфавитный, а по убыванию пользы: без дерева говорить не о чем, ассеты
       * определяют, что скачивать, тексты нужны для контента, а стили чаще всего и так смотрят
       * точечно. Вылетевший раздел заменяется признаком skipped с тем, чем его дочитать: молча
       * урезанный JSON хуже отсутствующего — по нему не видно, что чего-то нет.
       */
      const budget = CONFIG.maxTextBytes * 0.8;
      const skipped = {};
      const build = {
        outline: () => capped(outlineLines(snapshot, node.id, { depth: depth ?? 6, hidden, stats }), { limit: limit ?? 200 }),
        assets: () => assetInventory(snapshot, node.id, { limit: limit ?? 60 }),
        text: () => capped(textItems(snapshot, node.id, { hidden }), { limit: limit ?? 100 }),
        css: () => {
          const page = capped(cssItems(snapshot, node.id, { depth: 2, hidden, stats }), { limit: limit ?? 40 });
          const variables = usedVariables(snapshot, page.items.map((item) => item.id));
          return { ...(variables ? { variables } : {}), ...page };
        },
      };
      const how = {
        outline: 'figma_inspect с mode: outline',
        assets: 'figma_spec с sections: ["assets"]',
        text: 'figma_inspect с mode: text',
        css: 'figma_inspect с mode: css',
      };

      for (const name of ['outline', 'assets', 'text', 'css']) {
        if (!want.has(name)) continue;
        /* Сломавшийся раздел не роняет остальные: агенту нужен хотя бы outline, и видно, где сломалось. */
        let section;
        try {
          section = build[name]();
        } catch (error) {
          skipped[name] = { skipped: true, error: error.message, node: refOf(fileKey, node.id), how: how[name] };
          continue;
        }
        if (JSON.stringify(out).length + JSON.stringify(section).length > budget) {
          skipped[name] = { skipped: true, why: 'ответ уперся в потолок объёма', how: how[name] };
          continue;
        }
        out[name] = section;
      }

      /*
       * Чего в этом ответе не хватает, чтобы считать блок разобранным.
       *
       * Раньше свёрнутые по depth узлы и иконки без цвета терялись молча, а «блок разобран»
       * решалось на глаз. Пустой unresolved — критерий закрытия фазы, непустой — список работы.
       */
      const unresolved = unresolvedOf(snapshot, node.id, { stats, assets: out.assets ?? (want.has('assets') ? null : assetInventory(snapshot, node.id)), hidden });
      return json({
        ...out,
        ...(Object.keys(skipped).length ? { skipped } : {}),
        ...(stats.clippedTexts
          ? { textsClipped: `${stats.clippedTexts} текстов обрезаны многоточием в outline и css — целиком они в разделе text` }
          : {}),
        ...(Object.keys(unresolved).length
          ? {
              unresolved: {
                ...unresolved,
                note: t({
                  ru: 'Блок не разобран до конца — фаза block не закрыта. collapsedByDepth: повторите с большим depth или figma_inspect по свёрнутым узлам; svgWithoutColor: цвет иконки возьмите из figma_inspect по узлу; interactionsNotSynced: figma_sync по этим id и разобрать; hiddenSkipped: скрытые слои, при необходимости hidden: true. См. help(guide: "block", brief: true).',
                  en: 'The block is not fully taken apart — phase block is not closed. collapsedByDepth: repeat with a larger depth or figma_inspect on the collapsed nodes; svgWithoutColor: take the icon color from figma_inspect on the node; interactionsNotSynced: figma_sync these ids and take them apart; hiddenSkipped: hidden layers, hidden: true if needed. See help(guide: "block", brief: true).',
                }),
              },
            }
          : {}),
        note: 'План разметки — теги, классы, переподчинённые слои — это отдельный разбор: figma_structure.',
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
        ...pathOf(snapshot, node.id),
        version: snapshot.version,
        channel: snapshot.channel,
        ...(requests ? { requests } : {}),
        body: result.body,
        headings: result.headings,
        ...capped(result.lines, { limit: limit ?? 150, offset }),
        ...(result.clippedTexts
          ? { textsClipped: `${result.clippedTexts} текстов обрезаны многоточием — полностью их отдаёт figma_inspect с mode: text` }
          : {}),
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
    'figma_spacing',
    {
      title: t({ ru: 'Интервалы между элементами', en: 'Spacing between elements' }),
      description: t({
        ru: 'Интервалы между соседями: в макете, на странице и какое свойство их задаёт (gap, padding). Для растущего сдвига и stepDrift из figma_compare; узлы без текста — через pairs.',
        en: 'Intervals between neighbours: in the design, on the page and which property sets them (gap, padding). For a growing shift and stepDrift from figma_compare; nodes without text — via pairs.',
      }),
      inputSchema: {
        figma: z.string().describe(d('Узел-контейнер: ссылка figma.com или запись ключ:id')),
        sessionId: z.string().optional().describe(d('Сессия с открытой страницей: сравнение идёт по ней')),
        url: z.string().optional().describe(d('Адрес страницы: без sessionId стенд откроет её сам шириной кадра, с sessionId перейдёт на неё в сессии')),
        selector: z.string().optional().describe(d('Блок на странице, которому соответствует кадр макета')),
        pairs: z
          .array(z.object({ node: z.string(), selector: z.string() }))
          .optional()
          .describe(d('Пары узел ↔ селектор: расстояния между соседями списка')),
        tolerance: z.number().optional().describe(d('Допуск смещения в пикселях. По умолчанию 2')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
      },
    },
    async ({ figma, sessionId, url, selector, pairs, tolerance = 2, limit = 40 }) => {
      const client = getRestClient();
      const { snapshot, node, fileKey } = await ensureNode(figma, { client, editor: editorChannel });
      const run = async (page) => {
        const probed = await page.evaluate(probePage, selector ?? null);
        if (probed.error) throw new Error(probed.error);
        const spacing = measureSpacing(snapshot, node.id, probed, { tolerance });
        const out = {
          node: refOf(fileKey, node.id),
          measured: spacing.rows.length,
          off: spacing.off.length,
          ...(spacing.steps.length ? { steps: spacing.steps } : {}),
          rows: spacing.off.slice(0, limit),
          ...(spacing.off.length > limit ? { note: `Показано ${limit} из ${spacing.off.length} расхождений.` } : {}),
          ...(spacing.rows.some((row) => row.unmeasured)
            ? { unmeasured: spacing.rows.filter((row) => row.unmeasured).slice(0, 10).map(({ between, nodes }) => ({ between, nodes })) }
            : {}),
        };
        if (pairs?.length) {
          const found = await page.evaluate(pageBoxes, { root: selector ?? null, selectors: pairs.map((pair) => pair.selector) });
          out.pairs = measurePairs(snapshot, node.id, pairs.map((pair, i) => ({ ...pair, page: found[i] })));
        }
        return out;
      };
      if (sessionId) {
        const { session, navigation } = await sessionAt(sessionId, url);
        return json({ ...(await run(session.page)), ...(navigation ? { navigation } : {}) });
      }
      if (!url) throw new Error('Нужен sessionId открытой сессии или url страницы.');
      const width = Math.max(320, Math.round(node.box?.w || 1440));
      return withSession({ viewport: `${width}x900` }, async (session) => {
        await gotoAndSettle(session, url);
        return json(await run(session.page));
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
        url: z.string().optional().describe(d('Адрес страницы: без sessionId стенд откроет её сам шириной кадра, с sessionId перейдёт на неё в сессии')),
        selector: z.string().optional().describe(d('Блок на странице, которому соответствует кадр макета')),
        mode: z
          .enum(['both', 'semantic', 'pixel'])
          .optional()
          .describe(d('both (по умолчанию) — и смысловое, и попиксельное; semantic — только смысловое; pixel — только попиксельное')),
        sections: z.boolean().optional().describe(d('Попиксельно по каждой секции кадра с поправкой на сдвиг её текстов')),
        tolerance: z.number().optional().describe(d('Допуск смещения в пикселях. По умолчанию 2')),
        threshold: z.number().optional().describe(d('Допустимое расхождение в процентах пикселей')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
      },
    },
    async ({ figma, sessionId, url, selector, mode = 'both', sections = false, tolerance, threshold, limit }) => {
      const client = getRestClient();
      const { snapshot, node, fileKey } = await ensureNode(figma, { client, editor: editorChannel });
      const ref = refOf(fileKey, node.id);
      const options = {
        figmaRef: ref,
        snapshot,
        rootId: node.id,
        selector,
        mode,
        sections,
        client,
        editor: editorChannel,
        ...(tolerance ? { tolerance } : {}),
        ...(threshold ? { threshold } : {}),
        ...(limit ? { limit } : {}),
      };
      /* Предупреждать о ширине окна имеет смысл только для экрана: карточку сверяют в любом окне. */
      const frameWidth = screenReason({ type: node.type, size: `${node.box?.w}x${node.box?.h}` }) ? null : Math.round(node.box.w);
      /* Окно, расширенное на гуттер полосы прокрутки, по контенту той же ширины, что кадр. */
      const withCoverage = (result, page, widened = 0) => ({
        ...result,
        coverage: noteCoverage(ref, snapshot.version, { mode, sections, width: page.viewportSize() ? page.viewportSize().width - widened : null, frameWidth }),
      });

      if (sessionId) {
        const { session, navigation } = await sessionAt(sessionId, url);
        const { page } = session;
        return json({ ...withCoverage(await compareWithDesign({ ...options, page }), page), ...(navigation ? { navigation } : {}) });
      }
      if (!url) throw new Error('Нужен sessionId открытой сессии или url страницы.');

      /* Своя сессия открывается шириной кадра: сравнивать десктопный макет с мобильной вёрсткой
         бессмысленно, а ширину по умолчанию агент задать забывает. */
      const width = Math.max(320, Math.round(node.box?.w || 1440));
      return withSession({ viewport: `${width}x900` }, async (session) => {
        const navigation = await gotoAndSettle(session, url);
        /* Полоса прокрутки страницы отнимает ширину: окно расширяется на неё, чтобы контент был шириной кадра. */
        const gutter = await session.page.evaluate(scrollbarGutter).catch(() => 0);
        if (gutter > 0) {
          await session.page.setViewportSize({ width: width + gutter, height: 900 });
          await session.page.waitForTimeout(150);
        }
        const result = await compareWithDesign({ ...options, page: session.page, widenedBy: gutter });
        return json({ ...withCoverage(result, session.page, gutter), navigation });
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
        scope: z
          .enum(['subtree', 'file'])
          .optional()
          .describe(d('subtree (по умолчанию) — комментарии на узле и на его потомках, со ссылкой на элемент; file — все комментарии файла')),
        resolved: z.boolean().optional().describe(d('Показывать и закрытые треды. По умолчанию только открытые')),
        refresh: z.boolean().optional().describe(d('Спросить Figma заново, а не взять список из кэша на 5 минут')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, scope = 'subtree', resolved = false, refresh = false, limit, offset = 0 }) => {
      const client = getRestClient();
      const requests = { tier1: 0, tier2: 0, tier3: 0 };
      const frames = [];
      const threads = [];
      const notes = [];

      for (const group of groupRefs(figma)) {
        const own = [];
        if (group.nodeIds.length) {
          const { found, requests: spent } = await ensureNodes(group.fileKey, group.nodeIds, { client, editor: editorChannel });
          addRequests(requests, spent);
          for (const id of group.nodeIds) {
            const { snapshot } = found.get(id);
            own.push({ snapshot, rootId: id, ref: refOf(group.fileKey, id) });
          }
        }
        frames.push(...own);
        const data = await fetchComments(group.fileKey, { client, refresh });
        if (!data.fromCache) requests.tier2 += 1;

        const targets = scope === 'subtree' && group.nodeIds.length ? group.nodeIds : null;
        const context = await commentFrames(group.fileKey, data.comments, own, { client, resolved, requests, sync: Boolean(targets) });
        if (context.notSynced.length) {
          notes.push(`Кадры ${context.notSynced.join(', ')} не сняты: комментарии в них не привязаны к элементам. figma_sync по ним.`);
        }
        threads.push(...placeThreads(buildThreads(data.comments, [...own, ...context.frames], { resolved, targets }), await frameIndex(group.fileKey)));
      }

      return json({
        frames: frames.map((frame) => frame.ref),
        scope,
        ...(requests.tier1 || requests.tier2 || requests.tier3 ? { requests } : {}),
        ...capped(threads, { limit: limit ?? 30, offset }),
        annotations: collectAnnotations(frames).slice(0, 30),
        ...(notes.length ? { warnings: notes } : {}),
      });
    },
  );

  server.registerTool(
    'figma_history',
    {
      title: t({ ru: 'История макета', en: 'Design history' }),
      description: t({
        ru: 'Что менялось в макете за период: версии файла (автосохранения и именованные — кто и когда), комментарии за период и, с diff, разница узла между началом и концом периода — добавлено, удалено, тексты, размеры, краска, раскладка. Шаг истории — версия, а не отдельное действие: Figma отдельных действий наружу не отдаёт. Только канал REST.',
        en: 'What changed in the design over a period: file versions (autosaves and named ones — who and when), comments over the period and, with diff, the node difference between the start and the end of the period — added, removed, texts, sizes, paint, layout. The history step is a version, not an individual action: Figma does not expose individual actions. REST channel only.',
      }),
      inputSchema: {
        figma: z.string().describe(d('Файл или узел: ссылка figma.com или запись ключ:id')),
        since: z.string().optional().describe(d('Начало периода: 2026-09-20 или 2026-09-20T15:30:00Z. По умолчанию семь дней назад')),
        until: z.string().optional().describe(d('Конец периода в том же виде. По умолчанию сейчас')),
        diff: z
          .boolean()
          .optional()
          .describe(d('Сравнить узел на начало и конец периода. Нужен узел; стоит два запроса tier 1, у места View/Collab — из двадцати в месяц')),
        refresh: z.boolean().optional().describe(d('Спросить Figma заново, а не взять список из кэша на 5 минут')),
        limit: z.number().optional().describe(d('Сколько строк или записей показать')),
        offset: z.number().optional().describe(d('С какой записи продолжить: значение из подсказки note')),
      },
    },
    async ({ figma, since, until, diff = false, refresh = false, limit, offset = 0 }) => {
      const { fileKey, nodeId } = parseFigmaRef(figma);
      if (diff && !nodeId) throw new Error('diff сравнивает узел: нужна ссылка с node-id или запись ключ:id.');
      const client = getRestClient();
      const requests = { tier1: 0, tier2: 0, tier3: 0 };
      const to = parseMoment(until, { end: true });
      const from = parseMoment(since) ?? (to ?? Date.now()) - 7 * 24 * 60 * 60 * 1000;
      if (to !== null && to < from) throw new Error('until раньше since.');
      const period = { since: new Date(from).toISOString(), until: to === null ? null : new Date(to).toISOString() };

      const history = await fetchVersions(fileKey, { since: from, client, refresh });
      requests.tier2 += history.requests;
      const versions = history.versions.filter((v) => Date.parse(v.at) >= from && (to === null || Date.parse(v.at) <= to));

      /* Комментарии — те же, что у figma_comments, но за период и вместе с закрытыми: закрытие
         треда тоже событие. С узлом — только его поддерево. */
      const data = await fetchComments(fileKey, { client, refresh });
      if (!data.fromCache) requests.tier2 += 1;
      const own = [];
      let nodeMissing = null;
      if (nodeId) {
        /* Узла может уже не быть в макете — история как раз и нужна, чтобы узнать, куда он делся. */
        try {
          const { found, requests: spent } = await ensureNodes(fileKey, [nodeId], { client, editor: editorChannel });
          addRequests(requests, spent);
          own.push({ snapshot: found.get(nodeId).snapshot, rootId: nodeId, ref: refOf(fileKey, nodeId) });
        } catch (err) {
          nodeMissing = err.message;
        }
      }
      const context = await commentFrames(fileKey, data.comments, own, { client, resolved: true, requests, sync: Boolean(nodeId) });
      const comments = buildThreads(data.comments, [...own, ...context.frames], {
        resolved: true,
        targets: nodeId ? [nodeId] : null,
        since: from,
        until: to,
      });

      const out = {
        file: fileKey,
        ...(nodeId ? { node: refOf(fileKey, nodeId) } : {}),
        period,
        ...(nodeMissing ? { nodeMissing: `${nodeMissing} Комментарии узла без его снимка не отобрать; diff покажет, когда он пропал.` } : {}),
        versions: capped(versions, { limit: limit ?? 30, offset }),
        comments: capped(comments, { limit: limit ?? 30, offset }),
        ...(history.truncated
          ? { versionsTruncated: 'Версий больше, чем прочитано за один вызов: начало периода не достигнуто. Сузьте период.' }
          : {}),
      };

      if (diff) {
        const pick = pickVersions(history.versions, { since: from, until: to });
        if (!pick.base) {
          out.diff = { error: 'У файла нет ни одной версии в истории — сравнивать не с чем.' };
        } else if (!pick.head) {
          out.diff = { error: 'До конца периода у файла не было ни одной версии.' };
        } else {
          const before = await snapshotAt(fileKey, nodeId, pick.base.id, { client });
          const after = await snapshotAt(fileKey, nodeId, pick.head.id, { client });
          requests.tier1 += before.requests + after.requests;
          const head = pick.head.current ? { current: true } : { id: pick.head.id, at: pick.head.at, by: pick.head.by };
          const base = { id: pick.base.id, at: pick.base.at, by: pick.base.by };
          if (!before.snapshot || !after.snapshot) {
            out.diff = {
              base,
              head,
              error: !before.snapshot ? 'На начало периода этого узла в файле не было: он добавлен позже.' : 'На конец периода узла в файле нет: он удалён.',
            };
          } else {
            const changes = diffSnapshots(before.snapshot, after.snapshot, nodeId, { fileKey });
            out.diff = {
              base,
              head,
              ...(pick.baseIsOldest ? { baseNote: 'Версии на начало периода нет: сравнение идёт с самой ранней известной.' } : {}),
              added: changes.added.slice(0, 40),
              removed: changes.removed.slice(0, 40),
              changed: capped(changes.changed, { limit: limit ?? 60, offset: 0 }),
            };
          }
        }
      }

      return json({
        ...out,
        ...(requests.tier1 || requests.tier2 || requests.tier3 ? { requests } : {}),
        note: t({
          ru: 'Шаг истории — версия файла: правки между двумя автосохранениями видны одной разницей, а не по действиям.',
          en: 'The history step is a file version: edits between two autosaves show up as one difference, not action by action.',
        }),
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
            const page = hit.snapshot.ancestors?.find((item) => item.type === 'PAGE')?.name;
            if (page) group.toPage = page;
            Object.assign(group, uiKitTarget(hit.node, hit.snapshot, group.fromSet) || {});
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
        ru: 'Файлы из макета в артефакты с постоянными ссылками: render — PNG узла, высокие кадры режутся на читаемые части, страница Figma — плиткой; svg — иконки с currentColor или контур заливки; image — растровые заливки, кадрированные как в макете.',
        en: 'Files from the design into artifacts with permanent links: render — a PNG of a node, tall frames cut into readable parts, a Figma page as tiles; svg — icons with currentColor or a fill outline; image — raster fills cropped as in the design.',
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
        parts: z
          .enum(['auto', 'children', 'tiles'])
          .optional()
          .describe(d('Для render: children — по секциям, tiles — каждый потомок отдельно и контакт-лист')),
        geometry: z
          .enum(['render', 'fill'])
          .optional()
          .describe(d('Для svg: fill — контур заливки без обводки')),
      },
    },
    async ({ figma, kind = 'render', scale, clip, inline = false, parts = 'auto', geometry = 'render' }) => {
      const options = { client: getRestClient(), editor: editorChannel };
      if (kind === 'svg') return json(await exportSvg(figma, { ...options, geometry }));
      if (kind === 'image') return json(await exportImages(figma, { ...options, scales: scale ? [scale] : [1, 2] }));

      if (clip && figma.length !== 1) throw new Error('clip относится к одному узлу: передайте ровно одну ссылку.');
      const result = await exportRender(figma, { ...options, scale, clip, parts });
      const content = [{ type: 'text', text: JSON.stringify(result) }, ...linkBlocks(result)];
      if (inline) {
        /* Не больше трёх картинок: части высокого кадра по отдельности читаются, а десяток разом
           занимает контекст целиком. Остальное — по ссылкам. */
        const files = result.renders
          .flatMap((render) =>
            render.sheet ? [render.sheet.path] : render.parts ? render.parts.map((part) => part.image.path) : render.image ? [render.image.path] : [],
          )
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
