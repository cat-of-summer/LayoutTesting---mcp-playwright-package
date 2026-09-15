/**
 * SKILL.md — регламент вёрстки как скилл агента, собранный из guide/.
 *
 * Зачем ещё одна витрина. help(guide) надо вызвать, а вызвать его помнят не всегда: в одной
 * сессии агент получил на первый вызов ошибку и больше к регламенту не возвращался. Скилл
 * подтягивается клиентом по триггеру — «сверстай по макету», ссылка на figma.com, — без участия
 * агента, и в проекте лежит трёхстрочная заглушка, которая скачивает этот файл со стенда.
 *
 * Почему собирается, а не лежит файлом. Текст регламента живёт в guide/ один раз; SKILL.md,
 * написанный руками, стал бы второй копией правил и разошёлся бы на первой правке. Здесь только
 * склейка: frontmatter, карта фаз (index), правила и запреты (rules) и краткие чек-листы всех
 * фаз. Полный текст фазы скилл не включает намеренно — он читается по одной фазе через help или
 * GET /guide/<lang>/<slug>.md, а скилл должен помещаться в контекст целиком.
 *
 * Собирает и отдаёт одно и то же: bin/gen-tools-doc.mjs пишет файл в docs/ и проверяет его,
 * HTTP-маршрут /skill/layout-by-figma/SKILL.md отдаёт тот же текст с живого стенда.
 */
import { ORDER, PHASES, gateOf, read } from './guide.js';

export const SKILL_NAME = 'layout-by-figma';

/** Потолок на размер в знаках: скилл читается целиком при каждом срабатывании триггера. */
export const SKILL_MAX_CHARS = 26000;

const WORDS = {
  ru: {
    description:
      'Вёрстка страницы по макету Figma на стенде layout: фазы, чек-листы, правила и запреты. Триггеры: «сверстай по макету», «сделай как в макете», ссылка на figma.com в задаче.',
    checklists: 'Чек-листы фаз',
    checklistsAbout:
      'Краткая форма каждой фазы: ВХОД, ШАГИ, ВЫХОД. Полный текст фазы с разбором случаев — help(guide: "<раздел>") на стенде или GET /guide/ru/<раздел>.md; краткая — help(guide: "<раздел>", brief: true).',
    exit: 'ВЫХОД',
    phase: 'Фаза',
    generated: 'Собрано из guide/ стендом layout; править — там, а не здесь.',
  },
  en: {
    description:
      'Building a page from a Figma design on the layout stand: phases, checklists, rules and prohibitions. Triggers: "build this from the design", "make it like the mockup", a figma.com link in the task.',
    checklists: 'Phase checklists',
    checklistsAbout:
      'The brief form of every phase: ENTRY, STEPS, EXIT. The full text of a phase with the cases behind it — help(guide: "<section>") on the stand or GET /guide/en/<section>.md; the brief one — help(guide: "<section>", brief: true).',
    exit: 'EXIT',
    phase: 'Phase',
    generated: 'Assembled from guide/ by the layout stand; edit it there, not here.',
  },
};

/** Тело раздела без заголовка первой строки и без хвоста цепочки. */
function bodyOf(section) {
  const [body] = section.text.split('\n\n---\n\n');
  return body.replace(/^#\s[^\n]*\n+/, '').trimEnd();
}

/**
 * Собрать SKILL.md на указанном языке.
 *
 * @returns {Promise<{ text: string, missing: string[] }>} — missing перечисляет фазы без чек-листа:
 *   генератор по нему падает, а маршрут отдаёт то, что есть, и не притворяется полным.
 */
export async function buildSkill(lang = 'ru') {
  const words = WORDS[lang] || WORDS.ru;
  const index = await read('index', { lang });
  const rules = await read('rules', { lang });
  if (!index || !rules) {
    throw new Error(`Регламент на стенде неполон: нет раздела ${!index ? 'index' : 'rules'} (${lang}).`);
  }

  const lines = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${words.description}`,
    '---',
    '',
    `# ${index.title}`,
    '',
    bodyOf(index),
    '',
    `## ${rules.title}`,
    '',
    bodyOf(rules).replace(/^## /gm, '### '),
    '',
    `## ${words.checklists}`,
    '',
    words.checklistsAbout,
    '',
  ];

  const missing = [];
  for (const slug of PHASES) {
    const section = await read(slug, { lang });
    if (!section?.checklist) {
      missing.push(slug);
      continue;
    }
    const gate = gateOf(section.text.split('\n\n---\n\n')[0]);
    lines.push(`### ${words.phase} ${section.phase} · ${slug} — ${section.title.replace(/^[^.]*\.\s*/, '')}`, '');
    lines.push('```', section.checklist, ...(gate ? [`${words.exit}: ${gate}`] : []), '```', '');
  }

  lines.push('---', '', `_${words.generated}_`, '');
  return { text: lines.join('\n'), missing };
}

/**
 * Проверки собранного скилла — те, что генератор превращает в падение сборки.
 *
 * Возвращает список проблем; пустой список — скилл годен. Проверяются формальные вещи, которые
 * ломают скилл молча: без frontmatter клиент его не подхватит, ссылка на несуществующий раздел
 * уводит в тупик, а слишком длинный текст не помещается в контекст.
 */
export function checkSkill({ text, missing }) {
  const problems = [];
  if (!/^---\nname: [a-z-]+\ndescription: .+\n---\n/.test(text)) problems.push('нет frontmatter с name и description');
  for (const slug of missing) problems.push(`у фазы ${slug} нет чек-листа («## Чек-лист» / «## Checklist»)`);
  for (const match of text.matchAll(/help\(guide: "([^"]+)"/g)) {
    /* «<раздел>» в угловых скобках — подстановка в объяснении, а не ссылка. */
    if (/^<.*>$/.test(match[1])) continue;
    if (!ORDER.includes(match[1])) problems.push(`ссылка на несуществующий раздел регламента: ${match[1]}`);
  }
  if (text.length > SKILL_MAX_CHARS) problems.push(`скилл занимает ${text.length} знаков — больше потолка ${SKILL_MAX_CHARS}`);
  return problems;
}
