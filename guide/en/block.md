# Phase 10. The block cycle

The central section. The order inside matters: the specification down to the leaves first, then the structure, then the styles, then a comparison of pictures.

## Checklist

ENTRY: the shell is done, the block's ref in every frame (desktop and mobile) is known.
STEPS:
  1. figma_spec(ref, depth ≥ 6) — down to the leaf vectors; unresolved in the answer is empty (otherwise expand).
  2. For every TEXT — font, size, weight, line-height, color, width (fill/hug) from css; the small stuff (dashes, bullets) separately.
  3. For every VECTOR/ELLIPSE — the fill into the wrapper CSS; svg with monochrome — color.
  4. Identical siblings (×N in the outline, parallels in figma_components) — compare the children's y: fixed heights.
  5. The mobile node of the block — the same procedure (steps 1–4), not a scaled desktop.
  6. Structure from the tree; subtract nested container offsets on both axes.
  7. Build: no px derived from the frame width, no cover instead of coordinates, state ≠ data.
  8. computed_styles → the edit arrived; if not — matched_rules.
  9. figma_compare mode: semantic — every difference explained or fixed (not "tolerance").
  10. figma_compare sections: true (or pixel by selector) — picture against picture per section.
  11. layout_stress(widths from figma_sync.widths.suggested).
  12. Live session: hover every interactive element, interaction_audit; silent is empty.
  13. Repeat 9–10 after the fixes; register block → checks.

## 10.1 Capture the specification — down to the leaves

```
figma_spec(the block node, depth: 6..8)
```

One call returns everything: the layer tree with layout and paint (`outline`), the full texts
(`text`), the styles (`css`), and the asset list with what each one needs (`assets`).

The paint comes right in the tree line:

```
751:2053 VECTOR "Vector 13" 0,71 557x0 {stroke #000000 5}
751:2021 RECTANGLE "Rectangle 174" -3,0 1471x920 [img] {img op0.7}
751:1907 RECTANGLE "Rectangle 180" 805,56 515x729 [img] {img, stroke #d9d9d9 3}
```

**No value is ever taken from the render.** The render systematically lies about weights, colors
and opacity. A `LINE` always has a zero-height box — the line weight lives only in `stroke`.

**The line "… N nested deeper than depth" means the block is not taken apart.** Leaf vectors —
dashes, bullets, dividers, icons — are the first to get lost: they are small, they sit deep, and
on an overall screenshot their color does not stand out. The `figma_spec` answer sums this up in
`unresolved`: nodes collapsed by depth, svg without a color, links not synced. Until it is empty,
the phase is not closed.

> The sub-item dash sat in a 14x14 frame collapsed at `depth: 4` ("… 1 nested deeper"). Nobody
> went inside, and the color was invented. A text element must show all its properties at once —
> `css` gives that; for this block only `outline` was called.

For every text node — the full set: `font-family`, `size`, `weight`, `line-height`, `color`,
width (`w:fill` / `w:hug`), alignment. For every vector and ellipse — the fill and the stroke that
go into the wrapper CSS (`color` for `currentColor`).

Separately, the things that do not fit into a single declaration and are therefore easy to lose:

- `notes` on a node in the `css` section: an image with its own opacity is a separate layer, not a
  `background` with `opacity`; a mask is a `clip-path` on the parent;
- `effects` in `figma_tokens`: blur, `backdrop`, blend mode, a semi-transparent image fill. They
  deliberately have no frequency threshold — they are listed even when used once. They will not
  become tokens, but without them the page comes out brighter and sharper than the design.

### Identical siblings — compare them together

The `×N как id` line in the outline and `parallels` in `figma_components` are three instances to
look at **side by side**, not one at a time. A child's `y` matches while a sibling's height
differs — the sibling has a fixed height, whatever it is marked as (`h:hug` at `270x66` is 66px).

### The mobile node — the same procedure

The mobile frame is taken apart **block by block**, with steps 1–4, not "like the desktop, only
narrower". On mobile the designer rearranges rather than scales: the cards of a diagram take the
full screen width instead of shrinking by 0.57; the header sits as a separate frame; a slider
becomes a column.

> The mobile node of a diagram with the same box width but a different height was read as "a
> scaled-down copy of the desktop one", and the whole composition was scaled. Nobody went inside
> the mobile node even once. A different height at the same box already said the composition was
> different.

