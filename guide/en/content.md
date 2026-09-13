# Phase 6. Content

Text goes into data, line-break artifacts get cleaned out, placeholders get identified.

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

## Gate

Texts are extracted, break artifacts are cleaned out, it is known which lists are placeholders.
