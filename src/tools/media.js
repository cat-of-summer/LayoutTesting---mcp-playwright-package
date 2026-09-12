/**
 * Инструменты: картинки для вёрстки — оптимизация исходников и заглушки.
 *
 * Группа живёт на одном ограничении: стенд в контейнере, проект агента на хосте, и общей
 * файловой системы у них нет. Поэтому ни один инструмент здесь не принимает путь на машине
 * пользователя и не пишет в проект. Исходник приходит по адресу или загрузкой /upload,
 * результат ложится в артефакты, и агент забирает его по url в тот каталог проекта, который
 * выбрал сам.
 */
import { z } from 'zod';
import { t } from '../i18n.js';
import { CONFIG } from '../config.js';
import { json } from './shared.js';
import { FITS, OUTPUT_FORMATS, convertImages } from '../media/convert.js';
import { FONT_FAMILIES, PLACEHOLDER_FORMATS, renderPlaceholders } from '../media/placeholder.js';

const width = z.number().int().min(1).max(8000);

export function register(server) {
  server.registerTool(
    'image_convert',
    {
      title: t({ ru: 'Оптимизация картинок', en: 'Image optimization' }),
      description: t({
        ru: `Ресайз и конвертация картинок для вёрстки: набор ширин под srcset в webp/avif/jpeg/png, без увеличения, с EXIF-поворотом и без метаданных; в ответе размеры, экономия и готовый <picture>. Исходник — http(s)-адрес (контейнер проекта, host.docker.internal) или lt://artifacts/…; локальный файл сначала отдают стенду: curl -F file=@путь ${CONFIG.publicBaseUrl}/upload. Результат забирают по url: curl -fsSL -o <путь в проекте> <url>.`,
        en: `Resizes and converts images for a layout: a set of widths for srcset in webp/avif/jpeg/png, never upscaled, EXIF rotation applied, metadata stripped; returns sizes, savings and a ready <picture>. Source is an http(s) address (the project container, host.docker.internal) or lt://artifacts/…; a local file is first handed to the stand: curl -F file=@path ${CONFIG.publicBaseUrl}/upload. Fetch results by url: curl -fsSL -o <project path> <url>.`,
      }),
      inputSchema: {
        src: z
          .union([z.string(), z.array(z.string()).min(1)])
          .describe(t({ ru: 'Адрес исходника или список адресов', en: 'Source address or a list of them' })),
        widths: z
          .array(width)
          .optional()
          .describe(t({ ru: 'Ширины под srcset, например [480, 960, 1440]. Без них размер исходника', en: 'Widths for srcset, e.g. [480, 960, 1440]. Without them the source size is kept' })),
        height: width.optional().describe(t({ ru: 'Высота; вместе с fit: cover кадрирует', en: 'Height; with fit: cover it crops' })),
        fit: z.enum(FITS).optional().describe(t({ ru: 'inside (по умолчанию) вписывает с сохранением пропорций', en: 'inside (default) fits within, keeping the aspect ratio' })),
        formats: z
          .array(z.enum(OUTPUT_FORMATS))
          .min(1)
          .optional()
          .describe(t({ ru: 'По умолчанию [webp]; original — формат исходника', en: 'Default [webp]; original keeps the source format' })),
        quality: z.number().int().min(1).max(100).optional(),
        background: z.string().optional().describe(t({ ru: 'Фон под прозрачность при переводе в jpeg, по умолчанию #ffffff', en: 'Background for transparency when converting to jpeg, default #ffffff' })),
      },
    },
    async ({ src, widths, height, fit, formats, quality, background }) =>
      json(await convertImages(Array.isArray(src) ? src : [src], { widths, height, fit, formats, quality, background })),
  );

  server.registerTool(
    'image_placeholder',
    {
      title: t({ ru: 'Картинки-заглушки', en: 'Placeholder images' }),
      description: t({
        ru: 'Заглушки нужных размеров для вёрстки: фон, рамка, диагонали и подпись «600×400 3:2». Все размеры макета — одним вызовом. Файлы ложатся в артефакты; в проект их забирают по url: curl -fsSL -o <путь в проекте> <url>.',
        en: 'Placeholder images of the sizes a layout needs: background, border, diagonals and a "600×400 3:2" label. Every size of the layout in one call. Files land in artifacts; fetch them into the project by url: curl -fsSL -o <project path> <url>.',
      }),
      inputSchema: {
        sizes: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe(t({ ru: 'Размеры вида 600x400', en: 'Sizes written as 600x400' })),
        format: z.enum(PLACEHOLDER_FORMATS).optional().describe(t({ ru: 'png по умолчанию', en: 'png by default' })),
        scale: z.number().min(1).max(3).optional().describe(t({ ru: '2 — файл @2x с той же подписью', en: '2 — an @2x file with the same label' })),
        text: z.string().optional().describe(t({ ru: 'Своя подпись вместо размера; строки через \\n', en: 'Custom label instead of the size; lines split by \\n' })),
        bg: z.string().optional(),
        borderColor: z.string().optional(),
        borderWidth: z.number().min(0).max(100).optional(),
        textColor: z.string().optional(),
        fontSize: z.number().min(1).max(2000).optional(),
        fontFamily: z.enum(FONT_FAMILIES).optional(),
      },
    },
    async ({ sizes, format, scale, ...style }) => json(await renderPlaceholders(sizes, { format, scale, ...style })),
  );
}