## 10.2 Structure from the tree, not from the picture

DOM order equals the reading order of the narrowest layout. Rearranging on wide screens is done in
CSS, not with a second markup. Decoration goes into pseudo-elements and `absolute`, a background
rectangle becomes the container background, content is never positioned absolutely.

> **The sign of a wrong structure:** the rhythm has to be patched with magic margins. In the
> "media" block two independent columns were built from the picture, and then `margin-top: 149px`
> and `209px` were tuned to fit. In the design tree the video and the statement were **in one
> row** — after rebuilding, the margins were not needed.

**Coordinates in `figma_inspect` are relative to the requested node's box.** When positioning a
child of a nested container, subtract the container's offset on **both** axes: the bottom row of
a diagram drifted 32px to the right because the block's `y` was subtracted and its `x` was not.
Recomputing "in the head" while moving numbers into data is where this happens; the picture
comparison (10.5) is where it gets caught.

## 10.3 Build

Do not replace design geometry with "clever" techniques. `object-fit: cover` instead of
coordinates is giving up the design in favour of the browser's guess: the moment the block height
stops matching the design, the cropping drifts.

Numbers derived from the frame width never reach the markup: `max-width: 1080px`, because "at 1440
in the design it looks like this", binds the layout to one screen.

**Fixed px above a breakpoint in a non-fixed container is forbidden.** A 886px slider plus a 272px
column from the 1440 design need 1200px at 1068 in a 1028px container — the column leaves the
screen. One breakpoint and fixed pixels above it is not adaptivity: between the design widths use
percentages, `clamp()`, `minmax()`, wrapping.

**State is not data.** An expanded card in the design is a `hover` or the active slide, not "this
card has amounts". Tuning behaviour to the section height is not allowed.

## 10.4 Check that the edit actually arrived

```
computed_styles(selector, one characteristic property)
```

If it does not match the file, `matched_rules` shows the winning rule **with the file and line**.
`overriddenByStand` in the answer means the value was overridden by the stand in a frozen session
(`opacity`, `visibility`, `transform` on elements pinned after the scroll reveal) — that is not
your CSS, and the live session does not have it.

What to read in the `browser_goto` answer when navigating again to the same address:

- `reloaded: true` — the browser cache was bypassed entirely, stylesheets and scripts included;
- if the page still serves the old thing after that, **the old thing comes from the server**. A dev
  server keeps its own transform cache, and neither the browser cache bypass nor `?v=<number>`
  touches it. The cure is restarting the dev server — by the PID on the port, not by killing every
  `node` process on the machine;
- `retried: 1` — the first attempt hit a refused connection and the second went through: the
  server was coming back up;
- `recovered` — the session was sitting on a browser error page and this navigation brought it
  back. There is no need to open a new session: the context, the patches and the login are intact.

> **Why this is a step of its own.** Twice the dev server served old CSS, and the error was looked
> for in code that had none. `matched_rules` showed the winning rule together with its source — and
> it became visible that the served CSS really did contain the old declaration.

## 10.5 Compare against the design — the picture, not the heights

```
figma_compare(sessionId, the block node, mode: "semantic")    → texts, sizes, paint
figma_compare(sessionId, the frame, sections: true)           → pixel per section
```

**"The section height matches" is not a criterion.** It does not see icon colors, position within
a line, alignment of neighbours, a row shifted by 32px, small elements. The criterion is picture
against picture. The order is strict:

1. `semantic` — and for every difference either a fix or an explanation with the node (not
   "accepted as tolerance");
2. `sections: true` — pixel by pixel per section of the frame (or `mode: "pixel"` with
   `selector`); the `diff` of every section looked at;
3. only then the block is done. `coverage` in the answer shows what has not run for this frame
   yet.

> `pixel` never ran: the semantic report gave a long list of offsets, they were explained by text
> wrapping, and "once the semantics converge, then the pixels". In the end not one section was
> compared as a picture, and the black icons, the shifted row, the floating dates and the dots
> pressed to the left shipped.

Read **both** sections of the `semantic` report:

- **`semantic`** — texts, type sizes, line heights, text color;
- **`paint`** — background, borders and their color, **line weight and length**, radii,
  decoration size. A class of differences the texts do not show.

Four reading rules:

1. `shiftedBlock` over N elements is **one** finding. Fix the height of the block above, not
   twenty elements. But "the block is −50px" does not cancel the small offsets inside it — those
   are dealt with afterwards.
