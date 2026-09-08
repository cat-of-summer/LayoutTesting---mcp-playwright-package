/**
 * Инструменты: результаты прогонов, чтение файлов стенда и его состояние.
 *
 * Вынесено из server.js механическим переносом — тела регистраций не менялись. Причина
 * простая: сорок с лишним инструментов в одном файле перестают читаться, а группы совпадают
 * с тем, как их ищет человек.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { CONFIG, DIRS, BROWSERS, VIEWPORTS } from '../config.js';
import { listRuns, pruneRuns } from '../artifacts.js';
import { listSessions } from '../browser/pool.js';
import { listProfiles } from '../browser/profiles.js';
import { readLocalFile } from '../checks/static.js';
import { ALL_CHECKS } from '../audit.js';
import { IMAGE_MIME, capped, cappedText, json, linkBlocks, pkg, text } from './shared.js';
import { inlineImage } from '../checks/visual.js';
import { resolveInArtifacts, resolveInRoot } from '../paths.js';
import { upgradeSteps } from '../update.js';
import { langInfo, t } from '../i18n.js';

export function register(server, ctx = {}) {
  /* Сведения об обновлении считает createServer один раз при старте: спрашивать GitHub
     на каждый вызов stand_info незачем. */
  const { update, toolSet = 'all', toolSets = [] } = ctx;

  server.registerTool(
    'artifacts_list',
    {
      title: t({ ru: 'Артефакты прогонов', en: "Run artifacts" }),
      description: t({
        ru: 'Прогоны на стенде от свежих к старым, со ссылками на их каталоги. Отсюда берут адрес прошлого прогона, чтобы сравнить с текущим или показать человеку. Старые прогоны чистятся автоматически.',
        en: "Runs stored on the stand, newest first, with links to their directories. This is where you take the address of a previous run to compare against the current one or to show a human. Old runs are pruned automatically.",
      }),
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
      title: t({ ru: 'Очистить артефакты', en: "Clean up artifacts" }),
      description: t({
        ru: 'Удаляет старые прогоны, оставляя последние keep штук. Обычно не нужен: очистка идёт сама при заведении нового прогона. Имеет смысл, когда место кончилось прямо сейчас. Зеркала сохранённых сайтов не трогает.',
        en: "Removes old runs, keeping the last keep ones. Usually unnecessary: pruning happens on its own whenever a new run is created. Worth calling when disk space ran out right now. Saved site mirrors are left untouched.",
      }),
      inputSchema: { keep: z.number().optional() },
    },
    async ({ keep }) => json({ removed: await pruneRuns(keep) }),
  );

  server.registerTool(
    'read_artifact',
    {
      title: t({ ru: 'Прочитать артефакт', en: "Read an artifact" }),
      description: t({
        ru: 'Читает файл из каталога артефактов. Текст и JSON отдаются как есть, картинки и прочие бинарники — в base64: иначе снимок, который стенд сам же и сделал, забрать через MCP нечем.',
        en: "Reads a file from the artifacts directory. Text and JSON come back as they are; images and other binaries come back as base64 — otherwise a screenshot the stand itself produced could not be retrieved over MCP.",
      }),
      inputSchema: {
        file: z.string().describe(d('Путь относительно каталога артефактов')),
        encoding: z
          .enum(['auto', 'utf8', 'base64'])
          .optional()
          .describe(d('auto (по умолчанию) определяет по расширению')),
        offset: z.number().optional().describe(d('С какого символа читать текст, если файл не поместился целиком')),
      },
    },
    async ({ file, encoding = 'auto', offset = 0 }) => {
      const abs = resolveInArtifacts(file);

      const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
      const binary = encoding === 'base64' || (encoding === 'auto' && Boolean(mime));
      if (!binary) {
        const part = cappedText(await readFile(abs, 'utf8'), { max: CONFIG.maxTextBytes, offset });
        return part.truncated || offset ? json({ file, ...part }) : text(part.text);
      }

      const buf = await readFile(abs);
      const payload = { file, bytes: buf.length, mimeType: mime || 'application/octet-stream', encoding: 'base64' };

      /*
       * Полностраничный снимок на 10 МБ превращается в 13 МБ base64 — один такой ответ стоит
       * дороже всего разговора до него. Уменьшенная копия отвечает на тот самый вопрос, ради
       * которого картинку и запрашивают, а оригинал никуда не делся: он лежит по url артефакта.
       */
      if (mime && buf.length > CONFIG.maxInlineBytes) {
        const small = await inlineImage(abs, 900);
        /* Уменьшенная копия — не гарантия: у плотного кадра она может остаться выше потолка.
           Тогда честнее не вклеивать ничего и отправить за оригиналом, чем «соблюсти» потолок
           на словах. */
        if (small.bytes > CONFIG.maxInlineBytes) {
          return json({
            ...payload,
            inlined: false,
            note: `Оригинал ${buf.length} байт, уменьшенная копия ${small.bytes} — обе выше потолка ${CONFIG.maxInlineBytes}. Откройте файл по url артефакта.`,
          });
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...payload,
                downscaled: true,
                inlineBytes: small.bytes,
                note: `Оригинал ${buf.length} байт, потолок ${CONFIG.maxInlineBytes}. Показана копия шириной 900px; оригинал целиком — по url артефакта.`,
              }),
            },
            { type: 'image', data: small.data, mimeType: small.mimeType },
          ],
        };
      }

      /* Ссылки собираем тем же правилом, что и json(): этот ответ строится вручную ради
         image-блока, но адресуемость артефакта от этого не меняется. */
      const content = [{ type: 'text', text: JSON.stringify(payload) }, ...linkBlocks(payload)];
      // Картинку кладём и как image-контент: агенту чаще нужно на неё посмотреть,
      // а не разбирать base64 руками.
      if (mime) content.push({ type: 'image', data: buf.toString('base64'), mimeType: mime });
      else if (buf.length > CONFIG.maxInlineBytes) {
        content.push({
          type: 'text',
          text: JSON.stringify({
            truncated: true,
            note: `Файл ${buf.length} байт, потолок ${CONFIG.maxInlineBytes} — base64 не вклеивается. Заберите его по url артефакта.`,
          }),
        });
      } else content.push({ type: 'text', text: buf.toString('base64') });
      return { content };
    },
  );

  server.registerTool(
    'read_project_file',
    {
      title: t({ ru: 'Прочитать файл стенда', en: "Read a stand file" }),
      description: t({
        ru: 'Читает файл из рабочего каталога стенда — фикстуру, конфиг матрицы, CSS. Если указан каталог, возвращает его содержимое.',
        en: "Reads a file from the stand working directory — a fixture, a matrix config, a CSS file. If a directory is given, returns its listing.",
      }),
      inputSchema: {
        file: z.string(),
        offset: z.number().optional().describe(d('С какого символа читать, если файл не поместился целиком')),
      },
    },
    async ({ file, offset = 0 }) => {
      const abs = resolveInRoot(file);

      // Каталог вместо файла — обычная опечатка в пути. Сырой EISDIR ничего
      // не подсказывает, а листинг сразу показывает, что здесь лежит.
      const info = await stat(abs).catch(() => null);
      if (!info) {
        throw new Error(`Нет такого файла: ${file}. Корень стенда — ${DIRS.root}.`);
      }
      if (info.isDirectory()) {
        const entries = await readdir(abs, { withFileTypes: true });
        const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        const page = capped(names, { limit: 500 });
        return json({ directory: file || '.', entries: page.items, ...(page.truncated ? page : {}) });
      }
      const part = cappedText(await readLocalFile(file), { max: CONFIG.maxTextBytes, offset });
      return part.truncated || offset ? json({ file, ...part }) : text(part.text);
    },
  );

  server.registerTool(
    'stand_info',
    {
      title: t({ ru: 'Состояние стенда', en: "Stand status" }),
      description: t({
        ru: 'Состояние стенда: версия, пути, доступные браузеры, пресеты viewport и сохранённые профили условий, адреса артефактов, доступность валидатора, открытые сессии. С этого удобно начинать, когда непонятно, что стенду доступно, или когда проверка падает и надо понять, поднят ли валидатор.',
        en: "Stand status: version, paths, available browsers, viewport presets and saved condition profiles, artifact addresses, validator reachability, open sessions, interface language and available updates. A good place to start when it is unclear what the stand can reach, or when a check fails and you need to know whether the validator is up.",
      }),
      inputSchema: {},
    },
    async () => json(await buildStandInfo({ update, toolSet, toolSets })),
  );
}

