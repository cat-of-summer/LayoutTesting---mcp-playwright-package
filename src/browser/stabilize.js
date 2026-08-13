/**
 * Приведение страницы к воспроизводимому состоянию перед снимком.
 * Без этого визуальная регрессия краснеет на каждом прогоне: анимации, ещё не
 * доехавшие шрифты и живые часы дают разные пиксели при одном и том же коде.
 */

const KILL_MOTION_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;

const PSEUDO_MAP = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ġ', h: 'ĥ', i: 'í', j: 'ĵ',
  k: 'ķ', l: 'ł', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ｑ', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ġ', H: 'Ĥ', I: 'Í', J: 'Ĵ',
  K: 'Ķ', L: 'Ł', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ',
  U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/**
 * Псевдолокализация: диакритика вскрывает проблемы с line-height и обрезкой,
 * удлинение на ~40% — переполнения кнопок и колонок при переводе.
 */
function pseudoLocalizeInPage() {
  const MAP = window.__LT_PSEUDO_MAP__;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (/^(script|style|noscript|code|pre)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const src = node.nodeValue;
    const accented = src.replace(/[a-zA-Z]/g, (ch) => MAP[ch] || ch);
    const pad = '·'.repeat(Math.max(1, Math.round(src.trim().length * 0.4)));
    node.nodeValue = `${accented}${pad}`;
  }
}

/** Правки, которые должны примениться до первого рендера. */
export async function applyProfileToPage(page, profile) {
  await page.addInitScript(
    ({ rtl, textZoom, freezeTime }) => {
      const apply = () => {
        if (rtl && document.documentElement) {
          document.documentElement.setAttribute('dir', 'rtl');
          document.documentElement.setAttribute('lang', 'ar');
        }
        if (textZoom && textZoom !== 100 && document.documentElement) {
          document.documentElement.style.fontSize = `${textZoom}%`;
        }
      };
      if (document.documentElement) apply();
      document.addEventListener('DOMContentLoaded', apply);

      if (freezeTime) {
        const fixed = new Date('2026-01-01T00:00:00Z').getTime();
        const RealDate = Date;
        // eslint-disable-next-line no-global-assign
        Date = class extends RealDate {
          constructor(...args) {
            super(...(args.length ? args : [fixed]));
          }
          static now() {
            return fixed;
          }
        };
        Math.random = () => 0.42;
      }
    },
    { rtl: !!profile.rtl, textZoom: profile.textZoom, freezeTime: !!profile.freezeTime },
  );
}

/** Троттлинг доступен только через CDP, то есть только в chromium. */
export async function applyThrottle(page, profile) {
  if (!profile?.throttle || profile.browser !== 'chromium') return false;
  const { network, cpu } = profile.throttle;
  const session = await page.context().newCDPSession(page);
  if (cpu) await session.send('Emulation.setCPUThrottlingRate', { rate: Number(cpu) });
  if (network) {
    const presets = {
      '3g': { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
      'slow-3g': { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
      '4g': { downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (9 * 1024 * 1024) / 8, latency: 60 },
    };
    const preset = typeof network === 'string' ? presets[network] : network;
    if (!preset) throw new Error(`Неизвестный профиль сети: ${network}`);
    await session.send('Network.emulateNetworkConditions', { offline: false, ...preset });
  }
  return true;
}

export async function stabilize(
  page,
  {
    pseudoLoc = false,
    waitFonts = true,
    settleMs = 150,
    imagesTimeoutMs = 5000,
    placeholders = true,
    placeholderSize = 1000,
  } = {},
) {
  await page.addStyleTag({ content: KILL_MOTION_CSS }).catch(() => {});

  if (pseudoLoc) {
    await page.evaluate((map) => {
      window.__LT_PSEUDO_MAP__ = map;
    }, PSEUDO_MAP);
    await page.evaluate(pseudoLocalizeInPage);
  }

  if (waitFonts) {
    await page
      .evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true))
      .catch(() => {});
  }

  const images = await loadLazyImages(page, imagesTimeoutMs);
  const stubbed = placeholders ? await placeholderBrokenMedia(page, { size: placeholderSize }) : null;
  const revealed = await revealAll(page);

  if (settleMs) await page.waitForTimeout(settleMs);

  return { images, stubbed, revealed };
}

