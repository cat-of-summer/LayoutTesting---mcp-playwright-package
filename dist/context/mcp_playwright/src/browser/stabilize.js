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

export async function stabilize(page, { pseudoLoc = false, waitFonts = true, settleMs = 150 } = {}) {
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

  // Догоняем ленивые изображения: без прокрутки скриншот полной страницы часть их не увидит.
  await page
    .evaluate(async () => {
      const imgs = Array.from(document.images).filter((i) => !i.complete);
      await Promise.all(
        imgs.map(
          (img) =>
            new Promise((res) => {
              img.addEventListener('load', res, { once: true });
              img.addEventListener('error', res, { once: true });
              setTimeout(res, 3000);
            }),
        ),
      );
    })
    .catch(() => {});

  if (settleMs) await page.waitForTimeout(settleMs);
}
