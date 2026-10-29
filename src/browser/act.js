/**
 * Действие на странице: общий исполнитель для browser_act, аудита в состояниях и form_audit.
 *
 * Раньше код жил прямо в регистрации browser_act, и любой инструмент, которому нужно было
 * «открыть меню и проверить», повторял бы его по-своему. Один исполнитель — одинаковые правила
 * для селекторов, клавиш и координат везде.
 */
import { stat } from 'node:fs/promises';
import { resolveInRoot } from '../paths.js';
import { waitForDownload } from './downloads.js';

/**
 * Ждать, пока выражение на странице станет истинным. Как у eval: сначала выражение, на
 * синтаксической ошибке — тело функции с return.
 *
 * Таймаут переводится в свою ошибку: общий разбор таймаутов говорит о селекторах, а селектора
 * здесь нет.
 */
async function waitForCondition(page, expression, timeout) {
  const options = { polling: 250, ...(timeout === undefined ? {} : { timeout }) };
  const attempt = (source) => page.waitForFunction(source, null, options);
  try {
    try {
      await attempt(`(${expression})`);
    } catch (err) {
      if (!/SyntaxError|Unexpected token|Illegal return/i.test(err?.message || '')) throw err;
      await attempt(`(() => { ${expression} })()`);
    }
  } catch (err) {
    if (!isTimeout(err)) throw err;
    const ms = /Timeout (\d+)ms/.exec(err.message)?.[1] ?? '?';
    throw new Error(
      `wait: условие ${expression} не стало истинным за ${ms} мс. Проверьте его в eval на текущей странице; тело функции должно возвращать значение через return.`,
    );
  }
}

/**
 * Элемент по селектору: первый видимый из совпадений, если первый по DOM скрыт.
 *
 * У Figma кнопка «Ask to edit» есть в трёх экземплярах панели инструментов, и видим только
 * второй: .first() брал скрытый, и клик падал с «есть в DOM, но не виден», хотя кнопка на
 * экране. Нет видимых совпадений — остаётся первое, и ошибка остаётся той же, что и была.
 */
async function pick(page, selector) {
  const all = page.locator(selector);
  const first = all.first();
  if ((await all.count().catch(() => 0)) < 2 || (await first.isVisible().catch(() => true))) return first;
  const visible = all.filter({ visible: true });
  return (await visible.count().catch(() => 0)) ? visible.first() : first;
}

const BBOX_NOTE =
  'Playwright счёл элемент невидимым, но в центре его рамки на экране он сам: клик ушёл мышью по координатам центра. Если эффекта нет — это не тот элемент; смотрите page_snapshot.';

/**
 * Клик по центру рамки, когда Playwright считает элемент невидимым, а на экране он есть.
 *
 * Только если в точке центра document.elementFromPoint отдаёт сам элемент или его потомка: иначе
 * клик ушёл бы в то, что элемент перекрывает, — это та ошибка, о которой должен сказать отказ.
 */
async function clickByBox(page, target, err) {
  if (!/element is not visible|not visible/i.test(err.message || '')) return null;
  const point = await target
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === el || el.contains(hit)) ? { x: Math.round(x), y: Math.round(y) } : null;
    }, null, { timeout: 2000 })
    .catch(() => null);
  if (!point) return null;
  await page.mouse.click(point.x, point.y);
  return point;
}

/**
 * Действия шагов states и form_audit. Отдельно от полного списка: их схемы платят за каждое
 * имя в манифесте, а зажатая клавиша или перетаскивание модалку не открывают.
 */
export const STATE_ACTIONS = ['click', 'fill', 'type', 'press', 'hover', 'scroll', 'wait', 'select', 'upload', 'dialog'];

/**
 * Полный список browser_act. tap, down, up и drag появились по отзыву с проверки игр: касания,
 * зажатая клавиша и перетаскивание по canvas делались скриптами Playwright в обход стенда.
 */
export const ACTIONS = [...STATE_ACTIONS, 'tap', 'down', 'up', 'drag'];

/*
 * Привычные имена из других инструментов. { action: 'key', value: 'Escape' } — ошибка enum, и
 * правильное press агент находил вторым вызовом; подсказка в тексте ошибки этот вызов экономит.
 */
