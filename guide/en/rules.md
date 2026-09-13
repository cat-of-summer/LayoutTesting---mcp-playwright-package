# The ten rules

If this guide is reduced to one page, this is the page.

All ten come from cases where breaking them cost rework. Next to each one is what it actually cost.

## 1. A value comes from the node

Not from the render, not from `figma_tokens`, not "by meaning". `figma_tokens` is a dictionary of
the file, not the properties of an element: it says which values exist in the design and how to
name them, never which one this node has. The paint of a node is in `figma_spec` and in
`figma_inspect` with `mode: outline`, inside the curly braces.

*Broken 7 times out of 11 bugs.* A 1px line, a 10px bar, the color `rgba(0,0,0,.8)`, a 2px dash —
four values in a row taken "by meaning" from the frequency summary. All four wrong.

## 2. Structure comes from the design tree

Not from the picture. What sits in one group or one row in the design sits in one container in the
markup.

The sign of a wrong structure: the rhythm has to be patched with magic margins. In the "media"
block, two independent columns built from the picture needed `margin-top: 149px` and `209px`. In
the design tree the video and the statement were in the same row — after rebuilding, the margins
were not needed at all.

## 3. An asset is downloaded, not reproduced

And the paint of its node comes with it: stroke and shadow live on the node and never reach the
exported file.

The pagination chevrons would not export (hidden layers), so they were drawn by hand: `8x14`,
stroke `1.5`. The node said `8x17`, stroke `2`, color `rgba(0,0,0,0.4)`. Three values out of three
wrong.

## 4. A difference from the reference is a question, not a fact to explain away

If the page differs from the render, go and inspect the node. Not "probably a render scaling
artifact".

## 5. A still screenshot says nothing about interaction

A broken slider and a working one look identical. `interaction_audit` in a session with
`animations: "allow"` clicks through and measures.

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
screen. Either a percentage of the container, or nothing.

## 9. Design geometry is not replaced by "clever" CSS

`object-fit: cover` instead of coordinates is giving up the design in favour of the browser's
guess: the moment the block height stops matching the design, the cropping drifts.

## 10. A component blends an external `class`, it does not overwrite it

Burned three times. The third time surfaced in a news card: the `swiper-slide` passed in was lost,
the slider came up with zero slides and locked its arrows. On a screenshot it looked fine.
