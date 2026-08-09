import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Корень рабочей директории — она же корень раздачи nginx. */
export const ROOT = path.resolve(here, '..');

export const DIRS = {
  root: ROOT,
  artifacts: path.join(ROOT, 'artifacts'),
  baselines: path.join(ROOT, 'baselines'),
  fixtures: path.join(ROOT, 'fixtures'),
};

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
  defaultTimeout: Number(process.env.DEFAULT_TIMEOUT || 30000),
  /** Порог расхождения визуальной регрессии в процентах пикселей. */
  visualThreshold: Number(process.env.VISUAL_THRESHOLD || 0.1),
};

export const BROWSERS = ['chromium', 'firefox', 'webkit'];

/** Именованные viewport'ы для матрицы условий. */
export const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  'mobile-sm': { width: 320, height: 568 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1366, height: 768 },
  desktop: { width: 1440, height: 900 },
  wide: { width: 1920, height: 1080 },
};
