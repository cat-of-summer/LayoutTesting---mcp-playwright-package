# Symptom → tool

A quick-choice table: what you came with and what to look at it with.

## The design

| Symptom | What to look with |
|---|---|
| I do not know which frames to build | `figma_structure` with `depth: 1` and `figma_export` with `kind: "render"` |
| More than a hundred frames in the file | `figma_sync` without a node-id, with `page` and `offset` |
| I do not know where the node from the task sits or who its parent is | `path` in the `figma_inspect` and `figma_sync` answers |
| The frame has no header, footer, modal — but a gap for them | search the file: `figma_sync` without a node-id, `figma_components`; ask the human afterwards |
| A tall mobile frame is unreadable in parts | `figma_export` with `parts: "children"` — one part per child frame |
| An element sticks out past its parent, the render shows it whole | `clipped` in the `figma_export` answer; `[clip]` on the parent in the outline — trust the design |
| I am starting on a block and do not know where to begin | `figma_spec` — tree, paint, texts and assets in one call |
| Not sure the block is taken apart to the end | `unresolved` in the `figma_spec` answer: collapsed nodes, svg without a color, links not synced |
| Three identical cards, something is aligned "by itself" | `parallels` in `figma_components` — fixed heights across instances |
| I do not know a node's color, stroke, radius, opacity | `figma_inspect` with `mode: "outline"` — paint sits in the curly braces |
| The text is cut with an ellipsis | `figma_inspect` with `mode: "text"`, or the `text` section of `figma_spec` |
| I do not know what an element does | `figma_behavior`, `figma_comments` |
| I do not know what a variant switches into | `figma_sync` on the link from `notSynced` |
| I do not know what to export from here | the `assets` section of `figma_spec`: `plan` holds ready export lists |
| I need an icon | `figma_export` with `kind: "svg"` on the node id |
| The icons on the page are black | `monochrome: true` in the export answer — set the wrapper `color` from the `color` field |
| I need a photo | `figma_export` with `kind: "image"` and `scale: 2` |
| A shape with an image fill, a crop, a rotation | `figma_export` with `kind: "render"` |
| The export refused: "no visible layers" | a hidden layer — repeat with hidden layers shown |
| A heavy PNG | `image_convert` to WebP |

## Comparison

| Symptom | What to look with |
|---|---|
| Do the texts and type sizes match | `figma_compare` with `mode: "semantic"` |
| Do the backgrounds, borders, lines and radii match | the `paint` section of the same report |
| Does the picture match, not just the texts | `figma_compare` with `sections: true` — pixel per section |
| What has not been compared for this frame yet | `coverage` in the `figma_compare` answer |
| A node is "not found" in `paint` | check which bucket: `shifted` — it moved, and by how much is shown; `notFound` — it was nowhere |

## The markup

| Symptom | What to look with |
|---|---|
| My edit did not apply | `computed_styles` → `matched_rules` → restart the dev server |
| The element is invisible or covered | `element_layers` |
| It broke on a narrow screen | `layout_stress` with the `widths` scenario |
| Never checked between the design widths | `layout_audit` with `widths` from `figma_sync.widths.suggested` |
| Hover, intro, a transition is invisible | a session with `animations: "allow"`; the intro — `browser_goto` with `frames` |
| A style is overridden by something with `!important` that is not mine | `overriddenByStand` in `computed_styles` and `matched_rules` — a frozen session |
| The validator complains about library conventions | `validate_html` with `ignore` — the noise goes to `ignored` |
| It breaks on long text or a big list | `layout_stress` |
| Does the slider, the accordion, the button work | `interaction_audit` in a session with `animations: "allow"` |
| Is the animation honest | the same tool: `timing.smooth` and `durationMs` |
| What is wrong with this page at all | `audit` — the cheapest first step |
| Did I break something that used to work | `visual_baselines` → `visual_compare` |
