# Phase 2. Cutting into sections

Every page is cut into sections once: comments, the UI kit, the micro-spec and the comparison all refer to this register.

## Checklist

ENTRY: the frame map is confirmed.
STEPS:
  1. docs/design/README.md: page, route, desktop and mobile frame ids, service frames and states.
  2. figma_structure(frame, depth: 2..4) - the page sections and the overlay/decor/background/reparented marks.
  3. Section register: name, desktop id, mobile id, shared or own. A section with no pair at the other width - search the file, then ask.
  4. figma_spec(node, sections: ["text"]) - full texts: outline cuts them with an ellipsis.
  5. Standard elements: where they repeat and what goes into the UI kit.

## 2.1 The section register

The breakdown lives in project files rather than in the agent's head: context shrinks over hours of work, an agent can be cut off, and a site can have more pages than fit into one session. On a landing page the whole breakdown is one file, `docs/design/README.md`. On a site it is the map plus `docs/design/pages/<page>.md`.

```markdown
## Home /
| Section | desktop | mobile | Kind |
|---|---|---|---|
| hero | 280:6100 | 280:7900 | own |
| cta-booking | 280:6190 | 280:7990 | shared: Home, Services |
```

A section repeated on several pages is built once: that is decided here, not while building the second page.

## 2.2 Structure

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

## 2.3 Full texts

```
figma_spec(node) → the text section
```

`outline` and `structure` cut long strings with an ellipsis — `textsClipped` says so.

## 2.4 Identify the standard elements

Write them down: header, footer, menu (desktop and mobile), forms, sliders, accordions, modals,
tabs, breadcrumbs, sidebar, dropdowns, pagination, tooltips, toasts. For each one: what it is for
and what it is wired to.

Links of the kind "the success modal appears after the form is submitted" come from
`figma_behavior`; if there is no link, that is a question for the human, not a licence to invent.

## Gate

Every page has a section register with ids for both widths; standard elements are listed; a section with no pair was found in the file or raised as a question.
