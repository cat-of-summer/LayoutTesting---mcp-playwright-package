/**
 * Канал ui: значения узла с панели свойств интерфейса Figma, когда Plugin API нет.
 *
 * Файл, открытый аккаунту только на просмотр, редактор показывает без window.figma, а REST на
 * месте View — двадцать запросов в месяц. В отзыве, ради которого это есть, экран сверстали до
 * пикселя, снимая значения с правой панели руками через browser_act и eval. Здесь то же самое
 * делает стенд.
 *
 * Панель в режиме просмотра (вкладка Properties) отдаёт значения не только текстом: у каждого
 * свойства есть кнопка «Copy <Свойство>: <значение>», а значение, привязанное к переменной, лежит
 * в data-tooltip её «пилюли» (border radius/br-24px → 24px). Разбирается разметка, а текст панели
 * — только там, где кнопок нет: цвета, обводка, цвета теней. Проверено на живом файле 2026-10-29.
 *
 * Чего канал не даёт по сравнению с Plugin API: абсолютных координат (только Top и Left от
 * родителя), id и типа узла (тип угадывается по разделам панели), векторов, переменных режимов,
 * констрейнтов, прототипа. Ответ это перечисляет полем missing.
 */

/** Выполняется в странице редактора: сырые строки и пары панели свойств. */
export const PANEL_SNAPSHOT = () => {
  const panel = document.querySelector('[data-testid=properties-panel]');
  if (!panel) return null;
  const pairs = [...panel.querySelectorAll('[aria-label^="Copy "]')].map((button) => {
    const pill = button.querySelector('[data-testid=variable-pill-root] [data-tooltip]');
    return { label: button.getAttribute('aria-label').slice(5), ...(pill ? { resolved: pill.getAttribute('data-tooltip') } : {}) };
  });
  const headings = [...panel.querySelectorAll('h2, h3, [role=heading]')].map((h) => h.textContent.trim()).filter(Boolean);
  const lines = panel.innerText.split('\n').map((line) => line.trim()).filter(Boolean);
  return { headings, lines, pairs };
};

/** Разделы панели, которые встречались вживую. headings страницы добавляются к ним. */
const SECTIONS = ['Component properties', 'Layout', 'Content', 'Typography', 'Colors', 'Borders', 'Shadows and blurs', 'Image', 'Export'];

export const MISSING = [
  'абсолютные координаты (только Top и Left от родителя)',
  'тип узла (угадан по разделам панели)',
  'векторы и SVG-геометрия',
  'режимы переменных',
  'констрейнты',
  'связи прототипа',
];

/** «1,920px» → 1920, «133.85» → 133.85, «50%» → 50. */
export function num(value) {
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(String(value ?? ''));
  return match ? Number(match[0].replace(/,/g, '')) : null;
}

/** «Hug (434px)» → { sizing: 'hug', px: 434 }; «368px» → { px: 368 }. */
export function sizing(value) {
  const match = /^(Hug|Fill|Fixed)\s*\(([^)]+)\)/i.exec(String(value ?? '').trim());
  if (match) return { sizing: match[1].toLowerCase(), px: num(match[2]) };
  return { px: num(value) };
}

/** Отступы в порядке CSS: «8px» → [8,8,8,8], «8px 16px» → [8,16,8,16]. */
export function box(value) {
  const parts = String(value ?? '')
    .trim()
    .split(/\s+/)
    .map(num)
    .filter((n) => n !== null);
  if (!parts.length) return null;
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l];
}

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const PERCENT = /^-?\d+(?:\.\d+)?%$/;

/**
 * Значение пары: вычисленное значение переменной, если оно есть, иначе текст. Переменная, у
 * которой Figma не показала значения (data-tooltip «undefined»), остаётся именем без значения.
 */
function pairValue(pair) {
  const [, raw = ''] = /^[^:]+:\s*(.*)$/s.exec(pair.label) || [];
  if (pair.resolved === undefined) return { value: raw };
  if (!pair.resolved || pair.resolved === 'undefined') return { value: null, variable: raw };
  return { value: pair.resolved, variable: raw };
}

