/**
 * Регламент вёрстки по макету: порядок работы, разложенный по фазам.
 *
 * Не путать с checks/guide.js — тот собирает визуальный справочник вариантов для человека.
 * Здесь — текст, который читает агент: что делать и в каком порядке, когда верстают по Figma.
 *
 * Почему markdown в каталоге, а не строки в коде. Правила разбора макета уже жили в четырёх
 * местах сразу — в instructions, в теме figma у help, в промпте figma-layout и в оговорках по
 * инструментам, — и все четыре были сокращёнными пересказами друг друга. Пятая копия сделала бы
 * хуже: расходиться они начинают на первой же правке, а читающий не знает, какой верить.
 * Поэтому текст лежит один раз файлами, а help, ресурс, промпт, HTTP-маршрут и SKILL.md —
 * витрины одного и того же.
 *
 * Формат файла намеренно примитивен и обходится без парсера YAML: первая строка — «# Заголовок»,
 * третья — одна строка-аннотация, дальше тело. Аннотация идёт в перечни разделов и остаётся в
 * теле: разделу полезно начинаться с того, о чём он.
 *
 * У фазы есть ещё две обязательные части, и обе вытаскиваются из тела, а не пишутся в коде:
 *   - «## Чек-лист» — ВХОД и ШАГИ в телеграфной форме. Его перечитывают перед переходом между
 *     фазами (brief) и из него собирается SKILL.md;
 *   - «## Гейт» — условие выхода. Оно же — строка ВЫХОД чек-листа, поэтому в чек-листе не
 *     повторяется: вторая копия разъехалась бы на первой правке.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG } from './i18n.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guide');

/**
 * Разделы в порядке работы, а не по алфавиту.
 *
 * Список явный, по образцу groups.js: фазы упорядочены по смыслу, и readdir перемешал бы их.
 * Заодно это единственный словарь разделов в проекте — файл на диске не из этого списка и слаг
 * из списка без файла одинаково валят тест, и разъехаться молча они не могут.
 */
export const ORDER = [
  'index',
  'setup',
  'frames',
  'inventory',
  'system',
  'assets',
  'fonts',
  'content',
  'questions',
  'motion',
  'shell',
  'block',
  'page',
  'project',
  'rules',
  'symptoms',
];

/**
 * Фазы в порядке прохождения — та часть ORDER, которая образует цепочку.
 *
 * index, rules и symptoms в неё не входят: первый объясняет устройство, два других — справочные
 * и читаются в любой момент. Нумеровать их наравне с фазами значило бы обещать, что их тоже надо
 * пройти по очереди.
 */
export const PHASES = [
  'setup',
  'frames',
  'inventory',
  'system',
  'assets',
  'fonts',
  'content',
  'questions',
  'motion',
  'shell',
  'block',
  'page',
  'project',
];

/**
 * Где агент находится и куда идти дальше.
 *
 * Курсор не хранится на сервере намеренно. Хранить его было бы не к чему привязать: задача не
 * имеет идентичности в протоколе, сессия — это браузер, а не работа, и две задачи подряд
 * получили бы чужое состояние. Поэтому положение несёт сам ответ: прочитав фазу, агент видит её
 * номер и имя следующей — и цепочка держится на этом, а не на памяти стенда.
 */
export function position(slug) {
  const phase = PHASES.indexOf(slug);
  if (phase === -1) return null;
  return { phase, total: PHASES.length, next: PHASES[phase + 1] ?? null };
}

const cache = new Map();