/**
 * Подставляет заглушку вместо визуального содержимого, которое не доехало.
 *
 * Битая картинка схлопывает свою коробку до размера alt-текста, и вёрстка вокруг едет:
 * карточка становится ниже, сетка съезжает. Сравнивать такую страницу с макетом — значит
 * мерить не вёрстку, а доступность файлов. Заглушка возвращает коробке заявленный размер,
 * и разбор снова говорит про раскладку.
 *
 * Размер заглушке не вычисляем — его определяет браузер, и это принципиально. Заманчиво
 * прочитать getComputedStyle и взять оттуда ширину с высотой, но у битой картинки коробку
 * держит alt-текст: вычисленные размеры вернут именно его, то есть ровно ту схлопнутую
 * коробку, которую мы и пришли чинить.
 *
 * Поэтому подставляется квадрат заданного размера, а дальше работает обычный каскад:
 * есть атрибуты width/height — коробка станет по ним; заданы размеры стилями — по стилям;
 * не задано ничего — останется квадрат, и его пропорция станет пропорцией блока. Последний
 * случай — честная догадка: у не доехавшего файла собственных пропорций взять неоткуда.
 *
 * Факт подмены не прячем: сколько именно коробок подменено, возвращается наверх, а
 * битые картинки как были находкой навигации, так и остаются.
 */
