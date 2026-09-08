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
import { BROWSERS, VIEWPORTS } from '../config.js';

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

/*
 * Без отступов сознательно. Ответ читает модель, а не человек: переводы строк и пробелы
 * добавляют 20-40% токенов на каждый вызов и ничего не проясняют. Клиент, показывающий
 * результат человеку, форматирует его сам. Файлы, которые открывают глазами, — writeJson
 * в artifacts.js и кэш update.js — по-прежнему с отступами.
 */
export const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
export const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

/**
 * Усечение списка с честным признаком.
 *
 * Молчаливый .slice() — худший вариант из возможных: модель видит пятьдесят строк и считает,
 * что это всё. Вместе с флагом возвращается фраза со следующим offset — голый truncated: true
 * модель может не отработать, прямое указание, что делать дальше, отрабатывает.
 */
export function capped(items, { limit = 50, offset = 0 } = {}) {
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  const shown = offset + page.length;
  if (offset === 0 && shown === total) return { items: page, total };
  return {
    items: page,
    total,
    offset,
    limit,
    truncated: shown < total,
    ...(shown < total
      ? { note: `Показано ${page.length} из ${total}, начиная с ${offset}. Дальше — offset: ${shown}.` }
      : {}),
  };
}

/** То же, но берутся последние записи: для логов важен хвост, а не начало. */
export function cappedTail(items, limit) {
  const total = items.length;
  if (total <= limit) return { items, total };
  return {
    items: items.slice(-limit),
    total,
    truncated: true,
    note: `Показаны последние ${limit} записей из ${total}. Раньше — увеличьте limit.`,
  };
}

export function cappedText(value, { max, offset = 0 } = {}) {
  const str = String(value ?? '');
  const part = str.slice(offset, offset + max);
  const end = offset + part.length;
  const out = { text: part, chars: str.length };
  if (offset) out.offset = offset;
  if (end < str.length) {
    out.truncated = true;
    out.note = `Показано ${part.length} символов из ${str.length}, начиная с ${offset}. Дальше — offset: ${end}.`;
  }
  return out;
}


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

/**
 * Условия просмотра для инструментов, которые открывают сессию сами.
 *
 * Три параметра прямо и один по имени. Прямо — те, которыми пользуются постоянно: движок,
 * размер, тема. «Проверь на мобиле» и «проверь в тёмной» должны оставаться одним вызовом,
 * иначе экономия на схеме оплачивается лишним ходом в самом частом случае.
 *
 * Остальные пятнадцать параметров — zoom, RTL, троттлинг, hostMap, псевдолокализация и прочее —
 * задаются в browser_open и закрепляются профилем через profile_save. Полный их список
 * объявлен ровно в одном месте (profileSchema выше), а не в каждом инструменте: шесть копий
 * стоили около четверти манифеста.
 *
 * Имена профилей здесь не перечисляются намеренно: список протухает, а место ему — в
 * stand_info, который его и отдаёт.
 */
export const profileCoreSchema = {
  browser: z.enum(BROWSERS).optional().describe(d('Движок браузера')),
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
  profile: z
    .string()
    .optional()
    .describe(d('Имя сохранённого профиля условий: остальные условия берутся из него. Список — в stand_info')),
};
