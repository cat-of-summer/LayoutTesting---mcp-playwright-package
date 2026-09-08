/**
 * Константы стенда: пути, справочники, параметры обновления.
 *
 * Вынесено из config.js ради одного свойства: этот модуль **не импортирует playwright**.
 * В config.js он нужен для chromePath, и из-за одного вызова весь граф модулей — включая
 * описания инструментов — тянул за собой браузерный слой. Тесты на манифест из-за этого
 * не могли обойтись без установленного playwright, sharp и linkedom.
 *
 * config.js реэкспортирует всё отсюда, поэтому остальным файлам всё равно, откуда брать.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Корень рабочей директории — она же корень раздачи nginx. */
export const ROOT = path.resolve(here, '..');

export const DIRS = {
  root: ROOT,
  artifacts: path.join(ROOT, 'artifacts'),
  baselines: path.join(ROOT, 'baselines'),
  fixtures: path.join(ROOT, 'fixtures'),
  /** Архив обходов и зеркала сохранённых страниц. Не чистится автоматически, в отличие от artifacts. */
  sites: path.join(ROOT, 'sites'),
  /** storageState сессий. Наружу не отдаётся: см. DENIED_DIRS в paths.js. */
  state: path.join(ROOT, 'state'),
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

/**
 * Откуда стенд узнаёт о своих обновлениях.
 *
 * Держится здесь, рядом с остальной конфигурацией, а не в коде проверки: у форка или
 * внутренней сборки репозиторий и реестр образов свои, и менять их правкой исходника —
 * значит расходиться с апстримом в файле, который потом придётся мерджить.
 */
export const UPDATE = {
  repo: process.env.LT_UPDATE_REPO || 'cat-of-summer/LayoutTesting---mcp-playwright-package',
  image: process.env.LT_UPDATE_IMAGE || 'ghcr.io/cat-of-summer/layouttesting---mcp-playwright-package',
  /** Пустое значение выключает проверку целиком — для стендов без выхода наружу. */
  enabled: process.env.LT_UPDATE_CHECK !== '0',
};

UPDATE.releases = `https://github.com/${UPDATE.repo}/releases`;
UPDATE.api = `https://api.github.com/repos/${UPDATE.repo}/releases/latest`;
