# Working with several agents

How to split a large design: the base cost of an agent multiplies by their number, and tokens are the main constraint.

## When to read this

There are more pages than fit into one agent's context. A landing page is done by one agent and does not need this section.

## The cost of an agent

Before working, every agent loads the same things: project rules, the handbook, tool schemas, the frame map, comments, the UI kit. That is 40-60k tokens at the start, and each call then resends the whole context. At TOPGUN an inventory by seven agents cost 1.7M tokens, more than the build itself.

## Distribution

- **The orchestrator once** walks phases 0-1, pulls the comments and sorts them into a file. Agents do not call `figma_comments`.
- **Scope follows the agent's capacity**, not "one page, one agent": a guideline for the working model is 3-4 groups of medium pages in a row.
- **No more than two agents in parallel.** Five at once used up the account limit within an hour and were cut off mid-work; the stand evicts browser sessions and cannot take parallel heavy renders.
- **Model by task.** Design breakdown, the design system and the UI kit go to a strong model: mistakes there spread to every page. Building from a finished micro-spec goes to the working model.
- **Do not fragment the breakdown.** 2-3 agents for the whole design are enough, or the agent that will build the page does its breakdown.

## Shared files

The orchestrator prepares them before starting agents, in `docs/design/`:

| File | Contents |
|---|---|
| `README.md` | the frame map and section register |
| `comments.md` | comments by page, with animation references |
| `pages/*.md` | page micro-specs and decisions made |
| `ui-kit.md` | components and contracts: "take from here, do not rebuild" |
| `brief.md` | the common agent brief: prohibitions, scale, checks, report format |
| `status.md` | what is done, what was cut off, the task queue, the dev server port |

The agent prompt is then 10-20 lines: its frames, its files, the client's decisions on its blocks and a link to `brief.md`.

## Contracts and cut-offs

- Links between parallel agents are pinned down before they start: the `features` phase.
- An agent marks progress in `status.md` after each group of pages.
- A cut-off agent is not resumed: it drags its old 250-300k context through every step. A fresh agent with a narrow "finish this part" task, working from the micro-spec and status, is cheaper.
- The orchestrator starts the dev server once. An agent keeps at most two browser sessions and closes them at the end.

## Checks across agents

- **Page agent:** section comparison at design widths, one pass over its complex animations, a build check.
- **Final agent, once per site:** `layout_audit` at all widths, the animation switch, interactivity, shared build warnings.
