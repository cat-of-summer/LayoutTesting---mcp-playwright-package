/**
 * Доступ к файлу Figma и совет, каким каналом его снимать.
 *
 * Отзыв, ради которого это есть: аккаунту стенда открыли файл только на просмотр, а REST на месте
 * View был выбран за месяц вперёд. Каждый инструмент советовал своё по шаблону — figma_spec слал в
 * канал редактора, уже лежавший в error, figma_find советовал deep: true при исчерпанном REST, —
 * и агент тратил вызовы на заведомые отказы. Здесь совет строится из того, что известно сейчас:
 * роль аккаунта на файле, состояние редактора для файла, копия в черновиках и остаток REST.
 *
 * Роль берётся из GET /v1/files/:key/meta (tier 3, у места View десять в минуту — хватает с
 * запасом) и кэшируется в figma/<ключ>/access.json на полчаса.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS, FIGMA } from '../constants.js';
import { askHuman } from '../request.js';
import { getRestClient, setRestHint } from './rest.js';
import { editorChannel, registerAccessProbe, registerCopyChooser } from './editor.js';

const ACCESS_TTL_MS = 30 * 60 * 1000;

const accessPath = (fileKey, cacheDir) => path.join(cacheDir, fileKey, 'access.json');

/* Снимок спрашивает редактор о файле из нескольких мест подряд: один запрос на файл, а не пачка. */
const inflight = new Map();

/**
 * Роль аккаунта на файле и доступ по ссылке: { role, linkAccess, version, checkedAt } или null,
 * если узнать нечем (нет токена) или Figma отказала.
 */
export function fileAccess(fileKey, options = {}) {
  if (!fileKey) return Promise.resolve(null);
  const key = `${options.cacheDir ?? DIRS.figma}\n${fileKey}\n${Boolean(options.refresh)}`;
  if (!inflight.has(key)) {
    inflight.set(key, readAccess(fileKey, options).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function readAccess(fileKey, { client = getRestClient(), cacheDir = DIRS.figma, refresh = false, now = () => Date.now() } = {}) {
  const file = accessPath(fileKey, cacheDir);
  if (!refresh) {
    try {
      const cached = JSON.parse(await fs.readFile(file, 'utf8'));
      if (cached?.checkedAt && now() - Date.parse(cached.checkedAt) < ACCESS_TTL_MS) return cached;
    } catch {
      /* Нет кэша — спросим Figma. */
    }
  }
  if (client.usable && !(await client.usable())) return null;
  let res;
  try {
    res = await client.fileMeta(fileKey);
  } catch {
    return null;
  }
  const meta = res?.file || res || {};
  const access = {
    role: meta.role ?? null,
    linkAccess: meta.link_access ?? null,
    ...(meta.version ? { version: String(meta.version) } : {}),
    ...(meta.name ? { name: meta.name } : {}),
    checkedAt: new Date(now()).toISOString(),
  };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(access, null, 2), 'utf8');
  } catch {
    /* Кэш — экономия, а не условие ответа. */
  }
  return access;
}

/**
 * Совет, каким каналом снимать файл, по текущему состоянию.
 *
 * except: 'rest' — совет для отказа REST, сам REST не предлагается; 'editor' — наоборот.
 * Возвращает строку; пустую, если советовать нечего.
 */
export async function channelAdvice(fileKey, { except = null, client = getRestClient(), editor = editorChannel } = {}) {
  const parts = [];
  if (except !== 'editor' && editor) {
    const why = editor.why ? await editor.why(fileKey) : (await editor.usable(fileKey)) ? null : 'канал редактора недоступен';
    if (!why) parts.push('Узлы и рендеры можно снять через канал редактора, у него лимита нет.');
    else parts.push(`Канал редактора для этого файла недоступен. ${why}`);
  }
  if (except !== 'rest' && client?.tier1Note) {
    const note = await client.tier1Note().catch(() => null);
    if (note && (note.remaining === 0 || note.blockedUntil)) parts.push(`REST не поможет. ${note.note}`);
    else if (note) parts.push(note.note);
  }
  return parts.join(' ');
}

/*
 * Подключение к редактору и REST. Модуль импортируют инструменты figma_*, поэтому к первому
 * вызову оба провайдера уже на месте.
 */
registerAccessProbe((fileKey) => fileAccess(fileKey));

/*
 * Команда для неявной копии. FIGMA_DUPLICATE_TEAM — решение владельца стенда заранее, вопросов
 * нет. Иначе — форма человеку в клиенте: команду выбирает он, агент в обмене не участвует. Клиент
 * без форм — отказ с подсказкой, как решить это явно.
 */
export async function chooseCopyTeam(fileKey, teams, { team = FIGMA.duplicateTeam, access: readAccess = fileAccess } = {}) {
  if (team) return team;
  const access = await readAccess(fileKey).catch(() => null);
  const title = access?.name ? `«${access.name}» (${fileKey})` : fileKey;
  const answer = await askHuman(
    `Файл Figma ${title} открыт аккаунту стенда только на просмотр — в этом режиме макет не снять. ` +
      'Скопировать его в черновики команды аккаунта стенда и работать с копией? Копию увидят участники команды; ' +
      'правки дизайнера в оригинале в неё не попадут — стенд скажет, когда копия отстанет.',
    {
      type: 'object',
      properties: { team: { type: 'string', title: 'Команда для копии', enum: teams } },
      required: ['team'],
    },
  );
  if (answer.action === 'accept' && answer.content.team) return answer.content.team;
  if (answer.action === 'unsupported') {
    return {
      declined: `Спросить человека, в какую команду копировать, нечем: клиент не поддерживает формы (elicitation). Команды аккаунта: ${teams.join(', ')}. Спросите человека и вызовите figma_sync с duplicate: "<команда>" — или задайте FIGMA_DUPLICATE_TEAM в .env стенда.`,
    };
  }
  return { declined: 'человек отказался копировать файл в черновики. Остаются edit-доступ от владельца или канал ui: figma_inspect и figma_export с channel: "ui".' };
}

registerCopyChooser((fileKey, teams) => chooseCopyTeam(fileKey, teams));
/* Совет нужен только к tier 1 — узлы и рендеры. Комментарии и история есть лишь в REST, и
   совет про редактор там сбивал; а на отказ tier 3 (тот же /meta) совет зациклил бы пробу роли. */
setRestHint(({ fileKey, tier }) => (tier === 1 ? channelAdvice(fileKey, { except: 'rest' }) : ''));
