# Phase 2. Inventory of blocks and links

What is on the screen, what it does and what the comments say about it.

## Checklist

ENTRY: the frame map is confirmed.
STEPS:
  1. figma_structure(frame, depth: 2..4) — a markup-shaped tree, the overlay/decor/background/reparented notes.
  2. figma_spec(node) → text — full texts (the outline cuts them with an ellipsis).
  3. figma_comments(frames) — requirements from comments and annotations; no REST — a blocker, a question to the human.
  4. figma_behavior(frames) — links; every notSynced → figma_sync and take it apart.
  5. A list of standard elements with their purpose; everything undescribed → unconfirmed and a question.

## 2.1 Structure

```
figma_structure(frame, depth: 2..4)
```

It returns a tree shaped like markup rather than a dump of layers, and it marks the places where
building "by layers" would be wrong:

| Note | What it means |
|---|---|
| `{overlay: on top of X — position: absolute}` | the element lies on top, not in the flow |
| `{decor: extends past the edge}` | a pseudo-element or a background, not content |
| `{background: shape under all content}` | this is the container background, not an element |
| `reparented` | siblings in the layers, drawn inside — children in the markup |
| "the group creates no box" | there must be no wrapper in the markup |

## 2.2 Full texts

```
figma_spec(node) → the text section
```

`outline` and `structure` cut long strings with an ellipsis — `textsClipped` says so.

## 2.3 Links and requirements

```
figma_comments(frames)   → requirements that are not in the design itself
figma_behavior(frames)   → what is wired to what, with durations and easing
```

**Comments are read before building.** They are the only channel where requirements like "JS
hover animation here, like on the reference site" or "we are not doing this block yet" live. The
tool works through REST only; a missing token is a blocker to ask the human about, not a given.

> On one landing page `figma_comments` was never called — the hover of three blocks was invented,
> while a comment pointed at a reference on a finished site. On another, "fix the spacing" and "a
> form goes here" also lived only in the comments.

`figma_behavior` groups links by target: six identical chevrons are one handler, not six. Targets
missing from the snapshot sit in `notSynced` — pull each one with `figma_sync` and take it apart:
the hover variant of a link component stayed in `notSynced`, and the hover was invented instead
of taken.

## 2.4 Identify the standard elements

Write them down: header, footer, menu (desktop and mobile), forms, sliders, accordions, modals,
tabs, breadcrumbs, sidebar, dropdowns, pagination, tooltips, toasts. For each one: what it is for
and what it is wired to.

Links of the kind "the success modal appears after the form is submitted" come from
`figma_behavior`; if there is no link, that is a question for the human, not a licence to invent.

## Gate

The comments are read or their absence is agreed; for every interactive element it is known what
it does; `notSynced` is empty; everything undescribed is marked `unconfirmed` and has gone out as
a question.
