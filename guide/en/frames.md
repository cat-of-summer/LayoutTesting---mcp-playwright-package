# Phase 1. Reconnaissance

Which frames are actually pages — which only look like frames, what a parent clips, and what is not a frame at all.

## Checklist

ENTRY: phase 0 is closed, every link of the task is at hand.
STEPS:
  1. figma_sync(every link in one call) — frame summary, path of each node, widths.suggested.
  2. For every id from the task — path: a frame or a child node? A child → its parent in figma_inspect.
  3. figma_structure(canvas, depth: 1) + figma_export(kind: "render") — identify by eye; parts: "children" for tall frames.
  4. Nodes with [clip] in the outline — what the parent cuts off: clipped in the figma_export answer.
  5. Table frame → width → what it is → build or not; show it to the human.

## 1.1 Pull the frames

```
figma_sync(every link of the task in one call)
```

One call per file — after that the analysis reads the snapshot and never calls Figma. The REST
limit on Starter is ten requests a minute, and twenty a month on a View/Collab seat.

The answer carries `path` for every frame (where it sits in the file) and, when two frames of
different widths were pulled, `widths.suggested`: the widths for the runs of phases 10–12. Write
them down: "there is no tablet design" does not mean "the tablet is not checked".

A link without a node-id returns the list of pages and frames. More than a hundred frames on a
page — `page` and `offset` in `figma_sync`, not guessing neighbouring ids.

## 1.2 Identify the frames

```
figma_structure(canvas, depth: 1)                          → what is on the canvas
figma_export(kind: "render", scale: 0.5)                   → identify them by eye
figma_export(tall frame, parts: "children")                → one part per top-level child frame
```

What to expect:

- **The link in the task may not point at a frame.** One `node-id` pointed at an entire canvas of
  2678 nodes. Another time three "modals" from the task turned out to be one `RECTANGLE` inside a
  sidebar — `path` would have shown that; instead neighbouring ids were guessed.
- **One screen can be spread over several frames.** The mobile version lived in two: `Mobile 1`
  (hero…footer) and `Mobile` (sections drawn later). Building only the first would have left half
  the page without a mobile version.
- **Part of the screen lives in another frame or on another page.** The mobile frame started with
  a gap for the header, and the header itself was not in it — it sat as a separate frame in the
  same file. The agent did not find it and offered to build "without a header". An empty space
  with a gap is a search, not a question: `figma_sync` without a node-id lists the pages and
  frames (`page`, `offset` when there are more than a hundred), `figma_components` on the pulled
  frames shows the header instances, and only when nothing is found anywhere — a question to the
  human.
- **Service frames sit right next to the real ones.** A translation source, sections already
  merged into the main design, the hero on its own. None of these are pages.
- **An offset past the edge of a parent with `clip` is intent.** A tab-button 137px wide sat in a
  frame of the same width with `clip` at `x=92`: 45px stick out — the icon; the text is hidden and
  slides out on click. The `figma_export` render is made **without the parent's clipping** and
  showed the whole button; the offset was read as sloppiness and "fixed". The `clipped` field in
  the export answer now says how much is visible in the design; with `[clip]` on the parent in the
  outline, trust it rather than the render.
- **A tall mobile frame is read in full.** A six-thousand-pixel frame was cut into 25 parts; 6
  were read, the rest was guessed — half of the mobile mistakes came from there.
  `parts: "children"` gives one part per top-level child frame, each labelled with its node. If the
  render is taller than the frame box (`oversized` in the answer), the content overflows the
  frame, and the build will show that too.

## 1.3 Draw the map

A table: frame → width → what it is (a page, a state, a draft, reference material) → do we build
it or not. As separate rows — nodes of which only a part is visible (`clipped`), and elements
that are not in the frame but implied (header, footer, modals): where they were found.

## Gate

The frame map has been shown to the human and confirmed. A frame you cannot tell "design or
draft" about is a question for the human, not a decision for the agent.
