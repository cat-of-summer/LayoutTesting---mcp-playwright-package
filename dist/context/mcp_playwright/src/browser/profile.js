import { VIEWPORTS } from '../config.js';

/**
 * Профиль условий просмотра. Одна страница проверяется под разными профилями —
 * это и есть матрица: viewport × тема × RTL × zoom × forced-colors × псевдолокализация.
 */
export const PROFILE_DEFAULTS = {
  browser: 'chromium',
  viewport: 'desktop',
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'reduce',
  forcedColors: 'none',
  locale: 'ru-RU',
  timezoneId: 'UTC',
  rtl: false,
  /** Layout-zoom в процентах: 200 сжимает viewport вдвое, как это делает браузер. */
  zoom: 100,
  /** Только размер шрифта, без изменения viewport (WCAG 1.4.4). */
  textZoom: 100,
  pseudoLoc: false,
  userAgent: undefined,
  /** Троттлинг сети и CPU — только chromium (через CDP). */
  throttle: null,
};

export function resolveViewport(value) {
  if (!value) return VIEWPORTS.desktop;
  if (typeof value === 'object') return value;
  if (VIEWPORTS[value]) return VIEWPORTS[value];
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(value).trim());
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  throw new Error(
    `Неизвестный viewport: ${value}. Ожидается WxH или одно из: ${Object.keys(VIEWPORTS).join(', ')}`,
  );
}

export function normalizeProfile(input = {}) {
  const p = { ...PROFILE_DEFAULTS, ...input };
  p.viewport = resolveViewport(p.viewport);
  const zoom = Number(p.zoom) || 100;
  if (zoom !== 100) {
    // Увеличение страницы уменьшает область просмотра в CSS-пикселях.
    p.viewport = {
      width: Math.max(200, Math.round((p.viewport.width * 100) / zoom)),
      height: Math.max(200, Math.round((p.viewport.height * 100) / zoom)),
    };
  }
  return p;
}

/** Короткий стабильный ключ профиля — используется в именах файлов и baseline. */
export function profileKey(profile) {
  const p = normalizeProfile(profile);
  const parts = [
    p.browser,
    `${p.viewport.width}x${p.viewport.height}`,
    p.deviceScaleFactor !== 1 ? `dpr${p.deviceScaleFactor}` : '',
    p.colorScheme !== 'light' ? p.colorScheme : '',
    p.forcedColors !== 'none' ? 'forced' : '',
    p.rtl ? 'rtl' : '',
    p.zoom !== 100 ? `zoom${p.zoom}` : '',
    p.textZoom !== 100 ? `text${p.textZoom}` : '',
    p.pseudoLoc ? 'pseudo' : '',
  ];
  return parts.filter(Boolean).join('_');
}

/** Опции browser.newContext() из профиля. */
export function contextOptions(profile) {
  const p = normalizeProfile(profile);
  return {
    viewport: p.viewport,
    deviceScaleFactor: p.deviceScaleFactor,
    colorScheme: p.colorScheme,
    reducedMotion: p.reducedMotion,
    forcedColors: p.forcedColors,
    locale: p.locale,
    timezoneId: p.timezoneId,
    userAgent: p.userAgent,
    ignoreHTTPSErrors: true,
  };
}
