# Phase 2. Inventory of blocks and links

What is on the screen and what it does.

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
figma_behavior(frames)   → what is wired to what, with durations and easing
figma_comments(frames)   → requirements that are not in the design itself
```

`figma_behavior` groups links by target: six identical chevrons are one handler, not six.

> `figma_comments` was never called once during a whole project — and that was a miss. Half the
> requirements live in comments and Dev Mode annotations: "fix the spacing", "a form goes here",
> "we are not doing this block yet".

## 2.4 Identify the standard elements

Write them down: header, footer, menu (desktop and mobile), forms, sliders, accordions, modals,
tabs, breadcrumbs, sidebar, dropdowns, pagination, tooltips, toasts. For each one: what it is for
and what it is wired to.

Links of the kind "the success modal appears after the form is submitted" come from
`figma_behavior`; if there is no link, that is a question for the human, not a licence to invent.

## Gate

For every interactive element it is known what it does. Everything undescribed is marked
`unconfirmed` and has gone out as a question.
