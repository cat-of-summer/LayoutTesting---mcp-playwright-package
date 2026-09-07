import { VIEWPORTS } from '../config.js';
import { statePath } from './storage.js';

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
  /**
   * Доступ к странице. На пиксели не влияют и в profileKey не входят: иначе
   * логин и заголовки попадали бы в имена эталонов.
   */
  httpCredentials: null,
  extraHTTPHeaders: null,
  /** {"www.example.com": "172.20.0.5"} — только chromium, аргумент запуска. */
  hostMap: null,
  /** Готовое состояние (куки и localStorage) при создании контекста — см. browser/storage.js. */
  storageState: null,
  /** block нужен обходу: иначе Service Worker отдаёт свой кэш вместо того, что отвечает сервер. */
  serviceWorkers: null,
};

/** Сокращение auth: "user:pass" — руками так набирать быстрее, чем объект. */
export function parseAuth(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const idx = String(value).indexOf(':');
  if (idx < 1) throw new Error('auth задаётся строкой "пользователь:пароль".');
  return { username: String(value).slice(0, idx), password: String(value).slice(idx + 1) };
}

/** Аргумент запуска chromium, подменяющий разрешение имён: стенды за vhost. */
export function hostResolverRules(hostMap) {
  const entries = Object.entries(hostMap || {});
  if (!entries.length) return null;
  return `--host-resolver-rules=${entries.map(([host, ip]) => `MAP ${host} ${ip}`).join(',')}`;
}

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
  const { auth, ...rest } = input;
  const p = { ...PROFILE_DEFAULTS, ...rest };
  if (auth) p.httpCredentials = parseAuth(auth);
  p.viewport = resolveViewport(p.viewport);
  /* storageState принимается именем файла из state/, а не путём: путь наружу отдавать незачем,
     а имя разворачивается здесь один раз — иначе каждый инструмент разворачивал бы его сам. */
  if (typeof p.storageState === 'string') p.storageState = statePath(p.storageState);
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
    ...(p.httpCredentials ? { httpCredentials: p.httpCredentials } : {}),
    ...(p.extraHTTPHeaders ? { extraHTTPHeaders: p.extraHTTPHeaders } : {}),
    ...(p.storageState ? { storageState: p.storageState } : {}),
    ...(p.serviceWorkers ? { serviceWorkers: p.serviceWorkers } : {}),
  };
}