const SYNONYMS = {
  key: 'press',
  keypress: 'press',
  keydown: 'down',
  keyup: 'up',
  sleep: 'wait',
  pause: 'wait',
  delay: 'wait',
  input: 'fill',
  check: 'click',
  touch: 'tap',
  dblclick: 'click',
  evaluate: 'eval',
  js: 'eval',
  script: 'eval',
  shot: 'screenshot',
  capture: 'screenshot',
};
const ELSEWHERE = {
  goto: 'переход — отдельным вызовом browser_goto',
  navigate: 'переход — отдельным вызовом browser_goto',
  reload: 'перезагрузка — browser_goto на тот же адрес',
};

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length];
}

/** Подсказка к неизвестному действию: синоним, другой инструмент или ближайшее по написанию. */
export function suggestAction(value, allowed = ACTIONS) {
  const name = String(value ?? '').trim().toLowerCase();
  if (ELSEWHERE[name]) return `${ELSEWHERE[name]}, в действиях его нет`;
  const synonym = SYNONYMS[name];
  if (synonym && allowed.includes(synonym)) return `возможно, вы имели в виду ${synonym}`;
  const [best] = allowed.map((a) => [a, distance(name, a)]).sort((x, y) => x[1] - y[1]);
  return best && best[1] <= Math.max(1, Math.floor(best[0].length / 3)) ? `возможно, вы имели в виду ${best[0]}` : null;
}

/** Перетаскивание по умолчанию: столько длится, точка — примерно на кадр. */
const DRAG_MS = 300;
const FRAME_MS = 16;

/**
 * Выполнить одно действие. Возвращает то, что стоит сказать о нём в ответе, без url и навигации:
 * их добавляет вызывающий.
 *
 * Таймаут Playwright приходит простынёй Call log, где причина — «кнопка disabled», «её
 * перекрывает ссылка» — зарыта в шестидесяти повторах. Из тридцати таких ошибок в журнале
 * повтор удавался в четырёх: агент не видел причины и менял не то. Здесь причина идёт первой
 * строкой.
 */
export async function perform(session, step = {}) {
  try {
    return await run(session, step);
  } catch (err) {
    if (!isTimeout(err)) throw err;
    throw new Error(explainTimeout(err.message, step));
  }
}

