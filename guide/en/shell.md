# Phase 9. The shell: shared blocks

Whatever repeats is built before the pages. Otherwise the same thing gets rebuilt on every page.

## What belongs here

Header, footer, mobile menu, modals, the UI kit.

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

The shared blocks are done and have been through the phase 10 cycle (the `block` section).
