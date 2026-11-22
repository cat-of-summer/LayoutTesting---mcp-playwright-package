/**
 * Съёмка анимации по кадрам: настоящий плеер прототипа Figma и страница на тех же моментах.
 *
 * Снимать в реальном времени нельзя: скриншот в контейнере с программным WebGL занимает сотни
 * миллисекунд, и переход на 700 мс дал бы два-три случайных кадра. Поэтому время страницы ведёт
 * стенд — page.clock подменяет requestAnimationFrame, таймеры и performance.now. Плеер Figma рисует
 * по этим часам: на паузе кадр не меняется, а runFor двигает анимацию ровно на заданный шаг, как бы
 * долго ни шёл сам снимок.
 *
 * CSS-переходы часам не подчиняются, они идут по таймлайну документа. На странице они ставятся на
 * паузу и выставляются через currentTime; JS-анимации (GSAP) идут по подменённому rAF.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { artifactRef, newRunId, runDir } from '../artifacts.js';
import { gotoAndSettle, withSession } from '../browser/pool.js';
import { pixelChange } from '../checks/interaction.js';
import { DESKTOP_UA, savedEditorState } from './editor.js';
import { contactSheet } from './export.js';

const READY_MS = 45_000;
const STEP_SETTLE_MS = 90;
const CHANGED = 0.0005;

export const protoUrl = (fileKey, frameId) => {
  const node = encodeURIComponent(frameId.replace(/:/g, '-'));
  return `https://www.figma.com/proto/${encodeURIComponent(fileKey)}/?node-id=${node}&starting-point-node-id=${node}&scaling=min-zoom&hide-ui=1`;
};

/**
 * Поставить часы страницы на паузу.
 *
 * Момент паузы считается в странице, а применяется следующим вызовом: пока он идёт, занятая
 * страница успевает уйти вперёд, и Playwright отвечает "Cannot fast-forward to the past". Запас
 * растёт с каждой попыткой; перемотка на него безвредна, страница в это время стоит в покое.
 */
export async function pauseClock(page, margins = [400, 1500, 5000]) {
  let failure = null;
  for (const margin of margins) {
    try {
      await page.clock.pauseAt(await page.evaluate((ms) => Date.now() + ms, margin));
      return;
    } catch (err) {
      if (!/past/i.test(err.message)) throw err;
      failure = err;
    }
  }
  throw failure;
}

/** Точка и прокрутка, при которых узел виден в окне плеера. Плеер кладёт кадр от верхнего края. */
export function playerLayout(frameBox, nodeBox, { maxHeight = 1200 } = {}) {
  const width = Math.max(320, Math.round(frameBox.w));
  const height = Math.max(600, Math.min(maxHeight, Math.round(nodeBox.h) + 40));
  const left = Math.round(nodeBox.x - frameBox.x);
  const top = Math.round(nodeBox.y - frameBox.y);
  const maxScroll = Math.max(0, Math.round(frameBox.h) - height);
  const scroll = Math.min(maxScroll, Math.max(0, top - Math.max(0, Math.round((height - nodeBox.h) / 2))));
  const y = top - scroll;
  const clip = {
    x: Math.max(0, left),
    y: Math.max(0, y),
    width: Math.min(width - Math.max(0, left), Math.round(nodeBox.w)),
    height: Math.min(height - Math.max(0, y), Math.round(nodeBox.h)),
  };
  return { viewport: `${width}x${height}`, scroll, clip, point: { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 } };
}

/** Моменты съёмки: кадры перехода и один за его концом, чтобы было видно, что движение кончилось. */
export const shootTimes = (times, fps) => [...times, Math.round(times.at(-1) + 1000 / fps)];

/** Когда кадр действительно менялся: первая и последняя смена по соседним снимкам. */
export function measuredChange(times, changes) {
  let first = null;
  let last = null;
  changes.forEach((value, index) => {
    if (value <= CHANGED) return;
    first ??= times[index];
    last = times[index + 1];
  });
  return first === null ? { moved: false } : { moved: true, firstChangeMs: first, lastChangeMs: last };
}

/** Кадры в файлы и контакт-лист; в ответ только адреса и замер. */
async function writeFrames(shots, times, dir, name) {
  const tiles = [];
  for (const [index, shot] of shots.entries()) {
    const file = path.join(dir, `${name}-${String(index).padStart(3, '0')}-${times[index]}ms.png`);
    await fs.writeFile(file, shot);
    tiles.push({ id: `${times[index]}ms`, name: '', file });
  }
  const changes = [];
  for (let index = 1; index < shots.length; index += 1) changes.push((await pixelChange(shots[index - 1], shots[index])) ?? 0);
  const sheet = path.join(dir, `${name}.sheet.png`);
  await contactSheet(tiles, sheet, { thumb: 320, columns: 4 });
  return { frames: tiles.length, first: artifactRef(tiles[0].file).uri, sheet: artifactRef(sheet), measured: measuredChange(times, changes) };
}

