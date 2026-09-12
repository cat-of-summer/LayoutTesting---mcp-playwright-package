/**
 * Поведение: что с чем связано в прототипе и во что это превращается в вёрстке.
 *
 * Прототип — единственное место, где написано, что кнопка «Откликнуться» открывает именно эту
 * модалку, шеврон переключает карточку в раскрытый вид, а стрелка внизу прокручивает к шапке. По
 * скриншотам это не восстановить, и в прошлый раз связи выяснялись догадками по именам кадров.
 *
 * Здесь связи собираются в граф и группируются по цели: «шесть шевронов → вариант 1038:11329» —
 * это один обработчик, а не шесть. Отдельно собирается то, что относится к поведению, но связями
 * не выражено: закреплённые при прокрутке слои, прокручиваемые области, ключевые кадры анимаций и
 * кадры, которые по имени выглядят состоянием, но ни с чем не связаны, — последние помечены как
 * неподтверждённые, чтобы их не выдавали за факт.
 */
import { clip, easingCss, visibleNodes } from './common.js';
import { round } from '../css.js';

/** Что действие прототипа значит для вёрстки. */
const MEANING = {
  'NODE:NAVIGATE': 'переход на другой экран: ссылка или маршрут',
  'NODE:OVERLAY': 'открывает оверлей: модальное окно',
  'NODE:SWAP': 'подменяет открытый оверлей другим',
  'NODE:SCROLL_TO': 'прокрутка к якорю на этой же странице',
  'NODE:CHANGE_TO': 'переключает вариант компонента: это состояние, а не новый блок',
  BACK: 'назад по истории',
  CLOSE: 'закрывает оверлей',
  URL: 'внешняя ссылка',
  SET_VARIABLE: 'меняет переменную Figma: состояние, которое в вёрстке держит класс или JS',
  SET_VARIABLE_MODE: 'переключает режим переменных: тема',
  CONDITIONAL: 'условие в прототипе: в вёрстке это ветвление в JS',
};

const TRANSITION_CSS = {
  DISSOLVE: 'opacity',
  SMART_ANIMATE: 'изменившиеся свойства',
  SCROLL_ANIMATE: 'scroll-behavior: smooth',
  MOVE_IN: 'transform',
  MOVE_OUT: 'transform',
  PUSH: 'transform',
  SLIDE_IN: 'transform',
  SLIDE_OUT: 'transform',
};

/** Триггеры, у которых в вёрстке есть прямое соответствие. */
const TRIGGER_CSS = {
  ON_HOVER: ':hover',
  MOUSE_ENTER: ':hover',
  MOUSE_LEAVE: 'уход курсора: снятие :hover',
  ON_PRESS: ':active',
  MOUSE_DOWN: ':active',
  ON_CLICK: 'click',
  AFTER_TIMEOUT: 'таймер',
  ON_DRAG: 'перетаскивание',
  ON_KEY_DOWN: 'клавиша',
};

const STATE_NAME = /hover|active|focus|disabled|open|close|expand|collapse|error|success|раскрыт|закрыт|модал|modal|навед|нажат|ошибк|успех/i;

function transitionOf(action) {
  const transition = action.transition;
  if (!transition) return undefined;
  const ms = Math.round((transition.duration || 0) * 1000);
  const easing = easingCss(transition.easing);
  return {
    type: transition.type,
    ...(transition.direction ? { direction: transition.direction } : {}),
    duration: `${ms}ms`,
    easing,
    css: `transition: ${TRANSITION_CSS[transition.type] || 'all'} ${ms}ms ${easing}`,
  };
}

function labelOf(snapshot, node) {
  if (node.type === 'TEXT') return clip(node.text?.chars, 40);
  const name = [node.component?.set, node.component?.name].filter(Boolean).join(' / ') || node.name;
  return clip(name, 40);
}

export function describeBehavior(frames, { lookup = null } = {}) {
  const names = new Map();
  for (const frame of frames) {
    for (const { node } of visibleNodes(frame.snapshot, frame.rootId)) names.set(node.id, { node, frame: frame.ref });
  }
  const nameOf = (id) => {
    const known = names.get(id);
    if (known) return labelOf(known.node, known.node);
    return lookup?.(id) ?? null;
  };

  const edges = [];
  const sticky = [];
  const scrollAreas = [];
  const motion = [];
  const candidates = [];

  for (const frame of frames) {
    for (const { node } of visibleNodes(frame.snapshot, frame.rootId)) {
      if (node.scrollBehavior) {
        sticky.push({
          id: node.id,
          name: clip(node.name, 40),
          behavior: node.scrollBehavior,
          css: node.scrollBehavior === 'FIXED' ? 'position: fixed' : 'position: sticky',
        });
      }
      if (node.overflow) {
        scrollAreas.push({ id: node.id, name: clip(node.name, 40), direction: node.overflow });
      }
      if (node.motion?.length) {
        motion.push({ id: node.id, name: clip(node.name, 40), tracks: node.motion.length });
      }
      if (!node.interactions?.length && STATE_NAME.test(`${node.name || ''}`)) {
        candidates.push({ id: node.id, name: clip(node.name, 40), frame: frame.ref });
      }

      for (const interaction of node.interactions || []) {
        for (const action of interaction.actions || []) {
          const key = action.type === 'NODE' ? `NODE:${action.navigation || 'NAVIGATE'}` : action.type;
          const destination = action.destinationId || null;
          edges.push({
            from: node.id,
            frame: frame.ref,
            label: labelOf(frame.snapshot, node),
            trigger: interaction.trigger?.type,
            ...(interaction.trigger?.timeout ? { timeout: `${Math.round(interaction.trigger.timeout * 1000)}ms` } : {}),
            handler: TRIGGER_CSS[interaction.trigger?.type] || interaction.trigger?.type,
            action: key,
            means: MEANING[key] || key,
            ...(destination ? { to: destination, toName: nameOf(destination) } : {}),
            ...(action.url ? { url: action.url } : {}),
            ...(names.get(destination)?.node.overlay ? { overlay: names.get(destination).node.overlay } : {}),
            ...(transitionOf(action) ? { transition: transitionOf(action) } : {}),
          });
        }
      }
    }
  }

  /* Шесть одинаковых шевронов, ведущих в один вариант, — это один обработчик, а не шесть. */
  const groups = new Map();
  for (const edge of edges) {
    const key = `${edge.trigger}|${edge.action}|${edge.to || edge.url || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        trigger: edge.trigger,
        handler: edge.handler,
        action: edge.action,
        means: edge.means,
        ...(edge.to ? { to: edge.to, toName: edge.toName } : {}),
        ...(edge.url ? { url: edge.url } : {}),
        ...(edge.overlay ? { overlay: edge.overlay } : {}),
        ...(edge.transition ? { transition: edge.transition } : {}),
        sources: [],
        count: 0,
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (group.sources.length < 6) group.sources.push({ id: edge.from, label: edge.label });
  }

  const states = [...groups.values()].filter((group) => group.action === 'NODE:CHANGE_TO');
  const overlays = [...groups.values()].filter((group) => group.action === 'NODE:OVERLAY' || group.action === 'NODE:SWAP');

  return {
    edges: edges.length,
    grouped: [...groups.values()].sort((a, b) => b.count - a.count),
    states,
    overlays,
    sticky,
    scrollAreas,
    motion,
    ...(candidates.length
      ? {
          unconfirmed: {
            note: 'Эти слои по имени похожи на состояние или модалку, но связей прототипа у них нет — проверьте у человека, прежде чем верстать поведение.',
            nodes: candidates.slice(0, 20),
          },
        }
      : {}),
  };
}
