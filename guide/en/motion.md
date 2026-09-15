# Phase 8. Animations and states

The direction of a transition, its parameters, the initial states, and the full list of states for every element.

## Checklist

ENTRY: the human's answers are in, including how much animation.
STEPS:
  1. figma_behavior(frames) — trigger, duration, easing; every notSynced → figma_sync.
  2. figma_spec(both endpoints of a transition) — the paint "from" and "to", the direction from both.
  3. Initial states of the intro — in CSS under the .js class, not only in JS.
  4. Hover of overlapping elements — without changing z-index; a hover that is not in the design — said in the report.
  5. For every interactive element — the list of states: hover, focus-visible, active, disabled, error, loading, empty.
  6. Everything respects prefers-reduced-motion.

## 8.1 Capture the parameters

```
figma_behavior                            → trigger, duration, easing, grouping
figma_sync(link targets from notSynced)   → what a variant switches into
figma_spec(target)                        → the paint of the target state
```

A link gives you "from → to". To understand the direction, capture **both** states.

> **How this goes wrong.** A link led from the hero default to a variant with `rgba(0,0,0,0.4)`.
> Only the target was inspected, and the conclusion was that the veil goes away. The default had
> `{op0.2}` over `rgba(0,0,0,0.1)` — an almost transparent film — so the veil actually **arrives**.
> The direction was only recovered once both states were captured.

`notSynced` is never left as is: the hover variant of a link component stayed unpulled, and the
hover was invented (shadow plus offset) instead of the one that was drawn.

## 8.2 The initial state lives in CSS, not only in JS

An intro animation whose initial values are set by the script alone (`gsap.set`, `clip-path`,
`scale`, `autoAlpha: 0`) shows its **final frame** between the HTML render and the module start:
`type="module"` is deferred, and the page is already painted. In a frozen session this is
invisible, and `browser_goto` waits for the load — the first frames pass before the first shot.

The right way is initial states in CSS under a class that an inline script in `<head>` sets
before the body renders:

```scss
.js [data-hero-reveal] { clip-path: inset(-5% 100% -5% 0); }
.js [data-hero-stat]   { opacity: 0; visibility: hidden; }
```

Without JS there is no class — the content is visible at once. Check with `browser_goto` and
`frames` in the live session: a series of shots right after navigation.

## 8.3 Hover: do not change the stacking order

Overlapping elements (circles overlapping, a stack of cards) swap places at the border of two
elements under `:hover { z-index: … }`, and the order flickers. Scale and shadow are enough; the
stacking order stays as in the design.

A hover that is not in the design is the agent's decision, and it is stated in the report: "the
active circle is not a link, the hover is intentionally absent". A silent decision is
indistinguishable from a forgotten one.

## 8.4 Element states

Write out separately for every interactive element: `hover`, `focus-visible`, `active`,
`disabled`, `error`, the loading state, the empty state. In a design these are usually component
variants — they come from `figma_components` and `figma_behavior`.

A missing state is the hardest thing to notice: it simply is not in the design, and it will not
surface in the comparison either.

## 8.5 Mandatory

Every animation respects `prefers-reduced-motion`.

## Gate

For every animation the trigger, both endpoints, the duration and the curve are known; the
initial states are set in CSS; for every element there is a list of states; `notSynced` is empty.
