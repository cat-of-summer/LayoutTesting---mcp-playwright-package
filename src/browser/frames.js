/**
 * Серия кадров сразу после навигации: стартовая анимация, которую иначе не поймать.
 *
 * browser_goto ждёт загрузку и стабилизирует страницу, и к первому screenshot intro уже
 * отыграло — на одной странице hero показывал финальный кадр до старта JS, и в стенде это не
 * увидели никак: ни eval, ни снимок не успевали. Здесь переход ждёт только commit, а дальше
 * снимает viewport с заданным шагом, ничего не останавливая. Стабилизация идёт отдельным
 * переходом уже после — она про полноту кадра, а не про первые секунды.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { artifactRef, newRunId, runDir } from '../artifacts.js';
import { t } from '../i18n.js';

export const FRAMES_MAX = 12;
export const FRAMES_MIN_STEP_MS = 50;

export async function captureFrames(session, url, { count = 6, stepMs = 200 } = {}) {
  const total = Math.max(1, Math.min(FRAMES_MAX, Math.round(count)));
  const step = Math.max(FRAMES_MIN_STEP_MS, Math.round(stepMs));
  const dir = await runDir(newRunId('frames'));

  session.navByTool = true;
  const started = Date.now();
  try {
    await session.page.goto(url, { waitUntil: 'commit', timeout: CONFIG.defaultTimeout });
  } finally {
    session.navByTool = false;
  }

  const frames = [];
  for (let index = 0; index < total; index += 1) {
    const at = Date.now() - started;
    /* Снимок бывает невозможен в первые миллисекунды (документ ещё пуст) — это не ошибка серии. */
    const shot = await session.page.screenshot({ type: 'png', timeout: 5000 }).catch(() => null);
    if (shot) {
      const file = path.join(dir, `frame-${String(index + 1).padStart(2, '0')}-${at}ms.png`);
      await fs.writeFile(file, shot);
      frames.push({ index: index + 1, t: at, image: artifactRef(file) });
    } else {
      frames.push({ index: index + 1, t: at, skipped: true });
    }
    if (index + 1 < total) await new Promise((resolve) => setTimeout(resolve, step));
  }

  return {
    count: frames.length,
    stepMs: step,
    frames,
    note: t({
      ru: 'Кадры сняты с момента commit, без стабилизации и без ожидания load: t — миллисекунды от начала перехода. Финальное состояние и обычный ответ навигации — ниже, после отдельного стабилизирующего перехода с animations: "allow".',
      en: 'Frames are captured from commit, without stabilization and without waiting for load: t is milliseconds from the start of the navigation. The final state and the usual navigation answer follow below, after a separate stabilizing navigation with animations: "allow".',
    }),
  };
}
