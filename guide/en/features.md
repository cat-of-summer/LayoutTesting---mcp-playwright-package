# Phase 8. Shared functionality

What ties the pages together: booking, search, forms, modals, floating buttons. Built before the pages and pinned down by a contract.

## Checklist

ENTRY: the header and footer are ready.
STEPS:
  1. List the shared functions from the micro-specs: what is called from several pages or from the header.
  2. A contract for each: module, API, event names - written to docs/design/ui-kit.md.
  3. Implement the modules, with stub data if needed: the build must not depend on a page not yet built.
  4. Forms - form_audit; modals and menus - layout_audit with states; buttons - interaction_audit in the live session.
  5. Initial state and return: page_logs without likelyDefects, the header after load matches the header after returning to the top.

## 8.1 The contract comes before the pages

The "Book" button on a page opens the booking window from the header, a floating button lines up with "to top", a button on Home opens the menu. If the link is not pinned down, the page agent imports a file that does not exist yet and breaks the build for everyone.

```markdown
### booking
Module: src/js/booking.js
API: openBooking({ branch?, service? }), closeBooking()
Events: booking:open, booking:close
```

## 8.2 Checking the functionality

A field that erases input on re-render looks fine in any screenshot: `form_audit` types the value key by key and checks that it stayed. A library warning in the console is a likely defect: behind "Swiper Loop Warning" at TOPGUN was an empty slide, so `page_logs` puts such entries into `likelyDefects` and `page_ready` treats them as blockers.

## Gate

Shared functions are implemented and work from any page; contracts are written down; `form_audit` has no findings; `likelyDefects` is empty or waived one by one.