export async function placeholderBrokenMedia(page, { size = 1000 } = {}) {
  return page
    .evaluate((side) => {
      const svg = `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">` +
          `<rect width="100%" height="100%" fill="#c9ced8"/>` +
          `<path d="M0 0L${side} ${side}M${side} 0L0 ${side}" stroke="#9aa3b2" stroke-width="2" fill="none"/>` +
          `</svg>`,
      )}`;

      const stubbed = { images: 0, videos: 0 };

      for (const img of Array.from(document.images)) {
        // complete + нулевая натуральная ширина — это и 404, и пустой src.
        if (!img.complete || img.naturalWidth !== 0) continue;
        // srcset перебил бы подставленный src, если его не убрать.
        img.removeAttribute('srcset');
        img.src = svg;
        img.dataset.ltPlaceholder = '';
        stubbed.images += 1;
      }

      for (const video of Array.from(document.querySelectorAll('video'))) {
        // networkState 3 — источник не найден; readyState 0 — ни кадра не загружено.
        const broken = video.networkState === 3 || (video.readyState === 0 && !video.poster);
        if (!broken) continue;
        video.poster = svg;
        video.dataset.ltPlaceholder = '';
        stubbed.videos += 1;
      }

      return stubbed;
    }, size)
    .catch(() => null);
}

/**
 * Проявляет блоки, которые появляются только при прокрутке.
 *
 * Второй «молчаливый» дефект съёмки после ленивых картинок: блок ниже сгиба спрятан в CSS
 * (`opacity: 0`), а показывает его наблюдатель пересечения. Событие load такую страницу не
 * ждёт, и fullPage выходит с пустыми местами, ничего об этом не сообщая. Дальше испорченный
 * кадр молча становится эталоном визуальной регрессии.
 *
 * Прокрутки самой по себе мало, ловушек две:
 *
 *  - наблюдатель ставится не в первом кадре (AOS.init внутри setTimeout), и проход,
 *    выполненный раньше, не проявит ничего — поэтому на каждом шаге ждём пару кадров
 *    и даём микропаузу, а перед началом отпускаем поток на задержку инициализации;
 *  - библиотеки с `once: false` прячут блок обратно, когда он уходит из вида, поэтому
 *    возврат наверх снял бы результат прохода — то, что проявилось, закрепляем инлайном.
 *
 * Закрепляем только те узлы, которые проход действительно изменил: подменять стили всем
 * подряд значило бы рисовать в кадре то, чего на странице нет.
 */
export async function revealAll(page, { initDelayMs = 200, maxCandidates = 3000 } = {}) {
  return page
    .evaluate(
      async ({ initDelay, maxNodes }) => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const hiddenNow = (el) => {
          const s = getComputedStyle(el);
          return Number(s.opacity) === 0 || s.visibility === 'hidden';
        };

        // Даём инициализироваться наблюдателям, поставленным с задержкой.
        await new Promise((r) => setTimeout(r, initDelay));

        const candidates = Array.from(document.body ? document.body.querySelectorAll('*') : [])
          .filter(hiddenNow)
          .slice(0, maxNodes);

        if (!candidates.length) return { candidates: 0, revealed: 0, pinned: 0 };

        const startY = window.scrollY;
        const step = Math.max(200, Math.round(window.innerHeight * 0.8));
        const height = () => document.documentElement.scrollHeight;

        /*
         * Снимать состояние в конце прохода нельзя: блок, показанный в середине, к концу
         * уже уедет из вида и библиотека с `once: false` успеет спрятать его обратно.
         * Поэтому отмечаем проявившихся на каждом шаге, а отмеченных больше не опрашиваем —
         * список тает по ходу, и лишних вычислений стиля не набирается.
         */
        const shown = [];
        let waiting = candidates;
        const collect = () => {
          const rest = [];
          for (const el of waiting) {
            if (hiddenNow(el)) rest.push(el);
            else shown.push(el);
          }
          waiting = rest;
        };

        for (let y = 0; y < height(); y += step) {
          window.scrollTo(0, y);
          await frame();
          await new Promise((r) => setTimeout(r, 30));
          collect();
        }
        window.scrollTo(0, height());
        await frame();
        await new Promise((r) => setTimeout(r, 30));
        collect();

        window.scrollTo(0, startY);
        await frame();

        // …и возвращаем тем, кого спрятали обратно.
        let pinned = 0;
        for (const el of shown) {
          if (!hiddenNow(el)) continue;
          el.style.setProperty('opacity', '1', 'important');
          el.style.setProperty('visibility', 'visible', 'important');
          el.style.setProperty('transform', 'none', 'important');
          pinned += 1;
        }

        return { candidates: candidates.length, revealed: shown.length, pinned };
      },
      { initDelay: initDelayMs, maxNodes: maxCandidates },
    )
    .catch(() => null);
}

/**
 * Догружает ленивые изображения перед снимком.
 *
 * Ждать `load` мало: у картинки с `loading="lazy"` ниже сгиба загрузка вообще не начата,
 * событие не придёт никогда, и ожидание просто истечёт по таймауту — в кадр попадёт пустая
 * рамка. Поэтому сначала снимаем ленивость и прокручиваем документ, чтобы браузер сам
 * запустил загрузку, и только потом ждём.
 *
 * Возвращает сводку: сколько не доехало и сколько битых — молча пустой кадр хуже,
 * чем кадр с честной пометкой.
 */
export async function loadLazyImages(page, timeoutMs = 5000) {
  return page
    .evaluate(async (timeout) => {
      const imgs = Array.from(document.images);

      for (const img of imgs) {
        img.loading = 'eager';
        img.removeAttribute('loading');
        img.decoding = 'sync';
        if ('fetchPriority' in img) img.fetchPriority = 'high';
      }

      // Прокрутка нужна и после снятия loading: часть скриптов подставляет настоящий
      // src по IntersectionObserver, и без появления в кадре он не подставится.
      const startY = window.scrollY;
      const step = Math.max(200, window.innerHeight);
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(r));
      }
      window.scrollTo(0, startY);

      const pending = imgs.filter((i) => !i.complete);
      await Promise.all(
        pending.map(
          (img) =>
            new Promise((res) => {
              img.addEventListener('load', res, { once: true });
              img.addEventListener('error', res, { once: true });
              setTimeout(res, timeout);
            }),
        ),
      );

      const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).length;
      return { total: imgs.length, stillPending: imgs.filter((i) => !i.complete).length, broken };
    }, timeoutMs)
    .catch(() => null);
}
