# Phase 6. Page micro-specs

Everything gathered about a page goes into one short file: it is what the page is built from and accepted against.

## Checklist

ENTRY: behavior is described, the human's answers are in.
STEPS:
  1. docs/design/pages/<page>.md from the template; on a landing page, a section of the README.
  2. For each section: node ids, UI kit components, texts, assets, behavior.
  3. Requirements from comments.md and the behavior table - as "- [ ]" items in their section.
  4. Texts go into data, one source for all breakpoints; clean Figma line-break spaces with a script.
  5. List placeholders are identified; the component works with 0, 1 and N items.
  6. A "Decisions made" section exists.

## 6.1 Template

```markdown
---
page: Home
route: /
frames: { desktop: 280:6100, mobile: 280:7900 }
---
## hero
Nodes: 280:6101 / 280:7901. Kit: Button, Tag. Assets: hero.webp.
- [ ] Heading in 2 lines at 1440, uppercase
- [ ] The photo appears first, then the caption (motion_frames 280:6105)
- [ ] On touch the first tap shows the caption, the second goes to /about

## Decisions made
- The "swipe" hint shows once per session.
```

The micro-spec is the input of the agent building the page and the acceptance checklist. The file stays short: CSS values are not copied into it, they come from the node by id. Its text is passed to `page_ready` as `checklist`.

## 6.2 Text into data, not into markup

One source for every breakpoint — and the font subset is built from it too.

## 6.3 Figma returns line breaks as spaces

In Chinese and Japanese this tears words apart mid-word: `而地缘政 治压力` instead of
`而地缘政治压力`. Strip the spaces between ideographs with a script — in one project there were 59
of them. The same happens in Cyrillic and Latin, but far less often.

Full texts come from `figma_spec` (the `text` section) or from `figma_inspect` with
`mode: "text"`: every other mode cuts strings with an ellipsis.

## 6.4 The number of items in the design is not the number in life

Three news cards and pagination reading "01 … 10" is a placeholder for a feed of thirty. The
component must work at any count, including zero and one. That is checked by `layout_stress` with
the `lists` scenario.

## 6.5 State is not data

An expanded first card of a slider in the design is a shown state (`hover`, the active slide),
not a flag "this card has amounts". The amounts are data of every card; the expansion is a state
class (`swiper-slide-active`, `:hover`). Replacing behaviour with data contents to make the
section height match is not allowed: the height will match, the behaviour will not.

## Gate

Every page has a micro-spec: sections with ids, components and assets, all requirements as items, placeholders identified, texts extracted.
