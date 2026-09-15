# Phase 3. The design system

Tokens, components and breakpoints — before the first block.

## Checklist

ENTRY: the inventory of blocks and links is done.
STEPS:
  1. figma_tokens(all frames) — palette, unbound, clamp(); if it crashes — tell the human and go by figma_spec css.
  2. figma_components(all frames) — clusters with modifiers, drift, parallels (fixed heights).
  3. figma_breakpoints(frames of one screen) — what changes between widths, a ready clamp().
  4. Variables and the UI kit exist; no value from figma_tokens reached CSS without a node.

## 3.1 Tokens

```
figma_tokens(all frames)
```

It is useful for three things:

- **frequency** — it shows what is fundamental and what is a one-off;
- **`unbound`** — how many times a value is hardcoded while a Figma variable exists; that is
  exactly the work a token removes;
- ready **`clamp()`** values computed across pairs of frames of different widths.

A value becomes a token when it is bound to a Figma variable, used more than once, or already
exists in the project. A one-off spacing does not become a token. Whatever changes by variant or
state is a component variable (`.btn{--btn-bg}` → `.btn--ghost{--btn-bg:…}`), not a new global
token.

> **The main trap.** `figma_tokens` is a dictionary of the file, not the properties of a node.
> Four bugs in a row — a 1px line, a 10px bar, the color `rgba(0,0,0,.8)`, a 2px dash — were
> values taken "by meaning" from the frequency summary. All four wrong. See rule 1 in `rules`.

**A crashing tool is a stand bug, not a reason to skip the phase.** Tell the human (with the
error text) and collect the palette from `figma_spec` with `sections: ["css"]` for **every**
block, not for some. On one landing page `figma_tokens` crashed, the palette was collected from
`css` for half the blocks — and the dash color in a list of sub-items ended up invented.

## 3.2 Components

```
figma_components(all frames)
```

It merges instances of one component into a block with modifiers taken from the variant
properties. Detached blocks of the same composition are one block too: color, radius, padding and
type size become modifier axes rather than a reason for a second class. A one-off element does not
become a component.

`drift` is a difference of a couple of pixels or half a tone inside one component. That is a
discrepancy **in the design**: normalize it to one value instead of carrying it into the markup.

`parallels` is what only several instances side by side reveal: a child sits at the same `y` in
all of them while the sibling above it varies in height. That means the sibling has a **fixed
height**, not `hug` — and in CSS that is `height`/`min-height`, not "from the content".

> In three cards the title took 66px at any text length, so the dates sat on one line. The
> outline showed `270x66 [h:hug]` — `hug` was read and the height was made content-driven; the
> dates "floated". One node does not show this; three neighbours do.

## 3.3 Breakpoints

```
figma_breakpoints(frames of one screen at different widths)
```

It shows that it is the same element, what changed (type sizes, spacing, layout direction), what
disappeared, what replaced it, where the reading order diverged. Linearly changing values come
back as a ready `clamp()`.

The rule: mobile-first. Linear changes become `clamp()`, jumps become a media query. A replaced
element (a select on desktop, an icon on mobile) is two states of one block, not two blocks.

The breaking point is **found by a width run** (`layout_stress`, the `widths` scenario), not
assigned from a number in the design. The widths come from `widths.suggested` in the
`figma_sync` answer.

## Gate

Variables and the UI kit exist: buttons, links, inputs, cards, tables. No value from
`figma_tokens` reached the markup without being confirmed on a specific node; `parallels` are
reflected in the component sizes.
