# Phase 11. The whole page

Once every block is done — a run across the page, at every breakpoint.

## The order

```
audit                        → the cheapest first step, a summary of every check
figma_compare(page frame)    → a separate run per breakpoint
layout_audit                 → scroll, overlaps, clipped text, tap targets
interaction_audit            → in a session with animations: "allow"
a11y_axe + a11y_pa11y        → different rule sets, they catch different things
validate_html
```

`figma_compare` opens a session of its own at the frame width — comparing a desktop design with a
mobile build is meaningless.

## About `heightNote` and pixel comparison

Until the page height matches the frame, everything below the discrepancy is shifted as a whole.

On a fluid layout with a substituted font the discrepancy accumulates at 30–80px per section and
reaches hundreds of pixels by the bottom of a long page. That is an **expected** consequence of the
font substitution, not a defect.

The practical consequence: **`mode: pixel` on a long fluid page is nearly useless** —
`diffPercentage` there reports a quarter of the page on completely correct markup. What works is
`semantic` and `paint`: they match by content and by position with a correction for the shift.

## About the validator

`validate_html` lifts out of the main count what the validator does not know: inline modern CSS
goes to the `css` field, and new platform attributes (`popover`, `inert`, `fetchpriority`, `xlink`
in inline SVG) go to `known`. Neither counts towards `total`.

The `known` list is a name list rather than knowledge of the spec, and that is its weakness: a typo
in such an attribute hides together with the correct ones. To see everything as it is, use
`strict: true`.

## About contrast

If low contrast comes from the design palette, **do not fix it silently** — raise it with the
human. The agent has no right to change brand colors.

## Gate

Zero findings in `documentOverflow`, `overlaps`, `clippedText`, `brokenImages`,
`imagesWithoutDimensions`, `tinyTargets`; an empty `silent` from `interaction_audit`. Everything
else with a justification.
