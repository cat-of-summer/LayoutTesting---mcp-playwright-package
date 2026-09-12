/**
 * Какие эндпоинты Figma использует стенд и против какой версии API он написан.
 *
 * У REST API Figma нет единой версии: номер стоит в пути каждого эндпоинта (/v1, /v2), а
 * изменения идут журналом с датами. Машиночитаемая версия есть только у OpenAPI-спецификации
 * @figma/rest-api-spec и у типов Plugin API @figma/plugin-typings. Обе закреплены в
 * devDependencies — это и есть «версия, против которой написан код». bin/figma-api-check.mjs
 * сравнивает их с последними опубликованными и предупреждает при сборке.
 *
 * Tier и scope здесь не справочные: по tier считается лимит, по scope строится текст ошибки 403
 * и набор прав выпускаемого токена.
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export const SPEC_PACKAGES = {
  rest: '@figma/rest-api-spec',
  plugin: '@figma/plugin-typings',
};

export const PINNED = {
  rest: pkg.devDependencies?.[SPEC_PACKAGES.rest] ?? null,
  plugin: pkg.devDependencies?.[SPEC_PACKAGES.plugin] ?? null,
};

export const CHANGELOG_URL = 'https://developers.figma.com/docs/rest-api/changelog/';

/** Проверено по документации 2026-09-11. */
export const ENDPOINTS = {
  me: { path: '/v1/me', tier: 3, scope: 'current_user:read' },
  file: { path: '/v1/files/:key', tier: 1, scope: 'file_content:read' },
  fileMeta: { path: '/v1/files/:key/meta', tier: 3, scope: 'file_metadata:read' },
  fileNodes: { path: '/v1/files/:key/nodes', tier: 1, scope: 'file_content:read' },
  images: { path: '/v1/images/:key', tier: 1, scope: 'file_content:read' },
  imageFills: { path: '/v1/files/:key/images', tier: 2, scope: 'file_content:read' },
  comments: { path: '/v1/files/:key/comments', tier: 2, scope: 'file_comments:read' },
};

/** Права, которых хватает всем инструментам figma_*: только чтение. */
export const TOKEN_SCOPES = [...new Set(Object.values(ENDPOINTS).map((e) => e.scope))];

/**
 * Лимиты по типу места и тарифу, проверено 2026-09-11.
 *
 * high — места Full и Dev, лимит в минуту. low — места View и Collab: запросы к файлам и
 * рендерам считаются в месяц, и это главная ловушка — двадцать вызовов уходят за один разбор.
 */
export const RATE_LIMITS = {
  high: {
    starter: { 1: 10, 2: 25, 3: 50 },
    pro: { 1: 15, 2: 50, 3: 100 },
    org: { 1: 20, 2: 100, 3: 150 },
    enterprise: { 1: 20, 2: 100, 3: 150 },
  },
  low: { perMinute: { 2: 5, 3: 10 }, tier1PerMonth: 20 },
};

export function endpointPath(name, params = {}) {
  const spec = ENDPOINTS[name];
  if (!spec) throw new Error(`Неизвестный эндпоинт Figma: ${name}`);
  return spec.path.replace(/:(\w+)/g, (_, key) => {
    if (params[key] === undefined || params[key] === null) throw new Error(`Для ${name} нужен параметр ${key}`);
    return encodeURIComponent(params[key]);
  });
}
