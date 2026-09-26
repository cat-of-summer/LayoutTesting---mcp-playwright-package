# Phase 9. The shell: shared blocks

Whatever repeats is built before the pages. Otherwise the same thing gets rebuilt on every page.

## Checklist

ENTRY: animations and states are described.
STEPS:
  1. Header, footer, mobile menu, modals, UI kit — each through the phase 10 cycle.
  2. An element missing from the mobile frame (header, footer) was found in the file in phase 1; never "without a header".
  3. A component blends an external class rather than overwriting it.
  4. help(guide: "block") is open, and every shared block went through its checklist item by item.
  5. The header with the menu open and closed, sticky and plain — browser_act with anchors: moved is empty.
  6. UI kit components are checked against the project CSS framework dictionary (phase 3): tap area, icons, visibility.

## What belongs here

Header, footer, mobile menu, modals, the UI kit.

The mobile header is built even when the mobile page frame does not contain it: the gap for it in
the frame is a sign that it sits as a separate frame, and finding it is phase 1 work. One landing
page shipped without a mobile header although its design was in the file: the agent did not find
it and offered not to build it.

## The phase 10 cycle — open it, do not recall it

> **The section was never opened.** Right after the shell the agent went on building and reported
> the checkpoint. Phase 10 was never opened, and its gate requires comparing both the desktop and
> the mobile node: the uncompared mobile footer with a link step of 32 instead of 40 would have
> been caught by it.

## The class pass-through rule

A component that accepts a `class` from outside must blend it in, not overwrite it:

```astro
// wrong — the class from props wipes out the component's own class
const { ...props } = Astro.props;
<a class="card" {...props}>

// right
const { class: className, ...props } = Astro.props;
<a class:list={['card', className]} {...props}>
```

> **Burned three times.** In the logo, in the language switcher — and the rest were never checked.
> The third time surfaced in a news card: the `swiper-slide` passed in was lost, the slider came up
> with zero slides and locked its arrows. On a screenshot it looked fine; `interaction_audit`
> would have put that arrow in `silent`.

## Gate

The shared blocks are done and have been through the phase 10 cycle (the `block` section, opened
and walked through by its checklist, not from memory); the header stays in place in all its states.
