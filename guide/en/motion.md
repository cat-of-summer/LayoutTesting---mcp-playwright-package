# Phase 8. Animations and states

The direction of a transition, its parameters, and the full list of states for every element.

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

## 8.2 Element states

Write out separately for every interactive element: `hover`, `focus-visible`, `active`,
`disabled`, `error`, the loading state, the empty state. In a design these are usually component
variants — they come from `figma_components` and `figma_behavior`.

A missing state is the hardest thing to notice: it simply is not in the design, and it will not
surface in the comparison either.

## 8.3 Mandatory

Every animation respects `prefers-reduced-motion`.

## Gate

For every animation the trigger, both endpoints, the duration and the curve are known; for every
element there is a list of states.
