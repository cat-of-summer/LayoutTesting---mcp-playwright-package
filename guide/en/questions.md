# Phase 7. Agreements with the human

Questions only a human can answer. Ask them before the first line of markup.

One question is cheaper than rebuilding a block.

## Checklist

ENTRY: the content is extracted, the disputed places are known.
STEPS:
  1. Collect the questions: fonts, amount of animation, placeholders, adaptivity between frames, data, disputed places, contrast.
  2. Every question with options where "do it" is no worse than "skip it"; "the block is not in the frame" — search the file first, then ask.
  3. Do not ask what a check can settle.

## What to ask

- **Fonts** — are there files for the commercial one, and what to substitute with.
- **How much animation** — everything from the prototype, part of it, or none.
- **Placeholders** — language versions and sections that are not in the design.
- **Adaptivity between frames** — fluid `clamp()` or fixed states.
- **Data** — how many items the real list holds.
- **Contradictions in the design** — conflicts, `drift`, obvious designer mistakes.
- **Contrast coming from the palette** — if low contrast comes from brand colors, the agent has no
  right to change them. That is the human's decision.

## How to phrase a question

The phrasing must not nudge towards what is cheaper for the agent. The mobile frame had no header,
and it started with a gap for one — a clear sign that the header exists somewhere in the file. It
was not searched for; instead the question was phrased as "static blocks without a header
(Recommended)" against "with dropdowns — give me the node-id", and the human chose the first
because the second demanded work from them. The header sat in the file as a separate frame. The
right way: search first (phase 1), and only if nothing is found — "I could not find the header in
the file: where is it, or should I build a placeholder?" with no recommendation in favour of
"skip it".

## What not to ask

Anything a check can settle: read the code, run the query, look at the config. Ask where only the
human knows: priorities, intentions, access, decisions about risk.

## Gate

The answers are in.
