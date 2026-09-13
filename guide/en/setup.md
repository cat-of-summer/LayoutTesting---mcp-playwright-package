# Phase 0. Preparation

The stand, reaching the project, and the project's own rules — before the first line of code.

## 0.1 The stand and access

```
stand_info              → version, exposed tool groups, viewport presets
help(topic: "figma")    → the rules for reading a design
figma_status            → are the editor channel and REST alive
```

## 0.2 Reaching the project from the stand

The stand runs in a container and **cannot see the host's `localhost`**. Start the project and
check reachability immediately:

```
dev server on 0.0.0.0  →  browser_goto http://host.docker.internal:<port>
```

Vite and Astro additionally need `server.allowedHosts: ['host.docker.internal']`, otherwise 403.

> Why this comes first. Finding it out in the middle of the work cost five calls in a row:
> `ERR_CONNECTION_REFUSED` → the bridge IP → 403 → a guess. The check costs one call if it is made
> before the markup. Addressing details are in `help(topic: "addressing")`.

## 0.3 The project's rules

Read `README.md`, `CLAUDE.md`, the bundler config. Find out:

- how the template wires up assets, icons and fonts — a plugin, aliases, a convention;
- which components must not be touched because they are shared across projects;
- what the project's CSS framework does to base elements.

> Why. The framework styled `p` and `h1..h6` directly through element selectors. A `font-size` on
> the parent did not inherit — it lost to the element rule. Half an hour spent on "why 17px
> instead of 32px".

## Gate

The project page opens through `browser_goto`; it is known where assets go and how they are wired
in.
