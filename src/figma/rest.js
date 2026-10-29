/**
 * REST-клиент Figma, который помнит о лимитах.
 *
 * Прошлый опыт: лимит официального MCP кончился на двадцатом вызове, и первый отказ пришёл
 * неожиданно — узнать остаток заранее было нельзя. Здесь учёт ведётся на своей стороне:
 *
 *   - каждый запрос записывается в окно своего tier до отправки, так что минутный лимит
 *     соблюдается без единого 429;
 *   - тип места и тариф запоминаются из заголовков ответа 429 — других ответов с ними Figma не
 *     шлёт (проверено 2026-10-29 на /v1/me и /meta). Пока тип неизвестен, запросы к файлам
 *     считаются по месту View, двадцать в месяц: на нём стенд однажды потратил 58 запросов,
 *     прежде чем узнал, что место не Full. FIGMA_SEAT задаёт тип сразу;
 *   - после 429 время до повтора сохраняется, и следующий вызов отказывает сразу, не тратя
 *     попытку на заведомый отказ;
 *   - учёт лежит в state/figma/limits.json и переживает перезапуск стенда.
 *
 * Клиент один на процесс (getRestClient): под HTTP-транспортом сервер создаётся на каждого
 * клиента, а лимит у аккаунта общий.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS, FIGMA } from '../constants.js';
import { ENDPOINTS, LOW_BUDGET, RATE_LIMITS, endpointPath, seatLimitType } from './api.js';
import { redact, resolveToken } from './auth.js';

const MINUTE = 60_000;

export class FigmaApiError extends Error {
  constructor(message, { status = null, endpoint = null, retryAfter = null } = {}) {
    super(redact(message));
    this.name = 'FigmaApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.retryAfter = retryAfter;
  }
}

const EDITOR_HINT =
  'Узлы и рендеры можно снять через канал редактора, у него лимита нет: figma_status покажет, доступен ли он.';

/*
 * Что посоветовать, когда REST отказал по лимиту. Совет зависит от состояния редактора для
 * этого файла, а клиент REST о редакторе не знает: провайдер подключает src/figma/access.js.
 * Шаблонный совет «возьмите редактор» отправлял агента в канал, который уже лежал в error.
 */
let hintProvider = null;

export function setRestHint(fn) {
  hintProvider = fn;
}

