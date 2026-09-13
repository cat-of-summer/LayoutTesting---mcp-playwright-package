# Building markup from a design

A map of the phases: what to do in what order, and what closes each one.

This guide is assembled from real mistakes — eleven bugs from the review of one landing page, plus
the ones the tools found afterwards. Every rule is backed by a case where breaking it cost rework.

## How to read it

The sections are phases. They run in order, and each has a **gate**: the condition under which the
phase counts as closed and the next one can begin. A gate is not a formality: almost every
expensive rework happened where a phase was closed "roughly".

If you read one section of this guide, read `rules`. If you are looking for the tool that fits a
symptom, read `symptoms`.

## The phases

| Section | Phase | About |
|---|---|---|
| `setup` | 0 | the stand, reaching the project, the project's own rules |
| `frames` | 1 | reconnaissance: which frames are actually pages |
| `inventory` | 2 | blocks, links between them, standard elements |
| `system` | 3 | tokens, components, breakpoints |
| `assets` | 4 | icons, images, the paint that lives on the node |
| `fonts` | 5 | substitution, metrics, subsets |
| `content` | 6 | text into data, line-break artifacts |
| `questions` | 7 | what to ask the human before the first line |
| `motion` | 8 | animations and element states |
| `shell` | 9 | header, footer, UI kit |
| `block` | 10 | the block cycle — the central section |
| `page` | 11 | the whole page |
| `project` | 12 | the whole project and the build |

## Two reference sections

- `rules` — the ten rules whose violation produced bugs. One page.
- `symptoms` — a "symptom → what to look with" table.

## What is not here

Caveats about individual tools: response shape, parameter details, engine support. Those are
`help` with `tool: name`. The guide says what to do; `help` says how a tool works.
