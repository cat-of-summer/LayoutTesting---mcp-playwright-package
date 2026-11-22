# Phase 4. The design system

Tokens, components, assets and fonts - the whole UI kit before the first page.

## Checklist

ENTRY: sections are cut, comments are worked through.
STEPS:
  1. figma_tokens(all frames) — palette, unbound, clamp(); if it crashes — tell the human and go by figma_spec css.
  2. figma_components(all frames) — clusters with modifiers, drift, parallels (fixed heights).
  3. figma_breakpoints(frames of one screen) — what changes between widths, a ready clamp().
  4. Variables and the UI kit exist; no value from figma_tokens reached CSS without a node.
  5. The UI kit is checked against the framework dictionary (phase 0): an icon button uses its tap-area utility, an icon uses a mask, hidden content uses the visibility utility.
  6. Assets: figma_spec(frame) → assets and plan; figma_export(plan.svg, plan.image, compact: true); monochrome: true → color on the wrapper; node paint goes into CSS.
  7. Fonts: glyph coverage for the language (fontkit hasGlyphForCodePoint). No file or glyph - ask the human, the substitution is agreed.
  8. Scale between designs: mobile must not balloon on a tablet; ask the human.
  9. The UI kit is checked on a running dev server before the pages.

## The framework dictionary

The project framework already solves part of the UI kit: the tap area of an icon button, an icon
mask, visually hidden content. Your own CSS next to its utility is a second implementation that
drifts away from the first.

> **The utility was not applied.** The framework had a tap-area utility for icon buttons. The
> modal close button was built at 15×15, the burger at 20×20, and both had a tap area below 24px.

## 4.1 Tokens

```
figma_tokens(all frames)
```

It is useful for three things:

- **frequency** — it shows what is fundamental and what is a one-off;
- **`unbound`** — how many times a value is hardcoded while a Figma variable exists; that is
  exactly the work a token removes;
- ready **`clamp()`** values computed across pairs of frames of different widths.

A value becomes a token when it is bound to a Figma variable, used more than once, or already
exists in the project. A one-off spacing does not become a token. Whatever changes by variant or
state is a component variable (`.btn{--btn-bg}` → `.btn--ghost{--btn-bg:…}`), not a new global
token.

> **The main trap.** `figma_tokens` is a dictionary of the file, not the properties of a node.
> Four bugs in a row — a 1px line, a 10px bar, the color `rgba(0,0,0,.8)`, a 2px dash — were
> values taken "by meaning" from the frequency summary. All four wrong. See rule 1 in `rules`.

**A crashing tool is a stand bug, not a reason to skip the phase.** Tell the human (with the
error text) and collect the palette from `figma_spec` with `sections: ["css"]` for **every**
block, not for some. On one landing page `figma_tokens` crashed, the palette was collected from
`css` for half the blocks — and the dash color in a list of sub-items ended up invented.

**Color by role, not by name.** For every color `figma_tokens` returns `roles` — where it is used:
`state` — in state variants (Hover, Active, Selected), `tag` — in tags and statuses; `stateColors` is
the state palette with shares, `roles` a summary line. "Lights up green" was written about the brand
#E7EB70 that every active state of the kit uses, while the agent took the green #81F989 token — in
the design it only colors the "Успешно" tag. Hover, focus and selected colors come from
`stateColors`; an invented hover outside that palette is a blocker in `page_ready` and in
`lint_css` with `figma`.

**A library theme goes by its variables, not by a guess.** A datepicker, a slider, a select are
themed with library variables; after theming run `lint_css` with `sessionId` with the widget open:
`unusedCustomProperty` with `didYouMean` — the library has no variable by that name,
`libraryDefault` — a state variable (the selected date, the range) was left at its default.

## 4.2 Components

```
figma_components(all frames)
```

It merges instances of one component into a block with modifiers taken from the variant
properties. Detached blocks of the same composition are one block too: color, radius, padding and
type size become modifier axes rather than a reason for a second class. A one-off element does not
become a component.

`drift` is a difference of a couple of pixels or half a tone inside one component. That is a
discrepancy **in the design**: normalize it to one value instead of carrying it into the markup.

`parallels` is what only several instances side by side reveal: a child sits at the same `y` in
all of them while the sibling above it varies in height. That means the sibling has a **fixed
height**, not `hug` — and in CSS that is `height`/`min-height`, not "from the content".