export function createRestClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  token = resolveToken,
  budgetFile = path.join(DIRS.state, 'figma', 'limits.json'),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = FIGMA.maxWaitMs,
  apiBase = FIGMA.apiBase,
  seat = FIGMA.seat,
  hint = null,
} = {}) {
  let budget = null;

  async function advice(ctx) {
    const provider = hint ?? hintProvider;
    if (!provider) return EDITOR_HINT;
    try {
      return (await provider(ctx)) || '';
    } catch {
      return EDITOR_HINT;
    }
  }

  async function load() {
    if (budget) return budget;
    try {
      budget = JSON.parse(await fs.readFile(budgetFile, 'utf8'));
    } catch {
      budget = {};
    }
    budget.calls ??= {};
    budget.month ??= {};
    budget.blockedUntil ??= {};
    return budget;
  }

  async function save() {
    try {
      await fs.mkdir(path.dirname(budgetFile), { recursive: true });
      await fs.writeFile(budgetFile, JSON.stringify(budget, null, 2), 'utf8');
    } catch {
      /* Учёт — подстраховка, а не повод отказать в запросе. */
    }
  }

  const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);

  /** Тип лимита: сказанный Figma в 429, иначе заданный FIGMA_SEAT, иначе неизвестен (null). */
  const limitType = () => budget.rateLimitType ?? seatLimitType(seat);

  /* Пока тип места неизвестен, действует строжайшее из обоих: минутный лимит места Full на
     Starter, минутный и месячный лимиты места View. */
  function perMinute(tier) {
    const type = limitType();
    const high = (RATE_LIMITS.high[budget.planTier] ?? RATE_LIMITS.high.starter)[tier];
    if (type === 'high') return high;
    const low = tier === 1 ? null : RATE_LIMITS.low.perMinute[tier];
    if (type === 'low') return low;
    return low ? Math.min(low, high) : high;
  }

  /** Месячный потолок tier 1: у места View/Collab и пока тип неизвестен. */
  const perMonth = () => (limitType() === 'high' ? null : RATE_LIMITS.low.tier1PerMonth);
  const usedThisMonth = (at, tier = 1) => budget.month[monthKey(at)]?.[tier] ?? 0;

  async function acquire(tier, endpoint, fileKey = null) {
    await load();
    let at = now();

    const blocked = Date.parse(budget.blockedUntil[tier] || '') || 0;
    if (blocked > at) {
      const wait = blocked - at;
      if (wait > maxWaitMs) {
        throw new FigmaApiError(
          `Figma уже отказала по лимиту tier ${tier}; повтор не раньше ${budget.blockedUntil[tier]}. ${await advice({ fileKey, tier })}`,
          { status: 429, endpoint, retryAfter: Math.ceil(wait / 1000) },
        );
      }
      await sleep(wait);
      at = now();
    }

    const cap = tier === 1 ? perMonth() : null;
    if (cap && usedThisMonth(at) >= cap) {
      const used = usedThisMonth(at);
      const why = limitType()
        ? `Месячный лимит места View/Collab исчерпан: ${used} из ${cap} запросов к файлам и рендерам.`
        : `Тип места Figma неизвестен (Figma называет его только в отказе 429), поэтому запросы к файлам и рендерам считаются как у места View: ${used} из ${cap} за месяц. Если у аккаунта место Full или Dev, FIGMA_SEAT=full в .env стенда снимает этот потолок.`;
      throw new FigmaApiError(`${why} ${await advice({ fileKey, tier })}`, { status: 429, endpoint });
    }

    const limit = perMinute(tier);
    const recent = (budget.calls[tier] ?? []).filter((ts) => at - ts < MINUTE);
    if (limit && recent.length >= limit) {
      const wait = MINUTE - (at - recent[0]) + 50;
      if (wait > maxWaitMs) {
        throw new FigmaApiError(
          `Минутный лимит tier ${tier} выбран: ${recent.length} из ${limit}. Повтор через ${Math.ceil(wait / 1000)} с.`,
          { status: 429, endpoint, retryAfter: Math.ceil(wait / 1000) },
        );
      }
      await sleep(wait);
      at = now();
    }

    budget.calls[tier] = [...(budget.calls[tier] ?? []).filter((ts) => at - ts < MINUTE), at];
    const month = monthKey(at);
    budget.month[month] = { ...budget.month[month], [tier]: (budget.month[month]?.[tier] ?? 0) + 1 };
    for (const old of Object.keys(budget.month).sort().slice(0, -3)) delete budget.month[old];
    await save();
  }

  function remember(headers) {
    const type = headers.get('x-figma-rate-limit-type');
    const plan = headers.get('x-figma-plan-tier');
    let changed = false;
    if (type && type !== budget.rateLimitType) {
      budget.rateLimitType = type;
      changed = true;
    }
    if (plan && plan !== budget.planTier) {
      budget.planTier = plan;
      changed = true;
    }
    return changed;
  }

  function failure(status, name, body) {
    let detail = '';
    try {
      const parsed = JSON.parse(body);
      detail = parsed.err || parsed.message || '';
    } catch {
      detail = String(body || '').slice(0, 200);
    }
    const tail = detail ? ` Ответ Figma: ${detail}.` : '';
    if (status === 401 || status === 403) {
      return `Нет доступа (${status}) к ${name}: токен недействителен или истёк, у него нет scope ${ENDPOINTS[name].scope}, либо аккаунту не открыт файл.${tail}`;
    }
    if (status === 404) {
      return `Не найдено (404) на ${name}: неверный ключ файла или id узла, либо файл не открыт этому аккаунту.${tail}`;
    }
    return `Figma API ответил ${status} на ${name}.${tail}`;
  }

  async function request(name, { params = {}, query = {}, retried = false } = {}) {
    const spec = ENDPOINTS[name];
    /* Запрос действительно уходит — только здесь стенду позволено выпустить токен сам. */
    const auth = await token({ issue: true });
    if (!auth?.token) {
      throw new FigmaApiError(
        'Токен REST API Figma не задан: FIGMA_TOKEN в .env стенда, либо FIGMA_EMAIL и FIGMA_PASSWORD, чтобы стенд выпустил токен сам.',
        { endpoint: name },
      );
    }
    const url = new URL(`${apiBase}${endpointPath(name, params)}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }

    await acquire(spec.tier, name, params.key ?? null);
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'X-Figma-Token': auth.token }, signal: AbortSignal.timeout(90_000) });
    } catch (err) {
      throw new FigmaApiError(`Figma API не ответил на ${name}: ${err.message}`, { endpoint: name });
    }
    if (remember(res.headers)) await save();

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      budget.blockedUntil[spec.tier] = new Date(now() + retryAfter * 1000).toISOString();
      budget.last429 = { at: new Date(now()).toISOString(), endpoint: name, tier: spec.tier, retryAfter };
      await save();
      if (!retried && retryAfter * 1000 <= maxWaitMs) {
        await sleep(retryAfter * 1000);
        return request(name, { params, query, retried: true });
      }
      const low = budget.rateLimitType === 'low' ? ' Место View/Collab: лимит на файлы и рендеры месячный.' : '';
      throw new FigmaApiError(
        `Figma отказала по лимиту на ${name} (tier ${spec.tier}): повтор через ${retryAfter} с.${low} ${await advice({ fileKey: params.key ?? null, tier: spec.tier })}`,
        { status: 429, endpoint: name, retryAfter },
      );
    }
    if (res.status >= 500 && !retried) {
      await sleep(1000);
      return request(name, { params, query, retried: true });
    }

    const body = await res.text();
    if (!res.ok) throw new FigmaApiError(failure(res.status, name, body), { status: res.status, endpoint: name });
    try {
      return JSON.parse(body);
    } catch {
      throw new FigmaApiError(`Figma API вернул не JSON на ${name}.`, { status: res.status, endpoint: name });
    }
  }

  async function summary() {
    await load();
    const at = now();
    const tiers = {};
    for (const tier of [1, 2, 3]) {
      const blocked = Date.parse(budget.blockedUntil[tier] || '') || 0;
      const cap = tier === 1 ? perMonth() : null;
      tiers[tier] = {
        lastMinute: (budget.calls[tier] ?? []).filter((ts) => at - ts < MINUTE).length,
        perMinute: perMinute(tier),
        thisMonth: usedThisMonth(at, tier),
        ...(cap ? { perMonth: cap, remaining: Math.max(0, cap - usedThisMonth(at, tier)) } : {}),
        ...(blocked > at ? { blockedUntil: budget.blockedUntil[tier] } : {}),
      };
    }
    const type = limitType();
    return {
      rateLimitType: type ?? null,
      ...(budget.rateLimitType
        ? {}
        : type
          ? { source: 'FIGMA_SEAT' }
          : { assumed: 'View: Figma называет тип места только в отказе 429; FIGMA_SEAT в .env стенда задаёт его заранее' }),
      planTier: budget.planTier ?? null,
      tiers,
      ...(budget.last429 ? { last429: budget.last429 } : {}),
    };
  }

  /**
   * Остаток запросов к файлам, когда о нём стоит сказать: он мал, исчерпан или tier 1 закрыт до
   * времени. null — говорить не о чем.
   */
  async function tier1Note() {
    await load();
    const at = now();
    const blocked = Date.parse(budget.blockedUntil[1] || '') || 0;
    const cap = perMonth();
    const remaining = cap ? Math.max(0, cap - usedThisMonth(at)) : null;
    if (blocked > at) {
      return { remaining, blockedUntil: budget.blockedUntil[1], note: `Запросы к файлам и рендерам закрыты до ${budget.blockedUntil[1]}.` };
    }
    if (remaining === null || remaining > LOW_BUDGET) return null;
    return {
      remaining,
      perMonth: cap,
      note: remaining
        ? `Осталось ${remaining} из ${cap} запросов к файлам и рендерам в этом месяце: каждый figma_sync, figma_export и figma_compare без кэша тратит один.`
        : `Запросы к файлам и рендерам на этот месяц исчерпаны (${cap}).`,
    };
  }

  /** Файлы рендеров и заливок лежат на S3 по временной ссылке: ни токена, ни лимита. */
  async function download(url) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new FigmaApiError(`Не скачать файл Figma: ${err.message}`, { endpoint: 'download' });
    }
    if (!res.ok) throw new FigmaApiError(`Не скачать файл Figma: ответ ${res.status}.`, { status: res.status, endpoint: 'download' });
    return Buffer.from(await res.arrayBuffer());
  }

  return {
    /** Есть ли чем ходить в REST. Снимок по нему решает, какой канал брать. */
    usable: async () => Boolean((await token())?.token),
    me: () => request('me'),
    file: (key, { depth } = {}) => request('file', { params: { key }, query: { depth } }),
    fileMeta: (key) => request('fileMeta', { params: { key } }),
    fileNodes: (key, ids, { geometry = false, depth, version } = {}) =>
      request('fileNodes', { params: { key }, query: { ids, depth, version, geometry: geometry ? 'paths' : undefined } }),
    images: (key, ids, { format = 'png', scale = 1 } = {}) =>
      request('images', {
        params: { key },
        query: {
          ids,
          format,
          scale,
          ...(format === 'svg' ? { svg_include_id: 'false', svg_simplify_stroke: 'true' } : {}),
        },
      }),
    imageFills: (key) => request('imageFills', { params: { key } }),
    comments: (key) => request('comments', { params: { key }, query: { as_md: 'true' } }),
    versions: (key, { before, pageSize = 50 } = {}) =>
      request('versions', { params: { key }, query: { before, page_size: pageSize } }),
    budget: summary,
    tier1Note,
    download,
  };
}

let shared = null;

export function getRestClient() {
  shared ??= createRestClient();
  return shared;
}
