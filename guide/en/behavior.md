# Phase 5. Behavior and agreements

How the page behaves over time and under a finger: take it from the design, and ask about what is not there before building.

## Checklist

ENTRY: the UI kit is built and checked.
STEPS:
  1. figma_behavior(frames, compact: true) - trigger, duration, easing; blocking → figma_sync with its next.
  2. motion_frames(instance, fps) for every non-obvious animation - frames and numeric tracks instead of a guess.
  3. figma_spec(both ends of the transition) - the paint "from" and "to", direction from both.
  4. Behavior table: scroll scenes, hover on touch, "once" hints, expanders, swipeable rows, the initial header state.
  5. Questions to the human - only those that change the scope, with options. Decide the rest yourself and log it under "Decisions made".
  6. For every interactive element - states: hover, focus-visible, active, disabled, error, loading, empty. Intro start states live in CSS under .js, everything respects prefers-reduced-motion.

## 5.1 What a static frame does not show

At TOPGUN the agents decided this on their own without asking, and nearly all "it does not work like that" remarks came from here. One line per item for every page:

| What | What to decide |
|---|---|
| Scroll scene | scrub, autoplay on entry or pin with progress; once or repeating |
| Hover that changes content | the touch variant: first tap shows the state, second follows the link |
| Hint, onboarding | when it shows, "once" per what: session, device, account |
| Expander | what moves, what stays; reset when the tab changes |
| Clipped or swipeable row | swipe and a sign that the row scrolls |
| Overlay, menu | what stays from the header and what it turns into |
| Initial state | how the header looks before the first scroll |

## 5.2 Watch the motion, not its description

`figma_behavior` says "Smart Animate 700 ms ease-out" but does not show what moves. The spiral trajectory at TOPGUN was invented, and the rhythm came out wrong.

```
motion_frames(figma: <instance>, fps: 12)            → contact sheet and tracks: layer, property, value per frame
motion_frames(figma, steps: 4)                       → a storyboard chain in a row
motion_frames(figma, url, selector, triggerSelector) → the same animation on the page, with the differences
```

The player shows prototype screens, so pass an instance from a design page rather than a variant from the set. The player cannot capture a timeout transition: the tracks remain for it. Looking at the contact sheet once per animation is enough; after that the comparison runs on numbers.

`figma_behavior` groups links by target: six identical chevrons are one handler, not six. Targets
missing from the snapshot are a blocking finding, `blocking`, at the top of the answer, with a ready
`figma_sync` call in `next`: pull and take them apart. The hover variant of a link component
stayed unpulled, and the hover was invented instead of taken.

## 5.3 Capture the parameters

```
figma_behavior                            → trigger, duration, easing, grouping
figma_sync(next from blocking)            → what a variant switches into
figma_spec(target)                        → the paint of the target state
```

A link gives you "from → to". To understand the direction, capture **both** states.

> **How this goes wrong.** A link led from the hero default to a variant with `rgba(0,0,0,0.4)`.
> Only the target was inspected, and the conclusion was that the veil goes away. The default had
> `{op0.2}` over `rgba(0,0,0,0.1)` — an almost transparent film — so the veil actually **arrives**.
> The direction was only recovered once both states were captured.

`blocking` is never left as is: the hover variant of a link component stayed unpulled, and the
hover was invented (shadow plus offset) instead of the one that was drawn.

## 5.4 The initial state lives in CSS, not only in JS

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

## 5.5 Hover: do not change the stacking order

Overlapping elements (circles overlapping, a stack of cards) swap places at the border of two
elements under `:hover { z-index: … }`, and the order flickers. Scale and shadow are enough; the
stacking order stays as in the design.

A hover that is not in the design is the agent's decision, and it is stated in the report: "the
active circle is not a link, the hover is intentionally absent". A silent decision is
indistinguishable from a forgotten one.

## 5.6 Element states

Write out separately for every interactive element: `hover`, `focus-visible`, `active`,
`disabled`, `error`, the loading state, the empty state. In a design these are usually component
variants — they come from `figma_components` and `figma_behavior`.

A missing state is the hardest thing to notice: it simply is not in the design, and it will not
surface in the comparison either.

## 5.7 Mandatory

Every animation respects `prefers-reduced-motion`.

## 5.8 What to ask

- **Fonts** — are there files for the commercial one, and what to substitute with.
- **How much animation** — everything from the prototype, part of it, or none.
- **Placeholders** — language versions and sections that are not in the design.
- **Adaptivity between frames** — fluid `clamp()` or fixed states.
- **Data** — how many items the real list holds.
- **Contradictions in the design** — conflicts, `drift`, obvious designer mistakes.
- **Contrast coming from the palette** — if low contrast comes from brand colors, the agent has no
  right to change them. That is the human's decision.

## 5.9 How to phrase a question

The phrasing must not nudge towards what is cheaper for the agent. The mobile frame had no header,
and it started with a gap for one — a clear sign that the header exists somewhere in the file. It
was not searched for; instead the question was phrased as "static blocks without a header
(Recommended)" against "with dropdowns — give me the node-id", and the human chose the first
because the second demanded work from them. The header sat in the file as a separate frame. The
right way: search first (phase 1), and only if nothing is found — "I could not find the header in
the file: where is it, or should I build a placeholder?" with no recommendation in favour of
"skip it".

## 5.10 What not to ask

Anything a check can settle: read the code, run the query, look at the config. Ask where only the
human knows: priorities, intentions, access, decisions about risk.

## 5.11 A decision is not silence

A large design gathers dozens of small questions, and asking them all stalls the work. The human gets those that change the scope: fonts, responsiveness, the map, the amount of animation, routes, departing from the framework model. The agent decides the rest in the style of the site and writes a line under "Decisions made" in the page breakdown: the human sees every decision in one place and corrects selectively.

## Gate

Every animation has a known trigger, both ends, duration and curve; the behavior table is filled in for every page; the human's answers are in; start states are set in CSS; every element has a list of states; there is no `blocking`.
