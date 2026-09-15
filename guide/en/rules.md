# Rules and prohibitions

If this guide is reduced to one page, this is the page: twelve rules and nine prohibitions.

All of them come from cases where breaking them cost rework. Next to each one is what it actually
cost.

## 1. A value comes from the node

Not from the render, not from `figma_tokens`, not "by meaning". `figma_tokens` is a dictionary of
the file, not the properties of an element: it says which values exist in the design and how to
name them, never which one this node has. The paint of a node is in `figma_spec` and in
`figma_inspect` with `mode: outline`, inside the curly braces. A node collapsed by `depth` is
expanded, not guessed.

*Broken 7 times out of 11 bugs on the first landing page and 5 of 16 on the second.* A 1px line,
a 10px bar, the color `rgba(0,0,0,.8)`, a 2px dash — four values in a row taken "by meaning" from
the frequency summary. A dash color from a collapsed frame, icon colors "baked into the file", a
title height "from the content" — three more.

## 2. Structure comes from the design tree

Not from the picture. What sits in one group or one row in the design sits in one container in the
markup.

The sign of a wrong structure: the rhythm has to be patched with magic margins. In the "media"
block, two independent columns built from the picture needed `margin-top: 149px` and `209px`. In
the design tree the video and the statement were in the same row — after rebuilding, the margins
were not needed at all.

## 3. An asset is downloaded, not reproduced

And the paint of its node comes with it: stroke and shadow live on the node and never reach the
exported file; the color of a monochrome icon (`monochrome: true`) too — the wrapper's `color`
sets it.

The pagination chevrons would not export (hidden layers), so they were drawn by hand: `8x14`,
stroke `1.5`. The node said `8x17`, stroke `2`, color `rgba(0,0,0,0.4)`. Three values out of three
wrong. On another landing page every icon of two blocks shipped black: no `color` on the wrapper.

## 4. A difference from the reference is a question, not a fact to explain away

If the page differs from the render, go and inspect the node. Not "probably a render scaling
artifact". If the design looks odd — a button sticks out past the edge, a node says `hug` at a
fixed height — that is intent until the node proves otherwise.

## 5. A still screenshot says nothing about interaction

A broken slider and a working one look identical. `interaction_audit` in a session with
`animations: "allow"` clicks through and measures. The working session with motion frozen shows
neither hover nor intro — the live session for those opens at the very start.

## 6. A check report can be truncated

"Showing 6 of 135" is not "everything was checked". A link that should have been blue landed
inside a collapsed group and never reached the samples; the report was read as "no differences
left".

## 7. A plausible line of reasoning is not a diagnosis

About the slider a coherent explanation was written: "it works, it is simply locked — three cards
with three visible". Checking the component state from the inside returned
`{ swiperExists: true, slides: 0 }` — Swiper saw no slides at all.

## 8. Numbers derived from the frame width never reach the markup

`max-width: 1080px`, because "at 1440 in the design it looks like this", binds the layout to one
screen. Either a percentage of the container, or nothing. Fixed px above a breakpoint in a
non-fixed container is the same thing: at 1068px the column left the screen.

## 9. Design geometry is not replaced by "clever" CSS

`object-fit: cover` instead of coordinates is giving up the design in favour of the browser's
guess: the moment the block height stops matching the design, the cropping drifts. Scaling the
mobile composition from the desktop one through `cqw` is the same surrender: the designer did not
scale it, they rearranged it.

## 10. A component blends an external `class`, it does not overwrite it

Burned three times. The third time surfaced in a news card: the `swiper-slide` passed in was lost,
the slider came up with zero slides and locked its arrows. On a screenshot it looked fine.

## 11. Section height is not a criterion; the picture is

"The section matched in height ±2px" does not see color, position within a line, alignment of
neighbours, a shifted row, small elements. The check is `figma_compare` with `sections: true`:
picture against picture per section. `semantic` alone is not a check but its first half.

*A summary of six findings out of sixteen:* the hero spacing, the floating dates, a row 32px to
the right, the pagination dots on the left, the dash color, the mobile diagram.

## 12. State is not data, and a decision is not silence

A card expanded in the design is a hover or the active slide, not a data flag "it has amounts";
behaviour is not tuned to the height. Whatever the agent decided on its own (the hover is
intentionally absent, the element is not a link) is stated in the report: a silent decision is
indistinguishable from a forgotten one.

## Prohibitions

Phrased as "do not do X, because Y" — the things that should stop the hand.

- **"The section height matches" is not a criterion.** The criterion is a pixel comparison of the
  section. Height does not see color, rows and small things.
- **A value absent from `figma_spec`/`css` of the specific node never goes into CSS.** A collapsed
  node gets expanded; a crashing tool gets reported to the human, not guessed around.
- **`monochrome: true` in the export answer = a mandatory `color` on the wrapper.** Without it the
  icon is black.
- **An element shifted past the edge of a parent with `clip` is intent** until proven otherwise. A
  render without the parent's clipping does not disprove it.
- **The mobile frame: every block is taken apart separately.** "Scale the desktop" is not allowed:
  the designer rearranges, not shrinks.
- **An element missing from the frame is searched for in the file, not offered to be skipped.** A
  gap for the header means the header exists somewhere else.
- **Figma comments are read before building.** No REST is a blocker and a question, not a skip.
- **Intermediate widths: at least five points** — the design ones + 768 + 1024 + 1280 + the
  minimum between them. Two points are not adaptivity.
- **A "done" report is never written without a pixel check of every section and without a live
  session.** `coverage` in the `figma_compare` answer shows what has not happened.
