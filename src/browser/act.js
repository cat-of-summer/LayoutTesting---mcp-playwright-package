/**
 * Действие на странице: общий исполнитель для browser_act, аудита в состояниях и form_audit.
 *
 * Раньше код жил прямо в регистрации browser_act, и любой инструмент, которому нужно было
 * «открыть меню и проверить», повторял бы его по-своему. Один исполнитель — одинаковые правила
 * для селекторов, клавиш и координат везде.
 */
import { stat } from 'node:fs/promises';
import { resolveInRoot } from '../paths.js';

export const ACTIONS = ['click', 'fill', 'type', 'press', 'hover', 'scroll', 'wait', 'select', 'upload', 'dialog'];

/**
 * Выполнить одно действие. Возвращает то, что стоит сказать о нём в ответе, без url и навигации:
 * их добавляет вызывающий.
 */
export async function perform(session, { action, selector, value, files, x = 0, y = 0, timeout, force } = {}) {
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

  /*
   * Клавиша и клик по координатам обходятся без селектора: Escape закрывают на уровне
   * страницы, а по координатам кликают там, где подходящего узла в DOM просто нет.
   * Раньше press без селектора уходил в locator('undefined') и падал по таймауту через
   * полминуты — по такой ошибке не понять, что не так с вызовом.
   */
  if (!selector && action !== 'scroll') {
    if (action === 'press') {
      await page.keyboard.press(value ?? 'Enter');
      return { action, key: value ?? 'Enter' };
    }
    if (action === 'click') {
      if (!x && !y) throw new Error('Для click без selector нужны координаты x и y.');
      await page.mouse.click(x, y);
      return { action, at: { x, y } };
    }
    throw new Error(`Для действия ${action} нужен selector.`);
  }

  const target = selector ? page.locator(selector).first() : null;
  const pressed = { ...wait, ...(force ? { force: true } : {}) };

  switch (action) {
    case 'click': await target.click(pressed); break;
    case 'fill': await target.fill(value ?? '', wait); break;
    /* Посимвольно, как с клавиатуры: fill ставит значение разом и не шлёт beforeinput и
       keydown, поэтому маска ввода на этих событиях его не видит. Поле очищается заранее. */
    case 'type':
      await target.fill('', wait);
      await target.pressSequentially(value ?? '', { ...wait, delay: 10 });
      return { action, selector, value: await target.inputValue().catch(() => undefined) };
    case 'press': await target.press(value ?? 'Enter', wait); break;
    case 'hover': await target.hover(pressed); break;
    case 'select': await target.selectOption(value ?? '', wait); break;
    case 'scroll': await page.evaluate(([sx, sy]) => window.scrollBy(sx, sy), [x, y]); break;
    case 'wait': await target.waitFor({ state: 'visible', ...wait }); break;
    case 'upload': return { action, selector, ...(await upload(page, target, files, wait, pressed)) };
    default: throw new Error(`Неизвестное действие: ${action}`);
  }
  return { action, selector };
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
