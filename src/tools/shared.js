/**
 * Общее для всех групп инструментов.
 *
 * Раньше это лежало прямо в server.js, и пока файл был один, так было удобно. С разносом
 * регистраций по группам каждая из них потянула бы `json`, `profileSchema` и остальное у
 * соседней — а такие импорты между равноправными модулями расползаются быстрее всего.
 */
import { z } from 'zod';
import { d } from '../i18n-params.js';
import { t } from '../i18n.js';
import { readFile } from 'node:fs/promises';
import { VIEWPORTS } from '../config.js';

export const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

/** Расширения, которые нет смысла отдавать как utf8. */
export const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

export const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
export const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

/** Условия просмотра. Подмешивается в каждый инструмент, который открывает свою сессию. */
export const profileSchema = {
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe(d('Движок браузера')),
  viewport: z
    .string()
    .optional()
    .describe(
      t({
        ru: `Размер: WxH или имя (${Object.keys(VIEWPORTS).join(', ')})`,
        en: `Size: WxH or a preset name (${Object.keys(VIEWPORTS).join(', ')})`,
      }),
    ),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  forcedColors: z.enum(['none', 'active']).optional().describe(d('Режим высокой контрастности Windows')),
  reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  rtl: z.boolean().optional().describe(d('Развернуть страницу справа налево')),
  zoom: z.number().optional().describe(d('Масштаб страницы в процентах: 200 сжимает viewport вдвое')),
  textZoom: z.number().optional().describe(d('Масштаб только шрифта в процентах (WCAG 1.4.4)')),
  pseudoLoc: z.boolean().optional().describe(d('Псевдолокализация: диакритика и +40% длины строк')),
  deviceScaleFactor: z.number().optional().describe(d('DPR: 1, 2, 3')),
  locale: z.string().optional(),
  timezoneId: z.string().optional(),
  freezeTime: z.boolean().optional().describe(d('Заморозить Date и Math.random для стабильных снимков')),
  throttle: z
    .object({ network: z.string().optional(), cpu: z.number().optional() })
    .optional()
    .describe(d('Троттлинг (только chromium): network 3g|slow-3g|4g, cpu — множитель замедления')),
  auth: z
    .string()
    .optional()
    .describe(d('HTTP basic auth в виде "пользователь:пароль". Логин в самом URL не нужен — он потом лезет во все ответы')),
  extraHTTPHeaders: z
    .record(z.string())
    .optional()
    .describe(d('Заголовки ко всем запросам: Accept-Language, X-Forwarded-Proto и прочее')),
  hostMap: z
    .record(z.string())
    .optional()
    .describe(d('Подмена разрешения имён: {"www.site.local": "172.20.0.5"} — для стендов за vhost. Только chromium')),
  storageState: z
    .string()
    .optional()
    .describe(d('Имя сохранённого состояния из browser_storage: сессия откроется уже залогиненной')),
  serviceWorkers: z
    .enum(['allow', 'block'])
    .optional()
    .describe(d('block — не давать Service Worker подменять ответы своим кэшем')),
};