2. A difference up to 1px and font rendering differences are not defects.
3. **The report is truncated.** "Showing 6 of 135" means 129 were not checked. How to read the rest
   is in `note`.
4. `unmatched` splits into two buckets, and they call for different work. `shifted` — the node is
   on the page, and `off` shows the offset remaining beyond the correction already applied: that is
   work. `notFound` — the node is nowhere; the check cannot tell the reason apart because it walks
   elements: a pseudo-element, the inside of an SVG, or genuinely not built.

> **How a truncated report misleads.** A link that should have been blue landed in a collapsed
> `shiftedBlock` group and never reached the samples. The report was read as "no differences left"
> and the link stayed black.

> **What `paint` adds over the texts.** The review said "the line weight is incorrect". Fixing only
> the color would have closed the question wrongly: `paint` showed that the **length** differed too
> — 367px in the design against 666px in the markup. A `border-bottom` cannot be limited that way;
> the line had to be a pseudo-element.

## 10.6 Stress-test the block — the widths between the frames

```
layout_stress(sessionId, selectors: [the block selector], widths: [from figma_sync.widths.suggested])
```

Scenarios: text ×3, a long word with no break opportunities, empty text, a list of 12 and of one,
a vertical and a broken image, a range of widths. The key category is `boxOverflow`: content
escaped its own box. That is **not the same** as leaving the viewport, and a plain `layout_audit`
may not show it.

**Two points are not adaptivity.** The minimum: the design widths + 768, 1024, 1280 + the minimum
width between the design ones. No tablet design means the layout between the frames is checked,
not skipped.

> **What was only found this way.** At 320px the burger stuck out 12px to the right and the footer
> icons 4px to the left — our own negative margins, used to pad the tap area. At 376px it was
> clean. And the header did not survive a menu of 12 items. And at 1068px a side column left the
> screen — only 1440 and 380 had been checked.

## 10.7 Interaction: measure it, do not look at it

```
browser_goto(..., animations: "allow")   — or the live session from phase 0
interaction_audit(sessionId)
```

It clicks and hovers by itself and reports **what changed and how long it took**. The headline of
the answer is `silent`: the elements that answered with nothing. A slider arrow that does nothing
is exactly `silent`, and on a screenshot it is indistinguishable from a working one.

How to read `timing`:

- `smooth: false` — the state switched within a couple of frames, that is, there is no animation in
  fact, however it was declared;
- `settled: false` with `kind: continuous` — an infinite animation: a marquee, a spinner. That is
  not a defect, and it has no invented duration;
- `durationMs: 0` on a working transition means what changes is not measurable this way: color,
  shadow, background. What neither moves nor fades is not measured.

What must be clicked through: the accordion (open, close, switch to another), the slider (both
arrows, both ends; **a screenshot of the block with its pagination**, not just `slideNext()`),
the modal (open, close by the backdrop, close by Esc), the form (submit, see the success modal,
see a validation error), the menu, dropdowns, tabs. Hover **every** element that has a hover — in
the live session, by eye on a screenshot.

> **The case only a measurement shows.** In an accordion `grid-template-rows` ran for 1000ms while
> `min-height` switched instantly: the row jumped to full height in the very first frame, and the
> text then spent a second spreading out inside an already empty box. On a static screenshot none
> of that is visible.

> **Why a measurement, not reasoning.** About the slider a coherent explanation was written: "it
> works, it is simply locked — three cards with three visible". Checking the state from the inside
> returned `{ swiperExists: true, slides: 0 }` — Swiper saw **no** slides at all. Plausible
> reasoning from the classes in the markup is not a diagnosis.

> **Mechanics are not looks.** The pagination dots were checked with `swiper.slideNext()` —
> switching worked. No screenshot of the block was taken — so nobody saw that Swiper had put
> `position: absolute; left: 0` on the dots container, and they were pressed to the left edge.

## 10.8 Final comparison

Repeat 10.5 (both steps) after all the fixes.

## Gate

10.4–10.8 are done for the desktop and the mobile node; `unresolved` is empty; differences are
either fixed or written down with a justification and the node; every section is compared pixel
by pixel; every element's hover has been looked at in the live session. A block whose interaction
has not been clicked through does not count as finished, however exactly it matches the design.

Keep a register: block → which checks it passed. Otherwise it becomes "I think I checked it".
