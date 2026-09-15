# Phase 12. The whole project

Every width, the baselines, the build — and cleaning up afterwards.

## Checklist

ENTRY: every page passed the phase 11 gate.
STEPS:
  1. layout_stress(widths: the full range 320…1920) on every page.
  2. visual_baselines — the baselines; from then on visual_compare.
  3. web_vitals / lighthouse.
  4. npm run build → dist on the stand → repeat the phase 11 checks over the build.
  5. browser_close on every session, stop the dev server, remove one-off containers.

## The project-wide run

```
layout_stress(widths: [320, 360, 375, 414, 768, 1024, 1280, 1440, 1920])
visual_baselines → create the baselines; from then on visual_compare catches regressions
web_vitals / lighthouse
```

## The build, and checks over what was built

```
npm run build   →   serve dist   →   repeat the phase 11 checks
```

The dev server and the bundle are different builds, and that is not a formality: library CSS
imported from a client script is visible in dev and never reaches the bundle; `allowedHosts` for
preview is read from a different place in the config.

> It was precisely in the build that the font plugin turned out to crash on Windows when removing a
> duplicate, failing the whole build with a non-zero exit code. On the dev server none of it was
> visible.

Check in `dist`: no unused assets, the icons collapsed into a sprite, the fonts are wired in, the
size is reasonable.

## Clean up

- `browser_close` on every open session;
- remove one-off Docker containers, stop the dev server;
- run artifacts of the run — `artifacts_clean`, if disk space ran out.

## Gate

The run across every width is clean, the baselines exist, the build passes, and the phase 11 checks
have been repeated over `dist`.
