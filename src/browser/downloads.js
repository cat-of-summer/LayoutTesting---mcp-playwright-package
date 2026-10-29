/**
 * Скачивания в сессии: файлы, которые страница отдаёт кнопкой «Скачать», ложатся в артефакты.
 *
 * Отзыв, ради которого это есть: экспорт PNG из интерфейса Figma снять штатно было нельзя.
 * Перехват <a download>.click ничего не ловил, fetch со страницы на /upload стенда резала CSP
 * сайта, и картинку выводили в <img> поверх страницы и снимали скриншотом — с пережатием и
 * окном шире выгружаемого узла. Путей сохранения у страниц два, и ловятся оба:
 *
 *   - обычное скачивание (ссылка с download, blob:, ответ с Content-Disposition) — событие
 *     download Playwright, файл сохраняется как есть;
 *   - File System Access API (showSaveFilePicker) — в headless-браузере окна выбора нет, и
 *     сохранение молча не происходит. Заглушка отдаёт странице записываемый «файл», а
 *     записанное уходит стенду через exposeBinding: это канал протокола браузера, CSP страницы
 *     его не касается.
 *
 * Заглушка ставится только там, где showSaveFilePicker есть в браузере сам по себе: в firefox
 * и webkit его нет, и появившаяся функция поменяла бы ветку, по которой идёт страница.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactRef, newRunId, runDir, slug } from '../artifacts.js';

/** Сколько ждать незавершённые скачивания перед ответом действия. */
const SETTLE_MS = 5000;

/** Сколько считать начатое страницей сохранение незавершённым, если файл так и не пришёл. */
const SAVE_TIMEOUT_MS = 15_000;

const PICKER_STUB = () => {
  if (typeof window.showSaveFilePicker !== 'function' || window.__ltPickerStub) return;
  window.__ltPickerStub = true;
  /* Начало сохранения сообщается сразу, синхронно: файл приходит асинхронно, а ответ действия
     должен его дождаться, а не уйти раньше. */
  let seq = 0;
  const begin = () => {
    seq += 1;
    const id = `${Date.now()}-${seq}`;
    window.__ltSaveBegin(id);
    return id;
  };
  const toBytes = async (data) => {
    if (data == null) return new Uint8Array();
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'object' && 'data' in data) return toBytes(data.data);
    return new TextEncoder().encode(String(data));
  };
  const toBase64 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  };
  window.showSaveFilePicker = async (options = {}) => {
    const id = begin();
    const name = options.suggestedName || 'download';
    const type = options.types?.[0] ? Object.keys(options.types[0].accept || {})[0] || '' : '';
    return {
      kind: 'file',
      name,
      async getFile() {
        return new File([], name, { type });
      },
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      },
      async createWritable() {
        const chunks = [];
        return {
          async write(data) {
            chunks.push(await toBytes(data));
          },
          async seek() {},
          async truncate() {},
          async close() {
            const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const all = new Uint8Array(size);
            let at = 0;
            for (const chunk of chunks) {
              all.set(chunk, at);
              at += chunk.length;
            }
            await window.__ltSaveFile(name, toBase64(all), type, id);
          },
          async abort() {
            await window.__ltSaveFile(name, null, type, id);
          },
        };
      },
    };
  };
};

/** Имя файла без пути и опасных символов, с сохранённым расширением. */
export function safeFileName(name, fallback = 'download') {
  const base = path.basename(String(name || '').replace(/\\/g, '/')) || fallback;
  const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = slug(base.slice(0, base.length - path.extname(base).length)) || fallback;
  return `${stem}${ext}`;
}