/** Заголовок и аннотация — первая и третья строки. Всё остальное тело. */
function parse(text) {
  const lines = text.split('\n');
  const title = (lines[0] || '').replace(/^#\s*/, '').trim();
  const about = (lines.slice(1).find((line) => line.trim()) || '').trim();
  return { title, about };
}

/** Раздел «## Имя» до следующего заголовка того же уровня; null, если раздела нет. */
function sectionOf(text, heading) {
  const re = new RegExp(`##\\s+(?:${heading})[^\\n]*\\n+([\\s\\S]*?)(?=\\n##\\s|\\n*$)`);
  const hit = re.exec(text);
  return hit ? hit[1].trimEnd() : null;
}

/** Гейт одной строкой: он идёт в хвост цепочки и в строку ВЫХОД чек-листа. */
export const gateOf = (text) => {
  const gate = sectionOf(text, 'Гейт|Gate');
  return gate ? gate.replace(/\s+/g, ' ').trim() : null;
};

/** Чек-лист как он записан в файле: ВХОД и ШАГИ. ВЫХОД добавляется снаружи из гейта. */
export const checklistOf = (text) => sectionOf(text, 'Чек-лист|Checklist');

/**
 * Хвост, превращающий раздел в шаг цепочки.
 *
 * Без него регламент остаётся перечнем, из которого читают то, на что упал взгляд: шестнадцать
 * разделов, и ни один не говорит, что делать после него. С ним прочитанная фаза сама называет
 * следующую, и порядок держится на самом тексте, а не на том, вспомнит ли о нём агент.
 *
 * Гейт вытаскивается из тела, а не пишется здесь второй раз: иначе разъедется при первой правке
 * раздела — та самая вторая копия, от которой регламент и уезжал в файлы.
 */
function chain(slug, text, lang, { brief = false } = {}) {
  const at = position(slug);
  const gateLine = gateOf(text);

  const ru = [];
  const en = [];
  if (at) {
    ru.push(`Фаза ${at.phase} из ${at.total - 1} регламента вёрстки по макету.`);
    en.push(`Phase ${at.phase} of ${at.total - 1} of the design-to-markup handbook.`);
    /* В краткой форме гейт уже стоит строкой ВЫХОД — второй раз он только удлиняет ответ. */
    if (gateLine && !brief) {
      ru.push(`Фаза закрыта, когда: ${gateLine}`);
      en.push(`The phase is closed when: ${gateLine}`);
    }
    if (!brief) {
      /* Полный текст читают один раз, а перед переходом дальше перечитывают краткий: за два часа
         работы контекст сжимается, и десять шагов помнятся как ощущение, а не как список. */
      ru.push(`Перед тем как закрыть фазу, перечитайте её кратко: help(guide: "${slug}", brief: true) — только чек-лист и гейт.`);
      en.push(`Before closing the phase, re-read it briefly: help(guide: "${slug}", brief: true) — the checklist and the gate only.`);
    }
    /*
     * На последней фазе вызова следующей нет намеренно.
     *
     * Ссылка обратно на index читалась бы как продолжение цепочки, и обход, идущий по хвостам,
     * уходил бы на второй круг. Конец работы должен выглядеть концом работы.
     */
    ru.push(
      at.next
        ? `Закрыв её, вызовите help(guide: "${at.next}") — следующую фазу. Не пропускайте: пропущенная обычно всплывает переделкой блока.`
        : 'Это последняя фаза: закрыв её гейт, регламент пройден. Вызывать больше нечего.',
    );
    en.push(
      at.next
        ? `Once it is closed, call help(guide: "${at.next}") for the next phase. Do not skip: a skipped phase usually surfaces as a rebuilt block.`
        : 'This is the last phase: once its gate is closed, the handbook is done. There is nothing further to call.',
    );
  } else if (slug === 'index') {
    ru.push(`Регламент читается по одной фазе, а не целиком: прочитали — сделали — вызвали следующую. Начните с help(guide: "${PHASES[0]}").`);
    en.push(`The handbook is read one phase at a time rather than all at once: read, do, call the next. Start with help(guide: "${PHASES[0]}").`);
  } else {
    ru.push('Это справочный раздел, а не фаза: читайте его в любой момент. Порядок работы — help(guide: "index").');
    en.push('This is a reference section rather than a phase: read it at any time. The order of work is help(guide: "index").');
  }

  if (!ru.length) return '';
  return `\n\n---\n\n${(lang === 'en' ? en : ru).join('\n')}`;
}

/**
 * Краткая форма фазы: заголовок, чек-лист, ВЫХОД из гейта и хвост цепочки.
 *
 * Это то, что перечитывают перед переходом между фазами, и то, из чего собирается SKILL.md.
 * Раздел без чек-листа (index, rules, symptoms) краткой формы не имеет — отдаётся целиком.
 */
function briefText(slug, text, lang) {
  const checklist = checklistOf(text);
  if (!checklist) return null;
  const gate = gateOf(text);
  const exit = lang === 'en' ? 'EXIT' : 'ВЫХОД';
  const title = parse(text).title;
  return `# ${title}\n\n${checklist}${gate ? `\n${exit}: ${gate}` : ''}${chain(slug, text, lang, { brief: true })}`;
}

/**
 * Язык раздела — язык стенда, если не попросили другой.
 *
 * Явный язык нужен SKILL.md и HTTP-маршруту /guide/<lang>/…: агент на английском стенде может
 * попросить русский текст, и наоборот. Кэш поэтому ключуется языком.
 */
async function load(slug, { lang: wanted = LANG } = {}) {
  const key = `${wanted}:${slug}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const read = async (lang) => {
    try {
      return await fs.readFile(path.join(ROOT, lang, `${slug}.md`), 'utf8');
    } catch {
      return null;
    }
  };

  let lang = wanted;
  let text = await read(wanted);
  let note = null;
  if (!text && wanted !== 'ru') {
    /* Честнее отдать русский и сказать об этом, чем промолчать пустым ответом. */
    text = await read('ru');
    lang = 'ru';
    note = `Английской версии раздела «${slug}» нет — отдан русский текст.`;
  }
  if (!text) return null;

  const entry = {
    slug,
    lang,
    text: `${text.trimEnd()}${chain(slug, text, lang)}`,
    brief: briefText(slug, text, lang),
    checklist: checklistOf(text),
    gate: gateOf(text),
    ...parse(text),
    ...position(slug),
    ...(note ? { note } : {}),
  };
  cache.set(key, entry);
  return entry;
}

/**
 * Есть ли регламент на этом стенде.
 *
 * Каталог в образ попадает отдельным шагом сборки, и один релиз вышел без него: help отвечал
 * «раздел не найден», агент решил, что регламента нет вовсе, и верстал по наитию. Поэтому
 * отсутствие — не исключение по пути к файлу, а состояние, которое показывают stand_info и help.
 */
export async function status({ lang } = {}) {
  let present = 0;
  for (const slug of ORDER) if (await load(slug, { lang })) present += 1;
  return {
    available: present === ORDER.length,
    sections: present,
    expected: ORDER.length,
    root: ROOT,
    ...(present < ORDER.length
      ? {
          reason:
            present === 0
              ? `Каталог регламента ${ROOT} отсутствует: образ стенда собран без него. Это ошибка сборки, не настройки — сообщите человеку.`
              : `В каталоге ${ROOT} есть только ${present} из ${ORDER.length} разделов.`,
        }
      : {}),
  };
}

/** Перечень разделов для витрин: чем открывается каждый и о чём он. Отсутствующие пропускаются. */
export async function list({ lang } = {}) {
  const entries = await Promise.all(ORDER.map((slug) => load(slug, { lang })));
  return entries.filter(Boolean).map((entry) => ({ section: entry.slug, title: entry.title, about: entry.about }));
}

/**
 * Один раздел.
 *
 * Слаг сверяется со списком, а не только чистится basename: список — это и проверка границы,
 * и ответ на опечатку. За пределы каталога отсюда не выйти ни при каком вводе. Нет файла —
 * null, как и при неверном слаге: различить эти случаи помогает status().
 */
export async function read(slug, { lang } = {}) {
  const name = path.basename(String(slug || ''));
  if (!ORDER.includes(name)) return null;
  return load(name, { lang });
}
