/**
 * Анимация макета по кадрам: числовые треки перехода и их сверка со страницей.
 *
 * figma_behavior говорит «Smart Animate 700 ms ease-out», но не говорит, что именно едет: на
 * ТОПГАН траекторию спирали и ритм появления придумали, потому что посмотреть движение было негде.
 * Здесь переход раскладывается на треки: слой, свойство, откуда, куда и значение в каждом кадре.
 * Числа дешевле картинок и сравниваются со страницей напрямую, а настоящие кадры снимает плеер.
 *
 * Слои сопоставляются так же, как это делает Smart Animate: по имени и месту в иерархии.
 */
import { colorCss, round } from './css.js';
import { clip, easingCss } from './analyze/common.js';

const BEZIERS = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

const SPRINGS = {
  GENTLE: { mass: 1, stiffness: 100, damping: 15 },
  QUICK: { mass: 1, stiffness: 300, damping: 20 },
  BOUNCY: { mass: 1, stiffness: 600, damping: 15 },
  SLOW: { mass: 1, stiffness: 80, damping: 20 },
};

/** Кривая Безье как функция прогресса: x решается Ньютоном, в плоских местах — делением. */
export function cubicBezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  const slope = (a, b, t) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t ** 2;
  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    let t = progress;
    for (let i = 0; i < 8; i += 1) {
      const error = at(x1, x2, t) - progress;
      if (Math.abs(error) < 1e-5) return at(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= error / d;
    }
    let low = 0;
    let high = 1;
    t = progress;
    for (let i = 0; i < 30; i += 1) {
      const value = at(x1, x2, t);
      if (Math.abs(value - progress) < 1e-5) break;
      if (value < progress) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return at(y1, y2, t);
  };
}

/** Пружина от 0 к 1: положение через seconds секунд. */
export function springAt({ mass, stiffness, damping }, seconds) {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta ** 2);
    return 1 - Math.exp(-zeta * omega * seconds) * (Math.cos(damped * seconds) + ((zeta * omega) / damped) * Math.sin(damped * seconds));
  }
  if (zeta === 1) return 1 - Math.exp(-omega * seconds) * (1 + omega * seconds);
  const root = omega * Math.sqrt(zeta ** 2 - 1);
  const r1 = -zeta * omega + root;
  const r2 = -zeta * omega - root;
  return 1 - (r2 * Math.exp(r1 * seconds) - r1 * Math.exp(r2 * seconds)) / (r2 - r1);
}

/**
 * Кривая перехода Figma → функция прогресса. approximate: true у пружин: их точную форму знает
 * только плеер, числа здесь — физическая модель с теми же массой, жёсткостью и затуханием.
 */
export function easingFn(easing, durationMs = 300) {
  if (easing?.easingFunctionCubicBezier) {
    const { x1, y1, x2, y2 } = easing.easingFunctionCubicBezier;
    return { fn: cubicBezier(x1, y1, x2, y2), approximate: false };
  }
  const spring = easing?.easingFunctionSpring || SPRINGS[easing?.type];
  if (spring) {
    const seconds = durationMs / 1000;
    return { fn: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : springAt(spring, p * seconds)), approximate: true };
  }
  const known = BEZIERS[easing?.type];
  if (known) return { fn: cubicBezier(...known), approximate: false };
  return { fn: (p) => p, approximate: true };
}

/** Моменты кадров, мс: от нуля с шагом кадра, последний — ровно конец перехода. */
export function frameTimes(durationMs, fps) {
  const step = 1000 / fps;
  const out = [];
  for (let i = 0; i * step < durationMs - 0.5; i += 1) out.push(Math.round(i * step));
  out.push(Math.round(durationMs));
  return out;
}

/** Видимые слои под корнем: ключ — путь имён с номером среди одноимённых соседей. */
export function layerMap(snapshot, rootId) {
  const root = snapshot.nodes[rootId];
  const origin = root?.box ? { x: root.box.x, y: root.box.y } : { x: 0, y: 0 };
  const out = new Map();
  const walk = (node, prefix) => {
    const seen = new Map();
    for (const id of node.children || []) {
      const kid = snapshot.nodes[id];
      if (!kid || kid.visible === false) continue;
      const index = seen.get(kid.name) || 0;
      seen.set(kid.name, index + 1);
      const key = `${prefix}/${kid.name}#${index}`;
      if (kid.box) {
        const solid = kid.fills?.find((paint) => paint.kind === 'solid');
        out.set(key, {
          id: kid.id,
          name: kid.name,
          ...(kid.type === 'TEXT' && kid.text?.chars ? { text: kid.text.chars } : {}),
          props: {
            x: round(kid.box.x - origin.x),
            y: round(kid.box.y - origin.y),
            width: round(kid.box.w),
            height: round(kid.box.h),
            opacity: kid.opacity ?? 1,
            rotation: kid.rotation ?? 0,
            ...(typeof kid.radius === 'number' ? { radius: kid.radius } : {}),
          },
          ...(solid ? { color: solid.color } : {}),
        });
      }
      walk(kid, key);
    }
  };
  if (root) walk(root, '');
  return out;
}

const mix = (a, b, k) => a + (b - a) * k;
const mixColor = (a, b, k) => ({
  r: Math.round(mix(a.r, b.r, k)),
  g: Math.round(mix(a.g, b.g, k)),
  b: Math.round(mix(a.b, b.b, k)),
  a: round(mix(a.a ?? 1, b.a ?? 1, k), 3),
});
const sameColor = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b && (a.a ?? 1) === (b.a ?? 1);