async function run(session, { action, selector, value, files, x, y, to, duration, timeout, force, expression } = {}) {
  const { page } = session;
  const wait = timeout === undefined ? {} : { timeout };

  /*
   * Диалог — не действие над элементом, а настройка сессии: политика применяется к
   * следующему alert, confirm или prompt, в том числе на уже открытой странице. Текст
   * диалогов пишется в журнал всегда и читается через page_logs с kind: dialogs.
   */
  if (action === 'dialog') {
    const wanted = String(value ?? 'dismiss');
    session.dialogPolicy =
      wanted === 'dismiss'
        ? { action: 'dismiss', promptText: null }
        : { action: 'accept', promptText: wanted === 'accept' ? null : wanted };
    return { action, dialogPolicy: session.dialogPolicy };
  }

  const target = selector ? await pick(page, selector) : null;
  const pressed = { ...wait, ...(force ? { force: true } : {}) };

  switch (action) {
    /* Клавиши: без селектора — на уровне страницы (Escape закрывают именно так), с селектором —
       сначала фокус. Раньше press без селектора уходил в locator('undefined') и падал по
       таймауту через полминуты — по такой ошибке не понять, что не так с вызовом. */
    case 'press': {
      const key = value ?? 'Enter';
      if (!duration) {
        if (target) await target.press(key, wait);
        else await page.keyboard.press(key);
        return { action, ...(selector ? { selector } : {}), key };
      }
      if (target) await target.focus(wait);
      await page.keyboard.down(key);
      await page.waitForTimeout(duration);
      await page.keyboard.up(key);
      return { action, ...(selector ? { selector } : {}), key, heldMs: duration };
    }
    case 'down':
    case 'up': {
      if (!value) throw new Error(`Для ${action} нужна клавиша в value: ArrowLeft, Space, Shift.`);
      if (target) await target.focus(wait);
      await (action === 'down' ? page.keyboard.down(value) : page.keyboard.up(value));
      return { action, key: value };
    }
    case 'wait': {
      /* Условие страницы: «пока в Layers не появятся строки», «пока не уйдёт спиннер». Раньше
         вместо него ставили паузу наугад — двенадцать секунд на каждое открытие Figma. */
      if (expression) {
        const started = Date.now();
        await waitForCondition(page, expression, wait.timeout);
        return { action, expression, ms: Date.now() - started };
      }
      if (value === 'download') {
        const file = await waitForDownload(session, timeout ?? 30_000);
        return { action, download: file.name };
      }
      if (target) {
        await target.waitFor({ state: 'visible', ...wait });
        return { action, selector };
      }
      /* В шагах states и form_audit поля duration нет, и пауза «подождать, пока доедет
         анимация» пишется числом в value. */
      const ms = duration || (/^\d+$/.test(String(value ?? '').trim()) ? Number(value) : 0);
      if (!ms) {
        throw new Error(
          'Для wait нужен selector — дождаться элемента, expression — дождаться условия, value: "download" — дождаться скачивания, или пауза в мс: duration или число в value.',
        );
      }
      await page.waitForTimeout(ms);
      return { action, ms };
    }
    case 'scroll':
      await page.evaluate(([sx, sy]) => window.scrollBy(sx, sy), [x ?? 0, y ?? 0]);
      return { action, selector };
    case 'click': {
      if (!target) {
        if (!x && !y) throw new Error('Для click без selector нужны координаты x и y.');
        await page.mouse.click(x, y);
        return { action, at: { x, y } };
      }
      /* x и y при селекторе — точка внутри элемента от его левого верхнего угла: кнопка
         «Начать» нарисована на canvas, и другого способа попасть по ней нет. */
      const position = hasPoint(x, y) ? { position: { x: x ?? 0, y: y ?? 0 } } : {};
      try {
        await target.click({ ...pressed, ...position });
      } catch (err) {
        const fallback = isTimeout(err) && !position.position ? await clickByBox(page, target, err) : null;
        if (!fallback) throw err;
        return { action, selector, at: fallback, fallback: 'bbox', note: BBOX_NOTE };
      }
      return { action, selector, ...(position.position ? { at: position.position } : {}) };
    }
    case 'tap':
      return tap(session, target, { selector, x, y, pressed });
    case 'drag':
      return drag(session, target, { selector, x, y, to, duration, wait });
  }

  if (!target) throw new Error(`Для действия ${action} нужен selector.`);
  switch (action) {
    case 'fill': await target.fill(value ?? '', wait); break;
    /* Посимвольно, как с клавиатуры: fill ставит значение разом и не шлёт beforeinput и
       keydown, поэтому маска ввода на этих событиях его не видит. Поле очищается заранее. */
    case 'type':
      await target.fill('', wait);
      await target.pressSequentially(value ?? '', { ...wait, delay: 10 });
      return { action, selector, value: await target.inputValue().catch(() => undefined) };
    case 'hover': await target.hover(pressed); break;
    case 'select': await target.selectOption(value ?? '', wait); break;
    case 'upload': return { action, selector, ...(await upload(page, target, files, wait, pressed)) };
    default: {
      const hint = suggestAction(action);
      throw new Error(`Неизвестное действие: ${action}${hint ? ` — ${hint}` : ''}. Доступны: ${ACTIONS.join(', ')}.`);
    }
  }
  return { action, selector };
}

const hasPoint = (x, y) => x !== undefined || y !== undefined;

/**
 * Точка на странице: от угла элемента, если он есть, иначе как есть.
 *
 * Без координат при элементе — его центр. Рамка снимается один раз и служит и началу, и концу
 * перетаскивания: кусок пазла едет, а отсчёт должен остаться от стола.
 */
async function anchor(target, wait) {
  if (!target) return null;
  await target.waitFor({ state: 'visible', ...wait });
  const box = await target.boundingBox();
  if (!box) throw new Error('У элемента нет рамки: он не отрисован или вне документа.');
  return box;
}

