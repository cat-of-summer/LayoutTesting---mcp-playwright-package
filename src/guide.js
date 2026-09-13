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
 * Поэтому текст лежит один раз файлами, а help, ресурс и промпт — три витрины одного и того же.
 *
 * Формат файла намеренно примитивен и обходится без парсера YAML: первая строка — «# Заголовок»,
 * третья — одна строка-аннотация, дальше тело. Аннотация идёт в перечни разделов и остаётся в
 * теле: разделу полезно начинаться с того, о чём он.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG } from './i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guide');

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
function chain(slug, text, lang) {
  const at = position(slug);
  const gate = /##\s+(?:Гейт[^\n]*|Gate)\n+([\s\S]*?)(?=\n#|\n*$)/.exec(text);
  const gateLine = gate ? gate[1].replace(/\s+/g, ' ').trim() : null;

  const ru = [];
  const en = [];
  if (at) {
    ru.push(`Фаза ${at.phase} из ${at.total - 1} регламента вёрстки по макету.`);
    en.push(`Phase ${at.phase} of ${at.total - 1} of the design-to-markup handbook.`);
    if (gateLine) {
      ru.push(`Фаза закрыта, когда: ${gateLine}`);
      en.push(`The phase is closed when: ${gateLine}`);
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

async function load(slug) {
  const cached = cache.get(slug);
  if (cached) return cached;

  const read = async (lang) => {
    try {
      return await fs.readFile(path.join(ROOT, lang, `${slug}.md`), 'utf8');
    } catch {
      return null;
    }
  };

  let lang = LANG;
  let text = await read(LANG);
  let note = null;
  if (!text && LANG !== 'ru') {
    /* Честнее отдать русский и сказать об этом, чем промолчать пустым ответом. */
    text = await read('ru');
    lang = 'ru';
    note = `Английской версии раздела «${slug}» нет — отдан русский текст.`;
  }
  if (!text) throw new Error(`Раздел регламента «${slug}» не найден в ${ROOT}.`);

  const entry = {
    slug,
    lang,
    text: `${text.trimEnd()}${chain(slug, text, lang)}`,
    ...parse(text),
    ...position(slug),
    ...(note ? { note } : {}),
  };
  cache.set(slug, entry);
  return entry;
}

/** Перечень разделов для витрин: чем открывается каждый и о чём он. */
export async function list() {
  return Promise.all(
    ORDER.map(async (slug) => {
      const entry = await load(slug);
      return { section: slug, title: entry.title, about: entry.about };
    }),
  );
}

/**
 * Один раздел.
 *
 * Слаг сверяется со списком, а не только чистится basename: список — это и проверка границы,
 * и ответ на опечатку. За пределы каталога отсюда не выйти ни при каком вводе.
 */
export async function read(slug) {
  const name = path.basename(String(slug || ''));
  if (!ORDER.includes(name)) return null;
  return load(name);
}