/* Заметность изменения: чтобы в урезанном списке остались главные треки, а не сдвиг на пиксель. */
const WEIGHT = { opacity: 200, rotation: 2, x: 1, y: 1, width: 1, height: 1, radius: 1 };

/**
 * Треки перехода между двумя состояниями.
 *
 * Слой, которого нет в одном из состояний, Smart Animate растворяет: это трек opacity с пометкой
 * appears или disappears, а не отсутствие анимации.
 */
export function motionTracks(from, to, transition = {}, { fps = 12, limit = 40 } = {}) {
  const durationMs = Math.round((transition.duration ?? 0.3) * 1000);
  const { fn, approximate } = easingFn(transition.easing, durationMs);
  const times = frameTimes(durationMs, fps);
  const progress = times.map((time) => fn(durationMs ? time / durationMs : 1));
  const before = layerMap(from.snapshot, from.rootId);
  const after = layerMap(to.snapshot, to.rootId);
  const tracks = [];
  const number = (value, property) => round(value, property === 'opacity' ? 3 : 2);
  const push = (layer, property, a, b, extra = {}) => {
    tracks.push({
      layer: clip(layer.name, 40),
      node: layer.id,
      ...(layer.text ? { text: clip(layer.text, 40), fullText: layer.text } : {}),
      property,
      from: number(a, property),
      to: number(b, property),
      values: progress.map((k) => number(mix(a, b, k), property)),
      weight: Math.abs(b - a) * (WEIGHT[property] ?? 1),
      ...extra,
    });
  };

  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) {
      push(was, 'opacity', was.props.opacity, 0, { disappears: true });
      continue;
    }
    for (const [property, value] of Object.entries(was.props)) {
      const target = now.props[property];
      if (target === undefined || target === value) continue;
      push(now, property, value, target);
    }
    if (was.color && now.color && !sameColor(was.color, now.color)) {
      tracks.push({
        layer: clip(now.name, 40),
        node: now.id,
        ...(now.text ? { text: clip(now.text, 40), fullText: now.text } : {}),
        property: 'color',
        from: colorCss(was.color),
        to: colorCss(now.color),
        values: progress.map((k) => colorCss(mixColor(was.color, now.color, k))),
        weight: 40,
      });
    }
  }
  for (const [key, now] of after) {
    if (!before.has(key)) push(now, 'opacity', 0, now.props.opacity, { appears: true });
  }

  tracks.sort((a, b) => b.weight - a.weight);
  return {
    type: transition.type ?? null,
    durationMs,
    easing: easingCss(transition.easing),
    ...(approximate ? { approximate: true } : {}),
    fps,
    times,
    layers: { from: before.size, to: after.size },
    tracksTotal: tracks.length,
    tracks: tracks.slice(0, limit).map(({ weight, ...track }) => track),
    ...(tracks.length > limit ? { note: `Показано ${limit} треков из ${tracks.length}, самые заметные. Остальные - с большим limit.` } : {}),
  };
}

const key = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Сверка движения страницы с треками макета.
 *
 * Сравниваются не абсолютные координаты, а отклонение от конечного положения: иначе любой сдвиг
 * блока в вёрстке читался бы как ошибка анимации. Слои сопоставляются по тексту: это единственное,
 * что одинаково названо в макете и в DOM.
 */
export function compareMotion(design, samples, { tolerance = 4, opacityTolerance = 0.12 } = {}) {
  const elements = new Map(samples.elements.map((element) => [key(element.text), element]));
  const diffs = [];
  const compared = new Set();
  for (const track of design.tracks) {
    if (!track.text || !['x', 'y', 'opacity'].includes(track.property)) continue;
    /* В ответе текст обрезан, а сопоставлять надо по полному: начала абзацев бывают одинаковыми. */
    const wanted = key(track.fullText ?? track.text);
    const element = elements.get(wanted);
    const series = element?.[track.property];
    if (!series) continue;
    compared.add(wanted);
    const limit = track.property === 'opacity' ? opacityTolerance : tolerance;
    const designEnd = track.values.at(-1);
    const pageEnd = series.at(-1);
    let worst = 0;
    let worstAt = null;
    for (let i = 0; i < Math.min(series.length, track.values.length); i += 1) {
      const delta = track.property === 'opacity' ? series[i] - track.values[i] : series[i] - pageEnd - (track.values[i] - designEnd);
      if (Math.abs(delta) > Math.abs(worst)) {
        worst = delta;
        worstAt = design.times[i];
      }
    }
    if (Math.abs(worst) > limit) {
      diffs.push({
        layer: track.layer,
        text: track.text,
        selector: element.selector,
        property: track.property,
        maxDelta: round(worst, track.property === 'opacity' ? 2 : 1),
        atMs: worstAt,
      });
    }
  }
  diffs.sort((a, b) => Math.abs(b.maxDelta) - Math.abs(a.maxDelta));
  const designText = new Set(design.tracks.filter((track) => track.text).map((track) => key(track.fullText ?? track.text)));
  const notOnPage = [...designText].filter((text) => !compared.has(text)).map((text) => clip(text, 40));
  return {
    match: diffs.length === 0 && compared.size > 0,
    compared: compared.size,
    diffs,
    ...(notOnPage.length ? { notOnPage: notOnPage.slice(0, 10) } : {}),
    ...(compared.size ? {} : { note: 'Ни один движущийся текст макета не нашёлся на странице: сверять движение не по чему.' }),
  };
}