> In three cards the title took 66px at any text length, so the dates sat on one line. The
> outline showed `270x66 [h:hug]` — `hug` was read and the height was made content-driven; the
> dates "floated". One node does not show this; three neighbours do.

## 4.3 Breakpoints

```
figma_breakpoints(frames of one screen at different widths)
```

It shows that it is the same element, what changed (type sizes, spacing, layout direction), what
disappeared, what replaced it, where the reading order diverged. Linearly changing values come
back as a ready `clamp()`.

The rule: mobile-first. Linear changes become `clamp()`, jumps become a media query. A replaced
element (a select on desktop, an icon on mobile) is two states of one block, not two blocks.

The breaking point is **found by a width run** (`layout_stress`, the `widths` scenario), not
assigned from a number in the design. The widths come from `widths.suggested` in the
`figma_sync` answer.

## 4.4 The inventory: what is what

```
figma_spec(frame) → the assets section
```

It answers at once: which nodes are icons, which are raster, which need a render, where the
duplicates are. `plan` holds ready id lists for `figma_export` with duplicates already collapsed.
It spends no Figma requests: everything is computed from the snapshot. Every `svg` entry carries
`color` — the fill color of the vector; it is needed in 4.2.

Before exporting, check whether these icons and images are **already in the project**. An export
costs requests from the limit, and the logo and the standard pictograms usually sit in shared
components from earlier tasks. Matches against the project's classes and variables are shown by
`figma_components` and `figma_tokens` with the `project` parameter.

| In the design | What to use | Why |
|---|---|---|
| Rectangle, bar, gradient, circle | CSS (`kind: css`) | no file needed, scales for free |
| Icon, logo, pictogram | `figma_export kind: "svg"` | a vector, colored by `currentColor` |
| Photo, illustration, screenshot | `figma_export kind: "image"` | a raster fill of the node |
| A vector with an image fill, a rotated crop, a mask | `figma_export kind: "render"` | neither svg nor image returns the result |

> **The third case matters.** The wheat half of the hero was a vector with a shaped edge and an
> image inside it. As `svg` it arrives without the image, as `image` — as a rectangular frame
> without the shaped edge. The right answer is `kind: "render"`. Until that was understood, the
> hero was cut by a straight vertical border instead of a curve.

`kind: render` is a **guess, not a fact**: Figma never reports that a node cannot be expressed as
SVG. Every such entry carries a `why` — read it before spending a request, and do not agree with
it silently.

## 4.5 Icons

```
figma_export(figma: [ids of the specific nodes], kind: "svg")
```

- **Node ids are required, not the frame.** Exporting a frame as `svg` returns the whole frame.
- **Hidden layers.** The answer "Failed to export node. This node may not have any visible layers"
  means a hidden layer — repeat with hidden layers shown. Do not draw it by hand.
- **`monochrome: true` means a mandatory `color` on the wrapper.** A single-colored icon
  arrives with `currentColor`, and that is right: the markup sets the color. But "sets" means
  **sets**: without `color` on the wrapper the icon inherits the text color and turns black. The
  value is the `color` field in the same export entry (or `color` of the `svg` item in
  `assets`). Multi-colored ones come with their own colors; check that nothing was lost.

> Every icon of two blocks — green and blue in the design — shipped black: the export answer was
> read only for the file paths, and the `monochrome` field was skipped. The black icons were
> visible on the screenshots — the composition was compared, not the color.

- **Sprite or inline.** Repeating icons go into a sprite; single ones, and those that need
  `currentColor` or animation, go inline.

## 4.6 Raster images

```
figma_export(figma: [nodes], kind: "image", scale: 2)
```

- **Deduplicated by content.** 48 fills collapsed into 18 files; `refs` lists every node where an
  image is used — which is immediately a map of what goes where.
- **`scaleMode`** (`FILL`, `STRETCH`, `FIT`) hints at `object-fit`.
- **The cropping note.** "Cropping with rotation cannot be expressed without a transform: cover
  fill returned" means the file no longer matches the design pixel for pixel. The inventory flags
  such nodes as `render` in advance.
