/**
 * «Почему элемента не видно» и «кто лежит сверху».
 *
 * Порядок отрисовки — единственное место в CSS, где вычисленные стили не отвечают
 * на вопрос: z-index может ничего не значить (на static-элементе), считаться не там,
 * где кажется (внутри чужого стек-контекста), или проигрывать соседу, у которого
 * значение то же самое, но он ниже по документу.
 *
 * Здесь это собрано в один ответ: свойства самого элемента, цепочка стек-контекстов
 * над ним, соседи по слоям и то, что реально отрисовано в его точках.
 */

function collectLayers({ selector, pseudo, maxItems }) {
  const shortPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
      if (cls) part += `.${CSS.escape(cls)}`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const alpha = (color) => {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return 0;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return parts.length > 3 ? parts[3] : 1;
  };

  const isOpaque = (el) => {
    if (/^(img|video|canvas|iframe)$/i.test(el.tagName)) return true;
    const s = getComputedStyle(el);
    if (s.backgroundImage && s.backgroundImage !== 'none' && !s.backgroundImage.includes('gradient')) return true;
    return alpha(s.backgroundColor) > 0.9;
  };

  /** Что именно создаёт стек-контекст — важнее самого факта: чинить надо причину. */
  const stackingReason = (el, s) => {
    if (el === document.documentElement) return 'корневой элемент';
    if (s.position === 'fixed' || s.position === 'sticky') return `position: ${s.position}`;
    if (s.position !== 'static' && s.zIndex !== 'auto') return `position: ${s.position} + z-index: ${s.zIndex}`;
    if (Number(s.opacity) < 1) return `opacity: ${s.opacity}`;
    if (s.transform !== 'none') return 'transform';
    if (s.filter !== 'none') return 'filter';
    if (s.backdropFilter && s.backdropFilter !== 'none') return 'backdrop-filter';
    if (s.perspective && s.perspective !== 'none') return 'perspective';
    if (s.mixBlendMode && s.mixBlendMode !== 'normal') return `mix-blend-mode: ${s.mixBlendMode}`;
    if (s.isolation === 'isolate') return 'isolation: isolate';
    if (s.willChange && /transform|opacity|filter/.test(s.willChange)) return `will-change: ${s.willChange}`;
    if (s.contain && /layout|paint|strict|content/.test(s.contain)) return `contain: ${s.contain}`;
    const parent = el.parentElement;
    if (parent && s.zIndex !== 'auto') {
      const ps = getComputedStyle(parent);
      if (/flex|grid/.test(ps.display)) return `элемент ${ps.display}-контейнера + z-index: ${s.zIndex}`;
    }
    return null;
  };

  /**
   * Слой в порядке отрисовки внутри одного стек-контекста — по CSS 2.1 Appendix E.
   * Чем больше число, тем позже красится, то есть тем выше элемент.
   */
  const paintLayer = (el, s) => {
    const z = s.zIndex === 'auto' ? null : Number(s.zIndex);
    const positioned = s.position !== 'static';
    const parent = el.parentElement;
    const flexItem = parent && /flex|grid/.test(getComputedStyle(parent).display);
    if ((positioned || flexItem) && z !== null && z < 0) return { layer: 0, z, why: 'отрицательный z-index' };
    if (!positioned && !flexItem) {
      if (s.float !== 'none') return { layer: 3, z: null, why: 'float' };
      if (/inline/.test(s.display)) return { layer: 4, z: null, why: 'строчный' };
      return { layer: 1, z: null, why: 'блок в потоке' };
    }
    if (z === null || z === 0) return { layer: 5, z: z ?? 'auto', why: positioned ? 'позиционирован, z-index auto/0' : 'элемент flex/grid, z-index auto/0' };
    return { layer: 6, z, why: `z-index: ${z}` };
  };

  const el = document.querySelector(selector);
  if (!el) return { found: false, selector };

  const style = getComputedStyle(el);
  const pseudoStyle = pseudo ? getComputedStyle(el, pseudo) : null;
  const rect = el.getBoundingClientRect();
  const box = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };

  const own = pseudoStyle || style;
  const layer = pseudoStyle
    ? { layer: pseudoStyle.position === 'static' ? 1 : Number(pseudoStyle.zIndex) > 0 ? 6 : 5, z: pseudoStyle.zIndex, why: `псевдоэлемент, position: ${pseudoStyle.position}, z-index: ${pseudoStyle.zIndex}` }
    : paintLayer(el, style);

  const warnings = [];
  if (own.zIndex !== 'auto' && own.position === 'static') {
    const parent = el.parentElement;
    const flexItem = parent && /flex|grid/.test(getComputedStyle(parent).display);
    if (!flexItem) {
      warnings.push({
        kind: 'deadZIndex',
        message: `z-index: ${own.zIndex} задан, но не действует: position: static. Свойство применяется только к позиционированным элементам и к элементам flex/grid-контейнера.`,
      });
    }
  }
  if (pseudo && (!pseudoStyle || pseudoStyle.content === 'none')) {
    warnings.push({ kind: 'noPseudo', message: `Псевдоэлемент ${pseudo} не создан: нет content.` });
  }
  if (own.position !== 'static' && own.zIndex !== 'auto' && Number(own.zIndex) > 0) {
    // z-index соревнуется только внутри ближайшего стек-контекста, а не по всей странице.
    const scAncestor = (() => {
      let node = el.parentElement;
      while (node) {
        const s = getComputedStyle(node);
        if (stackingReason(node, s)) return { el: node, reason: stackingReason(node, s) };
        node = node.parentElement;
      }
      return null;
    })();
    if (scAncestor && scAncestor.el !== document.documentElement) {
      warnings.push({
        kind: 'scopedZIndex',
        message: `z-index: ${own.zIndex} считается внутри ${shortPath(scAncestor.el)} (${scAncestor.reason}), а не относительно всей страницы.`,
      });
    }
  }

  // Цепочка стек-контекстов над элементом.
  const chain = [];
  let node = el.parentElement;
  while (node && chain.length < 8) {
    const s = getComputedStyle(node);
    const reason = stackingReason(node, s);
    if (reason) chain.push({ selector: shortPath(node), reason, zIndex: s.zIndex, position: s.position });
    node = node.parentElement;
  }

  // Соседи по слоям внутри ближайшего стек-контекста.
  const scope = (() => {
    let n = el.parentElement;
    while (n) {
      const s = getComputedStyle(n);
      if (stackingReason(n, s)) return n;
      n = n.parentElement;
    }
    return document.documentElement;
  })();

  const intersects = (r) => r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
  const neighbours = [];
  for (const other of Array.from(scope.querySelectorAll('*'))) {
    if (other === el || el.contains(other) || other.contains(el)) continue;
    const r = other.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || !intersects(r)) continue;
    const s = getComputedStyle(other);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
    const l = paintLayer(other, s);
    if (l.layer < 5 && !stackingReason(other, s)) continue; // фон и текст в потоке — не «слой»
    neighbours.push({
      selector: shortPath(other),
      layer: l.layer,
      zIndex: String(l.z),
      position: s.position,
      opaque: isOpaque(other),
      pointerEvents: s.pointerEvents,
      above: l.layer > layer.layer || (l.layer === layer.layer && Number(l.z) > Number(layer.z || 0)),
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  neighbours.sort((a, b) => b.layer - a.layer || Number(b.zIndex) - Number(a.zIndex));

  // Что отрисовано в точках элемента. Работает только в пределах экрана.
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const probes = [
    ['центр', rect.left + rect.width / 2, rect.top + rect.height / 2],
    ['верх-лево', rect.left + rect.width * 0.25, rect.top + rect.height * 0.25],
    ['верх-право', rect.left + rect.width * 0.75, rect.top + rect.height * 0.25],
    ['низ-лево', rect.left + rect.width * 0.25, rect.top + rect.height * 0.75],
    ['низ-право', rect.left + rect.width * 0.75, rect.top + rect.height * 0.75],
  ];
  const hitTest = [];
  let offscreen = 0;
  for (const [name, x, y] of probes) {
    if (x < 0 || x > vw || y < 0 || y > vh) {
      offscreen += 1;
      continue;
    }
    const stack = document.elementsFromPoint(x, y);
    const top = stack[0];
    const covered = top && top !== el && !el.contains(top);
    hitTest.push({
      point: name,
      top: shortPath(top),
      covered,
      opaque: covered ? isOpaque(top) : false,
    });
  }

  return {
    found: true,
    selector,
    pseudo: pseudo || null,
    box,
    target: {
      position: own.position,
      zIndex: own.zIndex,
      opacity: own.opacity,
      transform: own.transform,
      isolation: own.isolation,
      mixBlendMode: own.mixBlendMode,
      pointerEvents: own.pointerEvents,
      content: pseudoStyle ? pseudoStyle.content : undefined,
      paintLayer: layer,
      createsStackingContext: pseudoStyle ? null : stackingReason(el, style),
    },
    warnings,
    stackingContextChain: chain,
    scope: shortPath(scope) || 'html',
    neighbours: neighbours.slice(0, maxItems),
    hitTest,
    notes: [
      offscreen ? `${offscreen} из ${probes.length} точек вне экрана — hit-test по ним не делался, прокрутите к элементу.` : null,
      'Слой с pointer-events: none хит-тестом не виден, хотя рисуется поверх — смотрите neighbours.',
    ].filter(Boolean),
  };
}

export async function elementLayers(page, { selector, pseudo = null, maxItems = 15 } = {}) {
  if (!selector) throw new Error('Нужен selector.');
  return page.evaluate(collectLayers, { selector, pseudo, maxItems });
}
