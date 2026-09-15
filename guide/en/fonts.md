# Phase 5. Fonts

Substituting a font changes the metrics — and with them every comparison that follows.

## Checklist

ENTRY: the assets are in the project.
STEPS:
  1. Which font the design uses (figma_tokens typography or figma_spec css) — commercial?
  2. Ask the human: are there files, what to substitute with.
  3. Substitution changes the metrics — heightNote in the comparison will not be zero; expected.
  4. Large sets — a subset by the project's glyphs, the script in the repository.
  5. @font-face only for the weights in use, font-display: swap.

## The order

1. **Find out what the design uses.** Usually a commercial font. Ask the human: are there files,
   and what to substitute with if there are not.
2. **Substitution changes the metrics.** Lines become taller or shorter than in the design, and
   the page drifts in height. That is expected and not a defect — but it means a pixel comparison
   on a long page is useless, and `heightNote` in the comparison reports will never be zero.
3. **CJK and other large sets are cut down by glyph.** The full Noto Sans SC is 8.3 MB. A subset
   built from the characters actually used in the project is 174 KB. Keep the subsetting script in
   the repository and re-run it after the texts change.
4. **`font-display: swap`**, and explicit `@font-face` only for the weights in use.

## Gate

Fonts are wired in, their weight is reasonable, the substitution is agreed with the human.
