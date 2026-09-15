# Phase 0. Preparation

The stand, reaching the project, Figma access, two sessions and the project's own rules — before the first line of code.

## Checklist

ENTRY: the design frame links and the project path are known.
STEPS:
  1. stand_info — version, exposed groups, guide.available: true (otherwise tell the human).
  2. figma_status — editor.state and rest.configured; rest: false → action: token; still no → ask the human.
  3. dev server on 0.0.0.0 → browser_goto http://host.docker.internal:<port> answers 200.
  4. browser_open a second time with animations: "allow" — the live session; keep both to the end.
  5. README, CLAUDE.md, bundler config — how assets are wired, what the CSS framework does to p and h1..h6.

## 0.1 The stand and access

```
stand_info              → version, exposed tool groups, viewport presets, guide
help(topic: "figma")    → the entry point of the handbook
figma_status            → are the editor channel and REST alive
```

`stand_info.guide.available: false` means the image was built without the handbook. That is a
build error — tell the human right away instead of quietly working from the built-in minimum.

**REST is needed before the snapshot, not "when it comes up".** Design comments exist only in
REST, and half the requirements live there ("JS hover animation here, like on the reference site").
`rest.configured: false` → `figma_status` with `action: token`; not issued → a question to the
human. A missing token is a blocker for phase 2, not a skip: on one landing page the comments were
never read, and the hover of three blocks was invented instead of taken from a comment.

## 0.2 Reaching the project from the stand

The stand runs in a container and **cannot see the host's `localhost`**. Start the project and
check reachability immediately:

```
dev server on 0.0.0.0  →  browser_goto http://host.docker.internal:<port>
```

Vite and Astro additionally need `server.allowedHosts: ['host.docker.internal']`, otherwise 403.
In Astro, `allowedHosts` for `preview` is read from `server`, not from `vite.server`.

> Why this comes first. Finding it out in the middle of the work cost five calls in a row:
> `ERR_CONNECTION_REFUSED` → the bridge IP → 403 → a guess. The check costs one call if it is made
> before the markup. Addressing details are in `help(topic: "addressing")`.

## 0.3 Two sessions from the start

The working session opens with motion frozen: screenshots and measurements in it are
reproducible, but hover, intro animations and transitions are **invisible** there — the stand
mutes them with `!important` and pins the blocks revealed on scroll (`data-lt-pinned`). The
`motionNote` in the `browser_open` and `browser_goto` answers says so.

So the second session — live, `animations: "allow"` — opens **right away** and lives in parallel.
That is where every hover, the intro animation (`browser_goto` with `frames`), the modals and
`interaction_audit` are checked.

> How this goes wrong. The live session was opened at the very end and checked in a few spots. In
> the working session the hover of overlapping elements looked fine; in the live one the hovered
> element jumped in z-index and the stacking flickered at the border. The hero intro showed its
> final frame before the JS started — invisible in a frozen session by definition.

## 0.4 The project's rules

Read `README.md`, `CLAUDE.md`, the bundler config. Find out:

- how the template wires up assets, icons and fonts — a plugin, aliases, a convention;
- which components must not be touched because they are shared across projects;
- what the project's CSS framework does to base elements.

> Why. The framework styled `p` and `h1..h6` directly through element selectors. A `font-size` on
> the parent did not inherit — it lost to the element rule. Half an hour spent on "why 17px
> instead of 32px".

## Gate

The project page opens through `browser_goto`; REST and the Figma editor are available or their
absence is agreed with the human; the working and the live sessions are open; it is known where
assets go and how they are wired in.
