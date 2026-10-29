# Phase 0. Preparation

The stand, reaching the project, Figma access, two sessions and the project's own rules — before the first line of code.

## Checklist

ENTRY: the design frame links and the project path are known.
STEPS:
  1. stand_info — version, exposed groups, guide.available: true (otherwise tell the human).
  2. figma_status with figma: <frame link> - editor.state, rest.configured, file.editor.state, rest.tier1; rest: false → action: token yourself, no question; editor.state: needs_human → the editor.handoff.url link to the human; issuing failed → ask the human; file.editor.state: view_only → the stand makes a copy in drafts itself on the first figma_* (the team from FIGMA_DUPLICATE_TEAM or the human picks it in a form); a refusal or a client without forms → ask the human before the markup: edit access, a team for duplicate, or work by hand.
  3. dev server on 0.0.0.0 → browser_goto http://host.docker.internal:<port> answers 200.
  4. browser_open a second time with animations: "allow" — the live session; both with keepAlive: true, kept to the end.
  5. README, CLAUDE.md, bundler config — how assets are wired, what the CSS framework does to p and h1..h6; a dictionary of its utilities: tap area, icons, visibility.

## 0.1 The stand and access

```
stand_info                      → version, exposed tool groups, viewport presets, guide
help(topic: "figma")            → the entry point of the handbook
figma_status with figma: <frame> → are the editor channel and REST alive, and does this file open in the editor
```

`stand_info.guide.available: false` means the image was built without the handbook. That is a
build error — tell the human right away instead of quietly working from the built-in minimum.

**REST is needed before the snapshot, not "when it comes up".** Design comments exist only in
REST, and half the requirements live there ("JS hover animation here, like on the reference site").
`rest.configured: false` → `figma_status` with `action: token` — right away, without asking: the
login and password in the stand .env are set for exactly this, and the token is read-only. Figma
asked for a captcha, a 2FA code or an email confirmation (`editor.state: needs_human`) — give the
`editor.handoff.url` link to the human: it shows the live screen of the stand browser, the human
passes the check personally, the stand saves the login; then `action: token` again. Not issued for
another reason → a question to the human. A missing token is a blocker for phase 2, not a skip: on one landing page the comments were
never read, and the hover of three blocks was invented instead of taken from a comment.

**A login to the editor is not access to the file yet.** `editor.state: ready` only says the stand
is logged in. Whether the design itself opens in the editor is in `file` of the `figma_status`
answer with `figma`. `file.editor.state: view_only` means the file is shared with the stand account
for viewing only: Figma gives no Plugin API in that mode, and the editor channel will not work for
the file however many times it is retried. REST on a View seat is twenty file requests a month
across all projects (`rest.tier1`) - one or two tasks. If that is spent too, no `figma_*` works at
all. The ways out, most useful first:

1. edit access for the stand account from the file owner - then everything works;
2. a copy in the drafts of a team of the stand account, if the owner allowed copying. The first
   `figma_*` that goes into the file makes it itself: the team comes from `FIGMA_DUPLICATE_TEAM` in
   the stand .env, and without it the human picks one in a client form - the agent does nothing,
   the answer keeps `copy` with a "pulled from the copy" note. A client without forms or a refusal
   by the human - an explicit `figma_sync` with `duplicate: "<team>"` after asking the human
   (`duplicate: ""` returns the list of teams). The designer edits the original, not the copy:
   `copy.stale` in the answers means it is time to copy again;
3. neither - the ui channel: `figma_inspect` and `figma_export` with `channel: "ui"` read values
   from the properties panel of the Figma interface and export with the Export button, the
   comparison is `figma_compare` with `image` (a PNG from `figma_export`). `channel: "auto"` switches
   to ui by itself. The other `figma_*` work on a snapshot and are unavailable without one: build the
   structure from the `figma_inspect` tree with `depth`.

Choosing between them is a question to the human before the markup, not a discovery in the middle
of the work: in the feedback this section was written for, three calls went into an editor
`timeout` before the cause was found on a screenshot.

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

Both sessions open with `keepAlive: true`. Without it a session closes after 15 minutes idle, and
code gets written between checks — the mobile session closed between two comparisons, and
`keepAlive` was learned from the error text.

> How this goes wrong. The live session was opened at the very end and checked in a few spots. In
> the working session the hover of overlapping elements looked fine; in the live one the hovered
> element jumped in z-index and the stacking flickered at the border. The hero intro showed its
> final frame before the JS started — invisible in a frozen session by definition.

## 0.4 The project's rules

Read `README.md`, `CLAUDE.md`, the bundler config. Find out:

- how the template wires up assets, icons and fonts — a plugin, aliases, a convention;
- which components must not be touched because they are shared across projects;
- what the project's CSS framework does to base elements;
- **the framework dictionary**: which of its utilities handle the tap area, icon masks, visibility,
  the grid. Write it down briefly — the UI kit is checked against it in phase 3.

> Why. The framework styled `p` and `h1..h6` directly through element selectors. A `font-size` on
> the parent did not inherit — it lost to the element rule. Half an hour spent on "why 17px
> instead of 32px".

## Gate

The project page opens through `browser_goto`; the design can be pulled by at least one channel -
the editor for this file (`file.editor.usable`), a copy in drafts or REST with requests left - or
working through the ui channel (only `figma_inspect` and `figma_export`) is agreed with the human; the working and the live
sessions are open with `keepAlive: true`; it is known where assets go and how they are wired in.
