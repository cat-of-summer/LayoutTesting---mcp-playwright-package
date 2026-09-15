# Phase 4. Assets

Anything CSS cannot reproduce is downloaded from the design as it is — and colored with the color of its node.

Not rebuilt by hand, not drawn "close enough", not taken from some other site.

## Checklist

ENTRY: the design system exists.
STEPS:
  1. figma_spec(frame) → assets — what is svg, image, render; plan — ready id lists.
  2. Check whether the icons and images are already in the project (figma_components and figma_tokens with project).
  3. figma_export(plan.svg, kind: "svg") — every monochrome: true → color from the answer into the wrapper CSS.
  4. figma_export(plan.image, kind: "image", scale: 2); render — one by one, after reading why.
  5. Rename, wire in, width/height on img, lazy below the first screen.
  6. The node paint (stroke, shadow, radius) from figma_spec into CSS — it never reaches the file.

## 4.1 The inventory: what is what

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

## 4.2 Icons

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

## 4.3 Raster images

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

## 4.4 Processing

- **A render arrives as PNG** — 3 MB for one shape. `image_convert` to WebP brought it to 232 KB
  with transparency.
- **`width` and `height` on `<img>` are mandatory** — otherwise the layout jumps on load.
  `layout_audit` catches this as `imagesWithoutDimensions`.
- **`loading="lazy"`** for everything but the first screen; the first screen gets
  `fetchpriority="high"`.

## 4.5 The paint of a node does not arrive with the asset

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

## Gate

All assets are in the project, renamed and wired in; none of them drawn by hand; every
monochrome icon has a `color`; the paint of the nodes carried into the CSS.