/** Плеер загрузился: два одинаковых кадра подряд, и на них не только заставка. */
async function waitPlayer(page) {
  const started = Date.now();
  let previous = null;
  await page.waitForSelector('canvas', { timeout: READY_MS });
  while (Date.now() - started < READY_MS) {
    await page.waitForTimeout(1000);
    const shot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!shot) continue;
    const { channels } = await sharp(shot).stats();
    const varied = channels.some((channel) => channel.stdev > 12);
    if (varied && previous && Date.now() - started > 4000 && (await pixelChange(previous, shot)) === 0) return true;
    previous = shot;
  }
  return false;
}

/* Подписи интерфейса Figma поверх холста: баннер cookie, подсказка про аппаратное ускорение. */
function hidePlayerChrome() {
  const canvas = document.querySelector('canvas');
  for (const el of document.body.querySelectorAll('*')) {
    if (el.contains(canvas) || canvas?.contains(el)) continue;
    const style = getComputedStyle(el);
    if (!/fixed|absolute/.test(style.position) || !(el.innerText || '').trim()) continue;
    el.style.setProperty('visibility', 'hidden', 'important');
  }
}

/**
 * Снять переходы в плеере. segments: [{ times, trigger }] — шаги цепочки по порядку.
 *
 * Таймаут в прототипе отсчитывается от входа в состояние и истекает, пока плеер грузится, поэтому
 * такой переход снять нельзя: для него остаются числовые треки, и ответ называет причину.
 */
export async function captureProto({ fileKey, frameId, frameBox, nodeBox, segments, fps }) {
  const layout = playerLayout(frameBox, nodeBox);
  const storageState = await savedEditorState();
  const dir = await runDir(newRunId('motion-player'));
  return withSession(
    { viewport: layout.viewport, userAgent: DESKTOP_UA, animations: 'allow', ...(storageState ? { storageState } : {}) },
    async (session) => {
      const { page } = session;
      await page.clock.install();
      await page.goto(protoUrl(fileKey, frameId), { waitUntil: 'load', timeout: 60_000 });
      if (!(await waitPlayer(page))) return { error: 'Плеер прототипа не загрузился за 45 с: файл недоступен аккаунту стенда или кадр не открывается в прототипе.' };
      await page.getByRole('button', { name: /Do not allow/i }).click({ timeout: 1500 }).catch(() => {});
      await page.evaluate(hidePlayerChrome);
      await page.mouse.move(layout.point.x, layout.point.y);
      if (layout.scroll) {
        await page.mouse.wheel(0, layout.scroll);
        await page.waitForTimeout(1200);
      }
      await pauseClock(page);
      await page.waitForTimeout(250);

      const out = [];
      for (const [index, segment] of segments.entries()) {
        if (!['ON_CLICK', 'ON_HOVER', 'MOUSE_ENTER', 'ON_PRESS', 'MOUSE_DOWN'].includes(segment.trigger)) {
          out.push({ skipped: `триггер ${segment.trigger} в плеере не воспроизвести: остаются числовые треки` });
          break;
        }
        const times = shootTimes(segment.times, fps);
        const shots = [await page.screenshot({ type: 'png', clip: layout.clip })];
        if (/HOVER|ENTER/.test(segment.trigger)) {
          await page.mouse.move(1, 1);
          await page.mouse.move(layout.point.x, layout.point.y);
        } else {
          await page.mouse.click(layout.point.x, layout.point.y);
        }
        await page.waitForTimeout(STEP_SETTLE_MS);
        for (let at = 1; at < times.length; at += 1) {
          await page.clock.runFor(times[at] - times[at - 1]);
          await page.waitForTimeout(STEP_SETTLE_MS);
          shots.push(await page.screenshot({ type: 'png', clip: layout.clip }));
        }
        out.push(await writeFrames(shots, times, dir, `step-${index + 1}`));
        /* Дать переходу доиграть, если он длиннее снятого: следующий шаг начнётся из покоя. */
        await page.clock.runFor(200);
        await page.waitForTimeout(STEP_SETTLE_MS);
      }
      return { clock: 'virtual', segments: out };
    },
  );
}

