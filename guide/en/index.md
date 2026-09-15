# Building markup from a design

The order of work: thirteen phases, walked one at a time rather than read all at once.

This guide is assembled from real mistakes — two shipped landing pages and the findings the tools
surfaced afterwards. Every rule is backed by a case where breaking it cost rework.

## How to work with this

It is a procedure, not a reference book. The order is:

1. Call `help(guide: "setup")` — phase 0.
2. Do what it says.
3. Re-read the phase briefly — `help(guide: "setup", brief: true)`: the checklist and the **gate**
   only, the condition under which the phase counts as closed. Two hours in, the context is
   compressed and ten steps are remembered as a feeling rather than a list; the brief form costs
   one call.
4. Once the gate is closed, call the next phase; its name is right there at the end of the section.

Every phase names the next one, so there is no need to hold the whole list in your head — only
which phase you are on.

A gate is not a formality. Almost every expensive rework happened where a phase was closed
"roughly": the stand's reachability from the project was not checked, and five calls went on
diagnosing it mid-build; the design comments were never read, and the hover was invented; section
heights were compared instead of the picture, and the page shipped with black icons and a row
shifted by 32px.

Two sections sit outside the sequence and are read at any time: `rules` — the rules and
prohibitions on one page, and `symptoms` — the "symptom → tool" table.

The same text is available without a tool call: `GET /skill/layout-by-figma/SKILL.md` on the
stand — the phase map, the rules and the checklists as one file for an agent skill;
`GET /guide/en/<section>.md` — any section in full.

## The phases in full

The list is here only to show the scale of the work. Do not walk it from here — follow the chain,
each phase leads to the next.

| Section | Phase | About |
|---|---|---|
| `setup` | 0 | the stand, reaching the project, Figma access, two sessions, the project's rules |
| `frames` | 1 | reconnaissance: which frames to build, what is clipped, what is not a frame |
| `inventory` | 2 | blocks, links, comments, standard elements |
| `system` | 3 | tokens, components, breakpoints |
| `assets` | 4 | icons, images, the paint on the node, the color of monochrome icons |
| `fonts` | 5 | substitution, metrics, subsets |
| `content` | 6 | text into data, line-break artifacts |
| `questions` | 7 | what to ask the human before the first line |
| `motion` | 8 | animations, initial states, element states |
| `shell` | 9 | header, footer, UI kit |
| `block` | 10 | the block cycle — the central section |
| `page` | 11 | the whole page, at every width |
| `project` | 12 | the whole project and the build |

## What is not here

Caveats about individual tools: response shape, parameter details, engine support. Those are
`help` with `tool: name`. The guide says what to do; `help` says how a tool works.
