# Phase 6. Content

Text goes into data, line-break artifacts get cleaned out, placeholders get identified.

## Checklist

ENTRY: the fonts are agreed.
STEPS:
  1. figma_spec(frame) → text — full texts and runs (mixed sizes inside one string).
  2. Text into data, one source for every breakpoint.
  3. Strip the space-as-line-break artifacts from Figma (with a script).
  4. Identify placeholder lists; the component works at 0, 1 and N items.

## 1. Text into data, not into markup

One source for every breakpoint — and the font subset is built from it too.

## 2. Figma returns line breaks as spaces

In Chinese and Japanese this tears words apart mid-word: `而地缘政 治压力` instead of
`而地缘政治压力`. Strip the spaces between ideographs with a script — in one project there were 59
of them. The same happens in Cyrillic and Latin, but far less often.

Full texts come from `figma_spec` (the `text` section) or from `figma_inspect` with
`mode: "text"`: every other mode cuts strings with an ellipsis.

## 3. The number of items in the design is not the number in life

Three news cards and pagination reading "01 … 10" is a placeholder for a feed of thirty. The
component must work at any count, including zero and one. That is checked by `layout_stress` with
the `lists` scenario.

## 4. State is not data

An expanded first card of a slider in the design is a shown state (`hover`, the active slide),
not a flag "this card has amounts". The amounts are data of every card; the expansion is a state
class (`swiper-slide-active`, `:hover`). Replacing behaviour with data contents to make the
section height match is not allowed: the height will match, the behaviour will not.

## Gate

Texts are extracted, break artifacts are cleaned out, it is known which lists are placeholders.