/** Цвета раздела: [имя переменной] #hex [прозрачность%] подряд. */
function colorsOf(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!HEX.test(lines[i])) continue;
    const prev = lines[i - 1];
    const next = lines[i + 1];
    out.push({
      color: lines[i].toUpperCase(),
      ...(next && PERCENT.test(next) ? { opacity: num(next) } : {}),
      ...(prev && !HEX.test(prev) && !PERCENT.test(prev) && !['Hex', 'Color format', 'All sides'].includes(prev) && !/^\d/.test(prev) && !/^(X|Y|Blur|Spread|True|False)$/.test(prev)
        ? { variable: prev }
        : {}),
    });
  }
  return out;
}

const EFFECT = { 'Drop shadow': 'drop', 'Inner shadow': 'inner', 'Layer blur': 'blur', 'Background blur': 'backdrop' };
const EFFECT_FIELD = { X: 'x', Y: 'y', Blur: 'blur', Spread: 'spread' };

/** Разбор снимка панели в узел, похожий на ответ figma_inspect. */
export function parsePanel(snapshot) {
  if (!snapshot?.lines?.length) return null;
  const zoom = snapshot.lines.findIndex((line) => /^\d+%$/.test(line));
  const body = snapshot.lines.slice(zoom + 1);
  const known = new Set([...SECTIONS, ...(snapshot.headings || [])]);

  const head = [];
  const sections = {};
  let current = null;
  for (const line of body) {
    if (known.has(line)) {
      current = line;
      sections[current] ??= [];
    } else if (current) sections[current].push(line);
    else head.push(line);
  }

  const node = { name: head[0] ?? null };
  /* У текста первая строка — «Text», имя слоя за ней. */
  if (head[0] === 'Text' && sections.Typography) node.name = head[1] ?? null;
  node.kind = sections.Typography ? 'text' : sections.Image ? 'image' : sections['Component properties'] ? 'component' : sections.Layout ? 'frame' : null;

  const variables = {};
  const effects = [];
  const notes = [];
  const unparsed = [];
  for (const pair of snapshot.pairs || []) {
    const [, group, key] = /^(?:(.+?)—)?([^:]+):/s.exec(pair.label) || [];
    if (!key) continue;
    const { value, variable } = pairValue(pair);
    const name = key.trim();
    if (variable) variables[group ? `${group} ${name}` : name] = variable;
    if (variable && value === null) notes.push(`${name}: переменная ${variable} без значения в панели`);

    if (group && EFFECT[group]) {
      if (name === 'X' || (name === 'Blur' && (EFFECT[group] === 'blur' || EFFECT[group] === 'backdrop'))) effects.push({ type: EFFECT[group] });
      const effect = effects.at(-1);
      if (effect && name === 'Behind transparent areas') effect.showBehind = value === 'True';
      else if (effect && EFFECT_FIELD[name]) effect[EFFECT_FIELD[name]] = num(value);
      continue;
    }
    if (group === 'Padding') {
      node.layout ??= {};
      node.layout.padding ??= [null, null, null, null];
      const at = { Top: 0, Right: 1, Bottom: 2, Left: 3 }[name];
      if (at !== undefined) node.layout.padding[at] = num(value);
      continue;
    }
    if (sections['Component properties'] && sections['Component properties'].includes(name) && !['Width', 'Height'].includes(name)) {
      node.componentProps = { ...node.componentProps, [name]: value };
      continue;
    }
    switch (name) {
      case 'Width':
      case 'Height': {
        const s = sizing(value);
        node.size ??= {};
        node.size[name === 'Width' ? 'w' : 'h'] = s.px;
        if (s.sizing) node.size[name === 'Width' ? 'sizingH' : 'sizingV'] = s.sizing;
        break;
      }
      case 'Top':
      case 'Left':
        node.position = { ...node.position, [name.toLowerCase()]: num(value) };
        break;
      case 'Flow':
        node.layout = { ...node.layout, flow: String(value).toLowerCase() };
        break;
      case 'Gap':
        node.layout = { ...node.layout, gap: num(value) };
        break;
      case 'Padding':
        node.layout = { ...node.layout, padding: box(value) };
        break;
      case 'Justify':
      case 'Align':
        node.layout = { ...node.layout, [name.toLowerCase()]: value };
        break;
      case 'Radius':
        node.radius = value === null ? null : (box(value)?.every((n, i, all) => n === all[0]) ? num(value) : box(value));
        break;
      case 'Border':
        node.border = { ...node.border, weight: box(value)?.every((n, i, all) => n === all[0]) ? num(value) : box(value) };
        break;
      case 'Opacity':
        node.opacity = num(value) / 100;
        break;
      case 'Blend':
        node.blend = value;
        break;
      case 'Name':
        node.text = { ...node.text, style: value };
        break;
      case 'Font':
        node.text = { ...node.text, font: value };
        break;
      case 'Weight':
        node.text = { ...node.text, weight: num(value) ?? value };
        break;
      case 'Style':
        node.text = { ...node.text, fontStyle: value };
        break;
      case 'Size':
        node.text = { ...node.text, size: num(value) };
        break;
      case 'Line height':
        node.text = { ...node.text, lineHeight: /%$/.test(value) ? value : /auto/i.test(value) ? 'auto' : num(value) };
        break;
      case 'Letter spacing':
        node.text = { ...node.text, letterSpacing: /%$/.test(value) ? value : num(value) };
        break;
      case 'Paragraph spacing':
        node.text = { ...node.text, paragraphSpacing: num(value) };
        break;
      case 'List spacing':
        node.text = { ...node.text, listSpacing: num(value) };
        break;
      default:
        unparsed.push(pair.label);
    }
  }

  if (sections.Content?.length) node.text = { content: sections.Content.join('\n'), ...node.text };
  if (sections.Image?.length) node.image = sections.Image[0];

  const fills = colorsOf(sections.Colors || []);
  if (fills.length) {
    if (node.kind === 'text') node.text = { ...node.text, color: fills[0].color, ...(fills[0].variable ? { colorVariable: fills[0].variable } : {}) };
    else node.fills = fills;
  }
  if (sections.Borders?.length) {
    const lines = sections.Borders;
    const [color] = colorsOf(lines);
    node.border = {
      ...node.border,
      ...(color ? { color: color.color, ...(color.opacity !== undefined ? { opacity: color.opacity } : {}), ...(color.variable ? { variable: color.variable } : {}) } : {}),
      ...(lines.find((l) => /sides?$/i.test(l)) ? { sides: lines.find((l) => /sides?$/i.test(l)) } : {}),
      ...(lines.find((l) => /alignment$/i.test(l)) ? { align: lines.find((l) => /alignment$/i.test(l)).replace(/\s*alignment$/i, '').toLowerCase() } : {}),
    };
  }
  const shadowLines = sections['Shadows and blurs'] || [];
  const shadowColors = colorsOf(shadowLines);
  effects.filter((e) => e.type === 'drop' || e.type === 'inner').forEach((effect, i) => {
    if (shadowColors[i]) Object.assign(effect, { color: shadowColors[i].color, ...(shadowColors[i].opacity !== undefined ? { opacity: shadowColors[i].opacity } : {}) });
  });
  const style = shadowLines.find((l) => /\//.test(l) && !HEX.test(l));
  if (effects.length) node.effects = effects;
  if (style) node.effectStyle = style;
  const more = shadowLines.find((l) => /^\d+ more$/.test(l));
  if (more) notes.push(`эффектов больше, чем показала панель: ещё ${num(more)} — видны только первые`);

  if (Object.keys(variables).length) node.variables = variables;
  if (notes.length) node.notes = notes;
  if (unparsed.length) node.unparsed = unparsed;
  return node;
}