- **Rename on download.** The export returns layer names: `Rectangle 180`, `Снимок экрана (1) 1`,
  Cyrillic in URLs. They must land in the project as `doc-01.webp`, `hero-fields.webp`. Two
  nodes with the same name and a different `scaleMode` are two different files: one such file
  overwrote the other.

**A section background is a full-height picture.** `backgrounds` in `figma_spec` lists the
containers with an image fill: its opacity, the color under it and the frame. Such a background
spans the full height of the block and is carried over with its opacity rather than replaced by
a canvas of your own per section: at the seams it broke off, and the hero gradient ended past the
card. `figma_compare` with `sections: true` checks the seams — the `seams` field.

**A traced raster goes out as a raster.** A "Traced Image" node or a frame with a white fill under a
vector arrives in svg as a white rectangle under the path: on a dark background there is a white
edge. `figma_spec` marks such a node `kind: render` with the reason, `figma_export kind: svg` —
with a `warning`; when svg is needed, `dropBackground: true` removes the backdrop.

## 4.7 Processing

- **A render arrives as PNG** — 3 MB for one shape. `image_convert` to WebP brought it to 232 KB
  with transparency.
- **`width` and `height` on `<img>` are mandatory** — otherwise the layout jumps on load.
  `layout_audit` catches this as `imagesWithoutDimensions`.
- **`loading="lazy"`** for everything but the first screen; the first screen gets
  `fetchpriority="high"`.

## 4.8 The paint of a node does not arrive with the asset

**Stroke, shadow and radius live on the node, not in the exported file.**

> Document covers arrived as images and were inserted as `<img>` — and the
> `{stroke #d9d9d9 3}` that sat on the rectangle node was lost. The picture is correct, the border
> is gone. The same happened with news cards: `Rectangle 218 {stroke #d9d9d9 3}`.

After inserting each asset, look at the paint of its node in `figma_spec` or in `figma_inspect`
with `mode: "outline"` and carry it into the CSS.

## A known model mismatch: stroke versus `border-box`

A card that is 80px in the design comes out 83.52px in the markup. The difference is the 2px
border on each side: Figma does not count the stroke in the frame height, CSS with
`box-sizing: border-box` does.

This is a systemic mismatch between the two models, not a defect in the markup. It can be fixed
with `outline` instead of `border`, but that breaks the radii. Usually the right decision is to
leave it and know about it when reading the comparison report.

## 4.9 Fonts

1. **Find out what the design uses.** Usually a commercial font. Ask the human: are there files,
   and what to substitute with if there are not.
2. **Substitution changes the metrics.** Lines become taller or shorter than in the design, and
   the page drifts in height. That is expected and not a defect — but it means a pixel comparison
   on a long page is useless, and `heightNote` in the comparison reports will never be zero.
3. **CJK and other large sets are cut down by glyph.** The full Noto Sans SC is 8.3 MB. A subset
   built from the characters actually used in the project is 174 KB. Keep the subsetting script in
   the repository and re-run it after the texts change.
4. **`font-display: swap`**, and explicit `@font-face` only for the weights in use.

## 4.10 Glyph coverage

A design font may lack the language: the free Bebas Neue on Google Fonts has no Cyrillic even though the design headings are set in it in Russian, and Figma silently shows a fallback. The check is fontkit `hasGlyphForCodePoint` over the language and currency characters. At TOPGUN the font had no `₽`, and the agent exported the symbol as an image without asking. No glyph - ask the human. Family variants in the design ("Bebas Neue Ru", "Bebas Neue Cyrillic") reduce to one family by style.

## 4.11 Scale between designs

With two designs (380 and 1440) and vw scaling, the mobile layout doubles in size on a tablet. The usual fix is to cap the scale in the mobile range: `html { font-size: min(10 / 380 * 100vw, 12px) }` up to the desktop breakpoint. It is a question to the human with a ready option: a custom scale on top of the framework's departs from its model.

## Gate

Variables and the UI kit exist: buttons, links, inputs, cards, tables. No value from
`figma_tokens` reached the markup without being confirmed on a specific node; `parallels` are
reflected in the component sizes. All assets are in the project and wired, none redrawn by hand; monochrome icons have `color`, node paint is carried into CSS. Fonts are wired, glyph coverage is checked, the substitution is agreed. The UI kit is checked on a running page.
