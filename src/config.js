/**
 * Настройки стенда, читаемые из окружения.
 *
 * Пути, справочники и параметры обновления живут в constants.js — тот модуль сознательно
 * обходится без playwright, чтобы описания инструментов и тесты на манифест не тянули
 * браузерный слой. Здесь остаётся только то, ради чего playwright всё-таки нужен, плюс
 * реэкспорт: для остальных файлов ничего не меняется, импорт по-прежнему из config.js.
 */
import { chromium } from 'playwright';

export { ROOT, DIRS, BROWSERS, VIEWPORTS, UPDATE } from './constants.js';

function safeExecutablePath() {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

export const CONFIG = {
  mcpPort: Number(process.env.MCP_PORT || 8931),
  /**
   * База для публичных ссылок на артефакты — с точки зрения того, кто смотрит снаружи:
   * порт проброшен на хост.
   */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8089').replace(/\/+$/, ''),
  /**
   * Тот же nginx, но изнутри контейнера, где проброшенного порта не существует.
   * Различать обязательно: браузер стенда живёт здесь же, и по публичной ссылке
   * он получает ECONNREFUSED — открыть собственный артефакт нечем.
   */
  internalBaseUrl: (process.env.INTERNAL_BASE_URL || 'http://127.0.0.1').replace(/\/+$/, ''),
  vnuUrl: (process.env.VNU_URL || 'http://vnu_layout:8888').replace(/\/+$/, ''),
  /**
   * Lighthouse и pa11y запускают браузер сами. Спрашиваем путь у Playwright:
   * переменная окружения из entrypoint не видна процессам docker compose exec.
   */
  chromePath: process.env.CHROME_PATH || safeExecutablePath(),
  /** Сколько прогонов артефактов держать перед автоочисткой. */
  artifactsKeep: Number(process.env.ARTIFACTS_KEEP || 50),
  /** Предел journal-буфера сессии на каждый вид записей: консоль, ошибки, сеть. */
  logBufferSize: Number(process.env.LOG_BUFFER_SIZE || 2000),
  /*
   * Границы жизни сессий браузера.
   *
   * Раньше границ не было вовсе: сессия жила до явного browser_close или до остановки
   * процесса. В коротком прогоне это незаметно, в долгой работе агента — нет: каждая
   * забытая сессия держит свой контекст, а контекст стоит сотни мегабайт.
   *
   * Простой в 15 минут заведомо длиннее любого хода агента и заведомо короче, чем
   * «забыли и ушли». Предельный возраст нужен отдельно: сессию можно трогать раз в минуту
   * сутками, и по простою она не закроется никогда.
   */
  maxSessions: Number(process.env.LT_MAX_SESSIONS || 8),
  sessionIdleMs: Number(process.env.LT_SESSION_IDLE_MS || 15 * 60 * 1000),
  sessionMaxAgeMs: Number(process.env.LT_SESSION_MAX_AGE_MS || 60 * 60 * 1000),
  sessionSweepMs: Number(process.env.LT_SESSION_SWEEP_MS || 60 * 1000),
  defaultTimeout: Number(process.env.DEFAULT_TIMEOUT || 30000),
  /** Порог расхождения визуальной регрессии в процентах пикселей. */
  visualThreshold: Number(process.env.VISUAL_THRESHOLD || 0.1),
};
