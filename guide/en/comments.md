# Phase 3. Working through the comments

Every designer comment becomes a checkable requirement tied to a section.

## Checklist

ENTRY: the section register is ready.
STEPS:
  1. figma_comments(all frames) - once per project: the limit of 5 requests a minute is shared. No REST - figma_status action: token; if that fails, it is a blocker and a question to the human.
  2. docs/design/comments.md: comments by page and section, with the node id and animation references.
  3. Every requirement is a "- [ ]" item with a checkable wording, not a retelling.
  4. A reference to the UI kit or another page - figma_find, then figma_sync: pull it right away.
  5. A reference on another site - open it and watch the motion. Anything unclear - ask the human.

## 3.1 A comment is a checklist item

At the TOPGUN acceptance the comment "all cards are dimmed, hover removes it" was applied to only some cards. A comment that was read but has no completion mark cannot be told from a forgotten one, so each gets a line:

```markdown
### hero (280:6100)
- [ ] All cards are dimmed, hover removes the dimming (280:6667). Reference: animated-content.
- [ ] The numbers appear one by one from the top, after the caption.
```

These items move into the page micro-spec, and `page_ready` with `checklist` does not answer `ready: true` while any of them is open.

## 3.2 How to read comments

```
figma_comments(frames)   → requirements that are not in the design itself
figma_history(node)      → what changed in the design over a period (since the last handoff), field by field with diff: true
```

**Comments are read before building.** They are the only channel where requirements like "JS
hover animation here, like on the reference site" or "we are not doing this block yet" live. The
tool works through REST only; a missing token → `figma_status` with `action: token`, and only if
issuing fails is it a blocker to ask the human about.

A comment placed on a button belongs to the button, not to the whole frame: `figma_comments` on a
frame or a block returns the comments on its descendants too (`on: descendant`, a path and a link to
the element). `figma_inspect` and `figma_spec` show a `comments` digest for the node — if it is not
zero, read the threads with `figma_comments` on that node before building the block.

> On one landing page `figma_comments` was never called — the hover of three blocks was invented,
> while a comment pointed at a reference on a finished site. On another, "fix the spacing" and "a
> form goes here" also lived only in the comments.

A color word in a thread — "green", "brand" — comes from `figma_comments` with `colorHint`: which
colors the design actually uses in states. The designer's word is not a token name. A reference to a
state "in the UI kit" that is not among the synced frames is found with `figma_find` by text or name
— across every page of the file, with the variant set around the hit.

## Gate

The comments are read or their absence is agreed; each is placed in a section and written as a checkable item; references to other pages and the UI kit are pulled.