/**
 * Сводка о стенде одним куском.
 *
 * Вынесена из обработчика, потому что у неё теперь две двери: инструмент stand_info и ресурс
 * lt://stand/info. Если бы каждая собирала payload сама, они разъехались бы на первой же
 * правке, и агент получал бы разные ответы на один вопрос в зависимости от того, как спросил.
 */
export async function buildStandInfo({ update, toolSet = 'all', toolSets = [] } = {}) {
  /*
   * Таймаут обязателен. stand_info — то, куда идут, когда непонятно, что со стендом, и
   * ожидание недоступного валидатора превращало этот вызов в десятисекундную паузу ровно
   * тогда, когда что-то уже не работает. Две секунды хватает, чтобы отличить поднятый
   * контейнер от погашенного.
   */
  const vnu = await fetch(`${CONFIG.vnuUrl}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? 'доступен' : `ответил ${r.status}`))
    .catch((e) => (e.name === 'TimeoutError' ? 'не ответил за 2 с' : `недоступен: ${e.message}`));
  return {
    version: pkg.version,
    /* Порядок обновления кладём прямо сюда: уведомление без инструкции заставляет
       агента гадать или искать документацию снаружи. */
    update: update
      ? { ...update, upgrade: update.upgrade || upgradeSteps(update.latest) }
      : { updateAvailable: null, unavailable: 'проверка не выполнялась' },
    language: langInfo(),
    dirs: DIRS,
    publicBaseUrl: CONFIG.publicBaseUrl,
    internalBaseUrl: CONFIG.internalBaseUrl,
    baseUrlNote:
      'publicBaseUrl — для человека снаружи. Внутри стенда проброшенного порта нет: в browser_goto подставляйте internalBaseUrl.',
    vnu: { url: CONFIG.vnuUrl, state: vnu },
    chromePath: CONFIG.chromePath || '(не задан)',
    browsers: BROWSERS,
    viewports: VIEWPORTS,
    checks: ALL_CHECKS,
    /* Имена профилей живут здесь, а не в описаниях инструментов: список меняется, а
       описания при каждом изменении пришлось бы править и переводить заново. */
    profiles: listProfiles(),
    /* Какой набор инструментов поднят. Модель, не нашедшая crawl или seo_page, должна
       узнать причину здесь, а не решить, что стенд неисправен. */
    tools: {
      set: toolSet,
      available: toolSets,
      note:
        toolSet === 'all'
          ? 'Поднят полный набор инструментов.'
          : `Поднят набор ${toolSet}: часть групп отключена переменной LT_TOOLS. Полный набор — LT_TOOLS=all и перезапуск стенда.`,
    },
    sessions: listSessions(),
  };
}

