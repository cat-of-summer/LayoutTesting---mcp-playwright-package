# Saving context

Save on images and repeats, not on the semantic comparison.

## The main rule

At TOPGUN the semantic comparison was replaced by height measurements. The heights matched, and the acceptance found text running into buttons and wrong colors, fonts and letter case. `figma_compare` with `compact: true` pulls no images and costs about as much as one measurement, so it is mandatory on every section.

## What to do

- **Images in context are for pinpoint diagnosis only**, at most six per task. `figma_export` and `screenshot` without `inline`.
- **Compact answers:** `compact: true` on `figma_compare`, `figma_export`, `figma_behavior`, `figma_tokens`. The full answer stays in an artifact, its address is in `full`.
- **Animations as numbers:** `motion_frames` returns tracks, and the contact sheet is viewed once per animation.
- **Read documents in parts:** the needed components from the UI kit, your own sections from the comments. `figma_spec` with `sections` and `depth` 2-4, not a whole frame.
- **One comparison pass per width**, repeats only for fixed sections.
- **An agent report is up to 300 words.**

## What not to do

- Do not render a whole Figma canvas: canvas contents come from `figma_inspect(canvas, depth: 1)`, renders go frame by frame, in batches of 4-7.
- Do not waive an audit signal to save tokens: waivers go one by one through `waivers` of `page_ready`, with a reason for the specific element.
- Do not treat a comparison as impossible when a render was removed from artifacts: stand artifacts are cleaned over time, so render the node again.
