/**
 * Артефакты стенда как ресурсы MCP.
 *
 * Инструменты и ресурсы отвечают на разные вопросы. Инструмент — это действие: сними, сравни,
 * обойди. Ресурс — это адресуемая вещь, которая уже существует и у которой есть имя. Стенд всё
 * это время производил именно такие вещи — прогоны, отчёты, эталоны, зеркала, — но достать их
 * можно было только вызовом read_artifact, который вклеивал содержимое прямо в переписку.
 *
 * С ресурсами появляется второй путь: инструмент возвращает ссылку, а клиент решает, когда и
 * что по ней читать. Это не замена read_artifact — ресурсы клиент показывает по своим правилам
 * (в Claude Code, например, их подтягивают явным упоминанием), и модель не может перебирать их
 * сама. Поэтому read_artifact остаётся, а ссылка добавляется рядом.
 *
 * Схема адресов повторяет устройство каталогов, а не маршруты nginx: lt://artifacts/…,
 * lt://baselines/…, lt://sites/…. Публичный http сюда не годится — он зависит от
 * PUBLIC_BASE_URL, и один и тот же файл получал бы разное имя на разных стендах.
 *
 * state/ не адресуем ни под каким видом: там лежат сохранённые логины. Чтение идёт через
 * resolveInside, где этот каталог уже запрещён, — отдельной проверки здесь нет намеренно,
 * чтобы не было двух мест, где решается один вопрос.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DIRS } from '../constants.js';
import { CONFIG } from '../config.js';
import { listRuns, onArtifactsChanged, publicUrl } from '../artifacts.js';
import { listBaselines } from '../checks/visual.js';
import { listSites } from '../crawl/store.js';
import { resolveInArtifacts, resolveInside } from '../paths.js';
import { IMAGE_MIME } from './shared.js';
import { t } from '../i18n.js';

const TEXT_LIKE = new Set(['.json', '.html', '.htm', '.txt', '.css', '.js', '.svg', '.xml', '.md']);

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  if (ext === '.json') return 'application/json';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.css') return 'text/css';
  if (ext === '.svg') return 'image/svg+xml';
  return 'text/plain';
}

/**
 * Чтение файла в том виде, в каком его ждёт протокол: текст текстом, всё прочее base64.
 *
 * Потолок тот же, что у read_artifact, и по той же причине: ресурс приходит в контекст так же,
 * как ответ инструмента, и мегабайтный снимок стоит там ровно столько же.
 */
async function readFileResource(uri, abs) {
  const stat = await fs.stat(abs);
  if (stat.size > CONFIG.maxInlineBytes) {
    return {
      contents: [
        {
          uri,
          mimeType: 'text/plain',
          text: t({
            ru: `Файл ${stat.size} байт — больше потолка ${CONFIG.maxInlineBytes}. Откройте его по адресу ${publicUrl(abs) || abs} или запросите через read_artifact: там большая картинка приходит уменьшенной копией.`,
            en: `The file is ${stat.size} bytes, above the ${CONFIG.maxInlineBytes} cap. Open it at ${publicUrl(abs) || abs}, or request it through read_artifact, which returns a downscaled copy for large images.`,
          }),
        },
      ],
    };
  }

  const ext = path.extname(abs).toLowerCase();
  if (TEXT_LIKE.has(ext)) {
    return { contents: [{ uri, mimeType: mimeOf(abs), text: await fs.readFile(abs, 'utf8') }] };
  }
  const buf = await fs.readFile(abs);
  return { contents: [{ uri, mimeType: mimeOf(abs), blob: buf.toString('base64') }] };
}