function pointAt(box, x, y, what) {
  if (box) {
    return hasPoint(x, y)
      ? { x: box.x + (x ?? 0), y: box.y + (y ?? 0) }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error(`Для ${what} без selector нужны координаты x и y.`);
  return { x, y };
}

const round = ({ x, y }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });

function needTouch(session, action) {
  if (session.profile?.hasTouch) return;
  throw new Error(
    `${action} — касание, а сессия открыта без касаний: страница их не получит. ` +
      'Откройте сессию через browser_open с touch: true или device (например, "iPhone 13").',
  );
}

async function tap(session, target, { selector, x, y, pressed }) {
  needTouch(session, 'tap');
  if (target && !hasPoint(x, y)) {
    await target.tap(pressed);
    return { action: 'tap', selector };
  }
  const point = pointAt(await anchor(target, pressed), x, y, 'tap');
  await session.page.touchscreen.tap(point.x, point.y);
  return { action: 'tap', ...(selector ? { selector } : {}), at: round(point) };
}

/**
 * Перетаскивание: нажать, провести через промежуточные точки, отпустить.
 *
 * Точки идут с паузой, а не залпом: игра на canvas считает скорость по времени между
 * pointermove, и сорок событий за одну миллисекунду для неё — телепорт, а не жест.
 *
 * В сессии с касаниями ведём пальцем: в chromium — Input.dispatchTouchEvent через CDP, у
 * Playwright своего swipe нет. В firefox и webkit такого канала нет вовсе, и вместо подделки
 * через dispatchEvent (isTrusted: false, часть библиотек такие события выбрасывает) — внятный
 * отказ: мышью там работает.
 */
async function drag(session, target, { selector, x, y, to, duration, wait }) {
  if (!to || typeof to.x !== 'number' || typeof to.y !== 'number') {
    throw new Error('Для drag нужен to: {x, y} — куда отпустить. При selector — от угла того же элемента.');
  }
  const box = await anchor(target, wait);
  const from = pointAt(box, x, y, 'drag');
  const end = box ? { x: box.x + to.x, y: box.y + to.y } : { x: to.x, y: to.y };
  const ms = duration ?? DRAG_MS;
  const points = Math.max(2, Math.round(ms / FRAME_MS));
  const pause = ms / points;
  const along = (i) => ({ x: from.x + ((end.x - from.x) * i) / points, y: from.y + ((end.y - from.y) * i) / points });

  const { page } = session;
  const touch = Boolean(session.profile?.hasTouch);
  if (touch) {
    if (session.profile.browser !== 'chromium') {
      throw new Error(
        `Перетаскивание пальцем есть только в chromium (CDP), а сессия — ${session.profile.browser}. ` +
          'Откройте сессию в chromium или без touch — тогда drag пойдёт мышью.',
      );
    }
    session.cdp ??= await page.context().newCDPSession(page);
    const send = (type, point) =>
      session.cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [],
      });
    await send('touchStart', from);
    for (let i = 1; i <= points; i += 1) {
      await page.waitForTimeout(pause);
      await send('touchMove', along(i));
    }
    await send('touchEnd', null);
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= points; i += 1) {
      await page.waitForTimeout(pause);
      const p = along(i);
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.up();
  }
  return {
    action: 'drag',
    ...(selector ? { selector } : {}),
    pointer: touch ? 'touch' : 'mouse',
    from: round(from),
    to: round(end),
    ms,
    points,
  };
}

/**
 * Выбор файлов.
 *
 * Два разных пути, и оба нужны. Скрытый input[type=file] за стилизованным label — самый
 * частый случай, и setInputFiles работает с ним прямо, не требуя видимости. Всё остальное —
 * кнопка, скрепка, зона перетаскивания — открывает системный диалог выбора, и его ловим
 * событием: без этого путь «клик по скрепке → выбор файла» проверить нечем.
 */