async function target(session, name) {
  session.downloadRun ??= newRunId('downloads');
  const dir = await runDir(session.downloadRun);
  const file = safeFileName(name);
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 1; ; n += 1) {
    const candidate = path.join(dir, n === 1 ? file : `${stem}-${n}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

async function record(session, entry, file) {
  const { size } = await fs.stat(file);
  const item = { name: entry.name, via: entry.via, bytes: size, at: new Date().toISOString(), ...(entry.url ? { from: entry.url } : {}), ...artifactRef(file) };
  session.downloads.push(item);
  return item;
}

function track(session, job) {
  session.pendingDownloads.add(job);
  job.catch((err) => session.downloadErrors.push(err.message)).finally(() => session.pendingDownloads.delete(job));
}

/** Подключить перехват к странице сессии. Вызывается один раз при создании сессии. */
export async function installDownloads(page, session) {
  session.downloads = [];
  session.downloadsSeen = 0;
  session.downloadErrors = [];
  session.pendingDownloads = new Set();

  page.on('download', (download) => {
    const name = download.suggestedFilename();
    track(
      session,
      (async () => {
        const file = await target(session, name);
        await download.saveAs(file);
        const failure = await download.failure();
        if (failure) throw new Error(`Скачивание ${name} не завершилось: ${failure}`);
        return record(session, { name, via: 'download', url: download.url().startsWith('blob:') ? null : download.url() }, file);
      })(),
    );
  });

  /* Сохранение со страницы началось: ответ действия ждёт его, как ждёт обычное скачивание.
     Страница может так и не дописать файл — тогда ожидание снимается по сроку. */
  const started = new Map();
  await page.exposeBinding('__ltSaveBegin', (_source, id) => {
    let done;
    const job = new Promise((resolve) => {
      done = resolve;
    });
    const timer = setTimeout(() => done(null), SAVE_TIMEOUT_MS);
    timer.unref?.();
    started.set(id, (value) => {
      clearTimeout(timer);
      started.delete(id);
      done(value);
    });
    track(session, job);
  });
  await page.exposeBinding('__ltSaveFile', async (_source, name, base64, type, id) => {
    const finish = started.get(id) ?? (() => {});
    /* null — страница отменила запись (abort): файла нет, и ждать его незачем. */
    if (base64 === null) return finish(null);
    const job = (async () => {
      const file = await target(session, name);
      await fs.writeFile(file, Buffer.from(String(base64 || ''), 'base64'));
      return record(session, { name, via: 'showSaveFilePicker', type }, file);
    })();
    track(session, job);
    try {
      await job;
    } finally {
      finish(null);
    }
  });
  await page.addInitScript(PICKER_STUB);
}

/** Дождаться начатых скачиваний, но не дольше ms. */
export async function settleDownloads(session, ms = SETTLE_MS) {
  if (!session.pendingDownloads?.size) return;
  let timer;
  await Promise.race([
    Promise.allSettled([...session.pendingDownloads]),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Дождаться нового скачивания — шаг wait с value: "download". Кнопка экспорта сначала рисует
 * файл и только потом отдаёт его, и фиксированная пауза здесь — то же гадание, что и раньше.
 */
export async function waitForDownload(session, timeout = 30_000) {
  const before = session.downloads.length;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (session.downloads.length > before) return session.downloads[session.downloads.length - 1];
    if (session.pendingDownloads.size) await settleDownloads(session, Math.min(1000, timeout - (Date.now() - started)));
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Скачивание не началось за ${timeout} мс. Кнопка могла открыть меню или диалог, а не сохранить файл; если страница сохраняет через canvas без скачивания, файл не появится — тогда screenshot по элементу.`,
  );
}

/** Скачивания, которых агент ещё не видел, — в ответ действия. */
export async function takeDownloads(session) {
  if (!session.downloads) return null;
  await settleDownloads(session);
  const fresh = session.downloads.slice(session.downloadsSeen);
  session.downloadsSeen = session.downloads.length;
  const errors = session.downloadErrors.splice(0);
  if (!fresh.length && !errors.length) return null;
  return { ...(fresh.length ? { downloads: fresh } : {}), ...(errors.length ? { downloadErrors: errors } : {}) };
}