/** Выставить все конечные анимации документа на момент elapsed от их появления. */
function seekAnimationsInPage(elapsed) {
  const seen = (window.__ltMotionSeen ||= new WeakMap());
  for (const animation of document.getAnimations()) {
    const timing = animation.effect?.getComputedTiming?.();
    if (!timing || !Number.isFinite(timing.endTime)) continue;
    if (!seen.has(animation)) seen.set(animation, elapsed);
    animation.pause();
    animation.currentTime = Math.max(0, elapsed - seen.get(animation));
  }
}

/** Положение и итоговая прозрачность элементов с текстами из макета. */
function sampleTextsInPage({ selector, texts }) {
  const root = (selector && document.querySelector(selector)) || document.body;
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!window.__ltMotionEls) {
    const wanted = new Set(texts.map(norm));
    const found = new Map();
    for (const el of root.querySelectorAll('*')) {
      const own = norm(Array.from(el.childNodes).filter((node) => node.nodeType === 3).map((node) => node.nodeValue).join(' '));
      if (own && wanted.has(own) && !found.has(own)) found.set(own, el);
    }
    window.__ltMotionEls = [...found.entries()];
  }
  const origin = root.getBoundingClientRect();
  return window.__ltMotionEls.map(([text, el]) => {
    const rect = el.getBoundingClientRect();
    let opacity = 1;
    for (let node = el; node && node !== root.parentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
    return { text, selector: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, x: rect.x - origin.x, y: rect.y - origin.y, opacity };
  });
}

async function firePageTrigger(page, trigger, triggerSelector) {
  const target = triggerSelector ? page.locator(triggerSelector).first() : null;
  if (trigger === 'scroll') {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'instant' }), triggerSelector);
    return;
  }
  if (!target) throw new Error('Для триггера click и hover нужен triggerSelector.');
  await target.scrollIntoViewIfNeeded({ timeout: 3000 });
  if (trigger === 'hover') await target.hover({ timeout: 3000, force: true });
  else await target.click({ timeout: 3000, force: true });
}

/**
 * Снять страницу на тех же моментах, что и макет.
 *
 * Своя сессия: часы ставятся до загрузки страницы, в открытую сессию их не подключить.
 */
export async function capturePage({ url, selector, trigger = 'click', triggerSelector, segments, fps, width, texts }) {
  const dir = await runDir(newRunId('motion-page'));
  return withSession({ viewport: `${Math.max(320, Math.round(width || 1440))}x900`, animations: 'allow' }, async (session) => {
    const { page } = session;
    await page.clock.install();
    await gotoAndSettle(session, url, { stabilizePage: false });
    await page.evaluate(() => document.fonts?.ready.then(() => true));
    if (selector) await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await pauseClock(page);

    const shoot = async () => {
      const element = selector ? page.locator(selector).first() : null;
      const box = element ? await element.boundingBox() : null;
      const viewport = page.viewportSize();
      const clip = box
        ? {
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: Math.max(1, Math.min(viewport.width - Math.max(0, box.x), box.width)),
            height: Math.max(1, Math.min(viewport.height - Math.max(0, box.y), box.height)),
          }
        : undefined;
      return page.screenshot({ type: 'png', ...(clip ? { clip } : {}) });
    };

    const out = [];
    for (const [index, segment] of segments.entries()) {
      const times = shootTimes(segment.times, fps);
      await page.evaluate(() => {
        delete window.__ltMotionEls;
      });
      const shots = [];
      const samples = [];
      /* Положение до действия — нулевой кадр: триггер меняет его уже первым событием. */
      samples.push(await page.evaluate(sampleTextsInPage, { selector, texts: segment.texts ?? texts }));
      shots.push(await shoot());
      await firePageTrigger(page, trigger, triggerSelector);
      await page.evaluate(seekAnimationsInPage, 0);
      for (let at = 1; at < times.length; at += 1) {
        await page.clock.runFor(times[at] - times[at - 1]);
        await page.evaluate(seekAnimationsInPage, times[at]);
        await page.waitForTimeout(30);
        samples.push(await page.evaluate(sampleTextsInPage, { selector, texts: segment.texts ?? texts }));
        shots.push(await shoot());
      }
      const written = await writeFrames(shots, times, dir, `step-${index + 1}`);
      const count = segment.times.length;
      const elements = (samples[0] || []).map((element, position) => ({
        text: element.text,
        selector: element.selector,
        x: samples.slice(0, count).map((frame) => frame[position]?.x ?? element.x),
        y: samples.slice(0, count).map((frame) => frame[position]?.y ?? element.y),
        opacity: samples.slice(0, count).map((frame) => frame[position]?.opacity ?? element.opacity),
      }));
      out.push({ ...written, elements });
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.finish?.();
      }).catch(() => {});
      await page.clock.runFor(200);
    }
    return { clock: 'virtual', segments: out };
  });
}