export function register(server, ctx = {}) {
  /*
   * Перечисляются прогоны и эталоны, а не файлы внутри них. Пятьдесят прогонов по десятку
   * файлов — это список, который сам становится полезной нагрузкой; до отдельного файла
   * добираются по шаблону адреса, зная имя прогона.
   */
  server.registerResource(
    'artifacts',
    new ResourceTemplate('lt://artifacts/{+path}', {
      list: async () => {
        const runs = await listRuns();
        return {
          resources: runs.map((runId) => ({
            uri: `lt://artifacts/${runId}/`,
            name: runId,
            description: t({ ru: `Прогон ${runId}`, en: `Run ${runId}` }),
            mimeType: 'inode/directory',
          })),
        };
      },
      complete: {
        /* Автодополнение по имени прогона: их имена — метки времени, наизусть их не помнят. */
        path: async (value) => {
          const runs = await listRuns();
          return runs.filter((runId) => runId.startsWith(String(value || ''))).slice(0, 20);
        },
      },
    }),
    {
      title: t({ ru: 'Результаты прогонов', en: 'Run artifacts' }),
      description: t({
        ru: 'Снимки, отчёты и сводки, сложенные проверками. Адрес файла внутри прогона: lt://artifacts/<прогон>/<файл>.',
        en: 'Screenshots, reports and summaries produced by the checks. A file inside a run is addressed as lt://artifacts/<run>/<file>.',
      }),
    },
    async (uri, { path: rel }) => readFileResource(uri.href, resolveInArtifacts(Array.isArray(rel) ? rel.join('/') : rel)),
  );

  server.registerResource(
    'baselines',
    new ResourceTemplate('lt://baselines/{name}', {
      list: async () => {
        const baselines = await listBaselines(DIRS.baselines);
        return {
          resources: baselines.map((item) => ({
            uri: `lt://baselines/${item.name}`,
            name: item.name,
            description: t({ ru: 'Эталон визуального сравнения', en: 'Visual comparison baseline' }),
            mimeType: 'image/png',
          })),
        };
      },
      complete: {
        name: async (value) => {
          const baselines = await listBaselines(DIRS.baselines);
          return baselines.map((b) => b.name).filter((f) => f.startsWith(String(value || ''))).slice(0, 20);
        },
      },
    }),
    {
      title: t({ ru: 'Эталоны', en: 'Baselines' }),
      description: t({
        ru: 'Снимки, с которыми visual_compare сличает текущее состояние. Имя включает профиль условий, поэтому один и тот же блок имеет свой эталон на каждую ширину и тему.',
        en: 'The shots visual_compare checks the current state against. The name includes the condition profile, so the same block has its own baseline per width and color scheme.',
      }),
    },
    async (uri, { name }) => {
      /* basename отрезает любые попытки уйти вверх по дереву; расширение добавляем сами —
         в имени эталона его нет, а на диске лежит .png. */
      const file = `${path.basename(String(name)).replace(/.png$/i, '')}.png`;
      return readFileResource(uri.href, path.join(DIRS.baselines, file));
    },
  );

  server.registerResource(
    'stand',
    'lt://stand/info',
    {
      title: t({ ru: 'Состояние стенда', en: 'Stand status' }),
      description: t({
        ru: 'То же, что отдаёт stand_info: версия, пути, пресеты, профили, язык. Ресурсом — чтобы клиент мог закрепить это в контексте, не тратя вызов.',
        en: 'The same payload stand_info returns: version, paths, presets, profiles, language. Exposed as a resource so a client can pin it without spending a tool call.',
      }),
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await ctx.standInfo()) }],
    }),
  );

  server.registerResource(
    'sites',
    new ResourceTemplate('lt://sites/{+path}', {
      list: async () => {
        const sites = await listSites();
        return {
          resources: sites.map((site) => ({
            uri: `lt://sites/${site.siteId}/`,
            name: site.siteId,
            description: t({
              ru: `Архив обхода ${site.url || site.siteId}`,
              en: `Crawl archive of ${site.url || site.siteId}`,
            }),
            mimeType: 'inode/directory',
          })),
        };
      },
      complete: {
        path: async (value) => {
          const sites = await listSites();
          return sites.map((s) => s.siteId).filter((id) => id.startsWith(String(value || ''))).slice(0, 20);
        },
      },
    }),
    {
      title: t({ ru: 'Архивы обхода и зеркала', en: 'Crawl archives and mirrors' }),
      description: t({
        ru: 'Сохранённые страницы: то, что положили crawl и page_save. Эти каталоги автоочистка не трогает — обход стоит несопоставимо дороже снимка.',
        en: 'Saved pages: what crawl and page_save put there. These directories are never pruned automatically — a crawl costs incomparably more than a screenshot.',
      }),
    },
    async (uri, { path: rel }) => {
      const parts = Array.isArray(rel) ? rel.join('/') : String(rel || '');
      return readFileResource(uri.href, resolveInside(DIRS.sites, parts));
    },
  );

  /*
   * Клиенту сообщается, что список изменился, из единственного места, где появляется прогон.
   * С задержкой: матрица заводит каталог один раз, а вот обход трогает sites/ постранично, и
   * уведомление на каждую страницу — это шум, который клиент честно отработает.
   */
  let pending = null;
  onArtifactsChanged(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      server.sendResourceListChanged?.();
    }, 2000);
    pending.unref?.();
  });
}

