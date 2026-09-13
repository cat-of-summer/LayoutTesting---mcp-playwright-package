# Phase 10. The block cycle

The central section. The order inside matters: the specification first, then the structure, and
only then the styles.

## 10.1 Capture the specification

```
figma_spec(the block node)
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

Separately, the things that do not fit into a single declaration and are therefore easy to lose:

- `notes` on a node in the `css` section: an image with its own opacity is a separate layer, not a
  `background` with `opacity`; a mask is a `clip-path` on the parent;
- `effects` in `figma_tokens`: blur, `backdrop`, blend mode, a semi-transparent image fill. They
  deliberately have no frequency threshold — they are listed even when used once. They will not
  become tokens, but without them the page comes out brighter and sharper than the design.

## 10.2 Structure from the tree, not from the picture

DOM order equals the reading order of the narrowest layout. Rearranging on wide screens is done in
CSS, not with a second markup. Decoration goes into pseudo-elements and `absolute`, a background
rectangle becomes the container background, content is never positioned absolutely.

> **The sign of a wrong structure:** the rhythm has to be patched with magic margins. In the
> "media" block two independent columns were built from the picture, and then `margin-top: 149px`
> and `209px` were tuned to fit. In the design tree the video and the statement were **in one
> row** — after rebuilding, the margins were not needed.

## 10.3 Build

Do not replace design geometry with "clever" techniques. `object-fit: cover` instead of
coordinates is giving up the design in favour of the browser's guess: the moment the block height
stops matching the design, the cropping drifts.

Numbers derived from the frame width never reach the markup: `max-width: 1080px`, because "at 1440
in the design it looks like this", binds the layout to one screen.

## 10.4 Check that the edit actually arrived

```
computed_styles(selector, one characteristic property)
```

If it does not match the file, `matched_rules` shows the winning rule **with the file and line**.

What to read in the `browser_goto` answer when navigating again to the same address:

- `reloaded: true` — the browser cache was bypassed entirely, stylesheets and scripts included;
- if the page still serves the old thing after that, **the old thing comes from the server**. A dev
  server keeps its own transform cache, and neither the browser cache bypass nor `?v=<number>`
  touches it. The cure is restarting the dev server;
- `retried: 1` — the first attempt hit a refused connection and the second went through: the
  server was coming back up;
- `recovered` — the session was sitting on a browser error page and this navigation brought it
  back. There is no need to open a new session: the context, the patches and the login are intact.

> **Why this is a step of its own.** Twice the dev server served old CSS, and the error was looked
> for in code that had none. `matched_rules` showed the winning rule together with its source — and
> it became visible that the served CSS really did contain the old declaration.

## 10.5 Compare against the design

```
figma_compare(sessionId, the block node, mode: "semantic")
```

Read **both** sections:

- **`semantic`** — texts, type sizes, line heights, text color;
- **`paint`** — background, borders and their color, **line weight and length**, radii,
  decoration size. A class of differences the texts do not show.

Four reading rules:

1. `shiftedBlock` over N elements is **one** finding. Fix the height of the block above, not
   twenty elements.
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

## 10.6 Stress-test the block

```
layout_stress(sessionId, selectors: [the block selector])
```

Scenarios: text ×3, a long word with no break opportunities, empty text, a list of 12 and of one,
a vertical and a broken image, a range of widths. The key category is `boxOverflow`: content
escaped its own box. That is **not the same** as leaving the viewport, and a plain `layout_audit`
may not show it.

> **What was only found this way.** At 320px the burger stuck out 12px to the right and the footer
> icons 4px to the left — our own negative margins, used to pad the tap area. At 376px it was
> clean. And the header did not survive a menu of 12 items.

## 10.7 Interaction: measure it, do not look at it

```
browser_goto(..., animations: "allow")
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
arrows, both ends), the modal (open, close by the backdrop, close by Esc), the form (submit, see
the success modal, see a validation error), the menu, dropdowns, tabs.

> **The case only a measurement shows.** In an accordion `grid-template-rows` ran for 1000ms while
> `min-height` switched instantly: the row jumped to full height in the very first frame, and the
> text then spent a second spreading out inside an already empty box. On a static screenshot none
> of that is visible.

> **Why a measurement, not reasoning.** About the slider a coherent explanation was written: "it
> works, it is simply locked — three cards with three visible". Checking the state from the inside
> returned `{ swiperExists: true, slides: 0 }` — Swiper saw **no** slides at all. Plausible
> reasoning from the classes in the markup is not a diagnosis.

## 10.8 Final comparison

Repeat 10.5 after all the fixes.

## Gate

10.4–10.8 are done; differences are either fixed or written down with a justification. A block
whose interaction has not been clicked through does not count as finished, however exactly it
matches the design.

Keep a register: block → which checks it passed. Otherwise it becomes "I think I checked it".