async function upload(page, target, files, wait, pressed) {
  if (!files || !files.length) {
    throw new Error('Для upload нужен files — пути к файлам относительно рабочего каталога стенда.');
  }

  const picked = [];
  for (const name of files) {
    const abs = resolveInRoot(name);
    const info = await stat(abs).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`Файла ${name} нет в рабочем каталоге стенда.`);
    picked.push({ path: name, abs, bytes: info.size });
  }
  const paths = picked.map((f) => f.abs);

  const isFileInput = await target
    .evaluate((el) => el instanceof HTMLInputElement && el.type === 'file')
    .catch(() => false);

  if (isFileInput) {
    await target.setInputFiles(paths, wait);
    return { via: 'input', files: picked.map(({ path, bytes }) => ({ path, bytes })) };
  }

  const [chooser] = await Promise.all([page.waitForEvent('filechooser', wait), target.click(pressed)]);
  await chooser.setFiles(paths);
  return { via: 'filechooser', files: picked.map(({ path, bytes }) => ({ path, bytes })) };
}

const isTimeout = (err) => err?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(err?.message || '');

/** Причины из Call log и что с ними делать. Порядок — от самой конкретной. */
const REASONS = [
  {
    test: /^(<.+>) intercepts pointer events$/,
    say: (m) => `элемент перекрыт: события забирает ${m[1]}`,
    hint: 'Кликните по перекрывающему элементу, закройте оверлей или передайте force: true, если перекрытие — прозрачный слой.',
  },
  {
    test: /^element is not enabled$/,
    say: () => 'элемент неактивен (disabled)',
    hint: 'Проверьте, что предыдущий шаг его включает: заполнено ли обязательное поле, отмечен ли чекбокс. Дождаться — wait по селектору с :enabled.',
  },
  {
    test: /^element is not editable$/,
    say: () => 'поле недоступно для ввода (readonly или disabled)',
    hint: 'Ввод в такое поле не пройдёт; проверьте, что его разблокирует.',
  },
  {
    test: /^element is not visible$/,
    say: () => 'элемент есть в DOM, но не виден',
    hint: 'Откройте контейнер действием (меню, вкладка, аккордеон) или проверьте display, visibility и нулевой размер.',
  },
  {
    test: /^element is outside of the viewport$/,
    say: () => 'элемент вне окна, и прокрутить к нему не вышло',
    hint: 'Прокрутите контейнер (scroll) или кликните по координатам.',
  },
  {
    test: /^element is not stable$/,
    say: () => 'элемент всё время движется',
    hint: 'Анимация не останавливается: откройте сессию с animations: "freeze" или передайте force: true.',
  },
];

/**
 * Таймаут Playwright → одна строка причины, подсказка и короткий хвост лога.
 *
 * Чистая функция: разбирает только текст ошибки, чтобы проверяться без браузера.
 */
export function explainTimeout(message, { action, selector } = {}) {
  const text = String(message || '');
  const lines = text.split('\n').map((l) => l.trim().replace(/^-\s*/, '').replace(/^\d+ × /, ''));
  const ms = /Timeout (\d+)ms/.exec(text)?.[1];
  const what = `${action || 'действие'}${selector ? ` ${selector}` : ''}`;
  const head = `${what}: не выполнено за ${ms ?? '?'} мс`;
  const tail = [...new Set(lines.slice(1).filter((l) => l && l !== 'Call log:'))].slice(-5);
  const log = tail.length ? `\nХвост лога: ${tail.join(' | ')}` : '';

  const resolved = lines.map((l) => /^locator resolved to (.+)$/.exec(l)?.[1]).filter(Boolean).pop();
  if (!resolved) {
    return (
      `${head} — селектор ничего не нашёл. ` +
      'Проверьте его по page_snapshot: там готовые селекторы. Если элемент появляется позже — wait по этому селектору с timeout побольше.' +
      log
    );
  }

  for (const reason of REASONS) {
    const found = lines.map((l) => reason.test.exec(l)).filter(Boolean).pop();
    if (found) return `${head} — ${reason.say(found)}. Элемент: ${resolved}. ${reason.hint}${log}`;
  }
  /* waitFor ждёт видимости: элемент нашёлся, но так и не показался. */
  if (/waitFor/.test(lines[0])) {
    return `${head} — элемент есть, но не стал видимым. Элемент: ${resolved}. Его открывает другое действие, или он скрыт стилями.${log}`;
  }
  return `${head}. Элемент: ${resolved}.${log}`;
}
