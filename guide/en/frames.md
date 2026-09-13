# Phase 1. Reconnaissance

Which frames are actually pages — and which only look like frames.

## 1.1 Pull the frames

```
figma_sync(every link of the task in one call)
```

One call per file — after that the analysis reads the snapshot and never calls Figma. The REST
limit on Starter is ten requests a minute, and twenty a month on a View/Collab seat.

## 1.2 Identify the frames

```
figma_structure(canvas, depth: 1)            → what is on the canvas
figma_export(kind: "render", scale: 0.5)     → identify them by eye
```

What to expect:

- **The link in the task may not point at a frame.** One `node-id` pointed at an entire canvas of
  2678 nodes.
- **One screen can be spread over several frames.** The mobile version lived in two: `Mobile 1`
  (hero…footer) and `Mobile` (sections drawn later). Building only the first would have left half
  the page without a mobile version.
- **Service frames sit right next to the real ones.** `Перевод` is the text source for the
  translator. `Новые блоки` are sections already merged into the main design. `блок 1` is the hero
  on its own. None of these are pages.

## 1.3 Draw the map

A table: frame → width → what it is (a page, a state, a draft, reference material) → do we build
it or not.

## Gate

The frame map has been shown to the human and confirmed. A frame you cannot tell "design or
draft" about is a question for the human, not a decision for the agent.
