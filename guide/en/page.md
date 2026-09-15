# Phase 11. The whole page

Once every block is done — a run across the page, on every design frame and at every width between them.

## Checklist

ENTRY: every block passed the phase 10 gate in both frames.
STEPS:
  1. audit — a summary of every check.
  2. figma_compare(page frame) — per frame: semantic and sections: true; coverage without gaps.
  3. layout_audit(widths: from figma_sync.widths.suggested) — scroll, overlaps, clipping, tap targets at every width.
  4. interaction_audit in the live session; browser_goto with frames — the intro animation.
  5. a11y_axe + a11y_pa11y; validate_html (ignore — only for library conventions).
  6. The "done" report — only after 2 and 4.

## The order

```
audit                                          → the cheapest first step, a summary of every check
figma_compare(frame, mode: "semantic")         → a separate run per frame
figma_compare(frame, sections: true)           → pixel per section of the frame
layout_audit(widths: [...])                    → scroll, overlaps, clipped text, tap targets — at every width
interaction_audit                              → in the live session
browser_goto(url, frames: 8)                   → the first frames after navigation: the intro
a11y_axe + a11y_pa11y                          → different rule sets, they catch different things
validate_html
```

`figma_compare` opens a session of its own at the frame width — comparing a desktop design with a
mobile build is meaningless.

## The widths between the frames

Two frames — at least five widths for the run: the design ones, 768, 1024, 1280 and the minimum
between the design ones. `layout_audit` with `widths` runs one session through all of them and
sums them up in a table; at every width read `documentOverflow` and `boxOverflow`.

> At 1440 and 380 there was no overflow. At 1068 a fixed slider with a fixed column did not fit
> the container — the column left the screen. The intermediate widths were never opened.

## About `heightNote` and pixel comparison

Until the page height matches the frame, everything below the discrepancy is shifted as a whole.

On a fluid layout with a substituted font the discrepancy accumulates at 30–80px per section and
reaches hundreds of pixels by the bottom of a long page. That is an **expected** consequence of the
font substitution, not a defect.

The practical consequence: **`mode: pixel` over a whole long page is useless** — `diffPercentage`
there reports a quarter of the page on completely correct markup. What works is `semantic` and
`paint` (matching by content and by position with a correction for the shift) and
`sections: true`: every section is compared as a picture on its own, with its own shift
correction, and the accumulated offset does not touch it. "Pixels do not work on a long page" is
no reason not to compare pictures at all.

## About the validator

`validate_html` lifts out of the main count what the validator does not know: inline modern CSS
goes to the `css` field, and new platform attributes (`popover`, `inert`, `fetchpriority`, `xlink`
in inline SVG) go to `known`. Neither counts towards `total`.

The project's library conventions (custom tags, component attributes) go into `ignore` so the
noise does not hide real errors; what was filtered is shown separately in `ignored`, and its size
is part of the report, not something that vanished.

The `known` list is a name list rather than knowledge of the spec, and that is its weakness: a typo
in such an attribute hides together with the correct ones. To see everything as it is, use
`strict: true`.

## About contrast

If low contrast comes from the design palette, **do not fix it silently** — raise it with the
human. The agent has no right to change brand colors.

## Gate

Zero findings in `documentOverflow`, `overlaps`, `clippedText`, `brokenImages`,
`imagesWithoutDimensions`, `tinyTargets` at every width; an empty `silent` from
`interaction_audit`; `coverage` of `figma_compare` for every frame without gaps; the intro looked
at frame by frame. Everything else with a justification.
