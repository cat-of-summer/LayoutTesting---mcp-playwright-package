# Stand tools

Generated from the server itself: `node bin/gen-tools-doc.mjs`. Do not edit by hand —
edit the descriptions in `src/tools/` and regenerate.

Tools in total: **56**. Manifest size: **61967** characters.

## `a11y_axe`

**axe-core check** — _read-only_

WCAG rules (axe-core) against the open page. Works with its current state, so it also sees what is behind a login, an expanded menu or a tab — unlike checks that take a bare URL. The second rule set is a11y_pa11y; they find different things.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `tags` | array | For example wcag2aa, wcag21aa, best-practice |
| `include` | array |  |
| `exclude` | array |  |

## `a11y_pa11y`

**pa11y check** — _read-only_

A second accessibility rule set (HTML CodeSniffer), by URL. The axe and pa11y sets overlap only partly, so a real WCAG check needs both: what one silently passes, the other reports.

| Parameters | | |
|---|---|---|
| `url` | string | required |
| `standard` | `WCAG2A` \| `WCAG2AA` \| `WCAG2AAA` |  |

## `artifacts_clean`

**Clean up artifacts** — _removes data_

Removes old runs, keeping the last keep ones. Usually unnecessary: pruning happens on its own whenever a new run is created. Worth calling when disk space ran out right now. Saved site mirrors are left untouched.

| Parameters | | |
|---|---|---|
| `keep` | number |  |

## `artifacts_list`

**Run artifacts** — _read-only_

Runs stored on the stand, newest first, with links to their directories. This is where you take the address of a previous run to compare against the current one or to show a human. Old runs are pruned automatically.

| Parameters | | |
|---|---|---|
| `limit` | number |  |

## `audit`

**Check a page**

A composite check of one page: opens the URL under the given viewing conditions and runs the selected checks at once. The cheapest first step when the question sounds like "check this page" or "what is wrong here": one call returns a summary with a verdict and stores the artifacts, and from there it is clear what to dig into.

| Parameters | | |
|---|---|---|
| `url` | string | required |
| `checks` | array |  |
| `name` | string | Run name; used in file and baseline names |
| `mask` | array |  |
| `hide` | array | Remove from frame: cookie banners, chat widgets, popups |
| `fullPage` | boolean |  |
| `updateBaseline` | boolean |  |
| `waitUntil` | `load` \| `domcontentloaded` \| `networkidle` \| `commit` | What to wait for on navigation. For heavy production sites use domcontentloaded |
| `timeout` | number | Navigation timeout, ms |
| `browser` | `chromium` \| `firefox` \| `webkit` | Browser engine |
| `viewport` | string | Size: WxH or a preset name (mobile, mobile-sm, tablet, laptop, desktop, wide) |
| `colorScheme` | `light` \| `dark` \| `no-preference` |  |
| `profile` | string | Name of a saved condition profile: the remaining conditions are taken from it. See stand_info for the list |

## `browser_act`

**Act on the page**

Click, type, press a key, hover, scroll, select an option, wait for a selector, pick files for upload or decide what to do with alert and confirm. Needed when the state you want to check only appears after an action: an expanded menu, an opened tab, a filled form, a page behind a login. Ready-to-use selectors come from page_snapshot.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `action` | `click` \| `fill` \| `press` \| `hover` \| `scroll` \| `wait` \| `select` \| `upload` \| `dialog` | required |
| `selector` | string | Not required for scroll, for dialog, and for press or a click by coordinates |
| `value` | string | Text for fill, key for press, option value for select, accept \| dismiss \| reply text for dialog |
| `files` | array | For upload: file paths relative to the stand working directory |
| `x` | number | Horizontal scroll amount; for a click without a selector, the x coordinate |
| `y` | number | Vertical scroll amount; for a click without a selector, the y coordinate |
| `timeout` | number | How long to wait for the element, ms. Default 30000 |
| `force` | boolean | Click without waiting for the element to be actionable: under pointer-events: none it otherwise waits out the whole timeout |

## `browser_close`

**Close session** — _removes data_

Closes a session and frees its memory. Worth calling once you are done with a page: each session holds its own browser context. They do close on their own once idle or when the cap is reached, but do not rely on that.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |

## `browser_eval`

**Run JS on the page**

Evaluates an expression or a function body in the page context and returns the result. Accepts an IIFE, a chained .map(function(){return …}), or several statements ending with return. If the result is undefined that is stated explicitly instead of returning an empty answer.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `expression` | string | required |

## `browser_goto`

**Navigate**

Navigates in an already open session. The page is stabilized before checks run: animations are stopped and fonts are awaited, otherwise screenshots and measurements drift between runs. animations: "allow" brings the motion back — here for one navigation, in browser_open for the whole session. If some resources failed to load, that is reported in warnings rather than left to be discovered as empty boxes on a finished screenshot.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `url` | string | required |
| `waitUntil` | `load` \| `domcontentloaded` \| `networkidle` \| `commit` |  |
| `animations` | `freeze` \| `allow` | One-off, for this navigation only: allow leaves the page motion alone |
| `save` | boolean | Save the page into the local mirror right after navigating — after that it can be examined without touching the remote server |

## `browser_open`

**Open browser**

Creates a browser session with the given viewing conditions and, if a url is passed, navigates to it right away. Returns a sessionId used by every other session-based tool. Viewing conditions cover engine, viewport, dark mode, RTL, zoom, forced colors, DPR, locale and access (basic auth, headers, host mapping).

| Parameters | | |
|---|---|---|
| `url` | string |  |
| `browser` | `chromium` \| `firefox` \| `webkit` | Browser engine |
| `viewport` | string | Size: WxH or a preset name (mobile, mobile-sm, tablet, laptop, desktop, wide) |
| `colorScheme` | `light` \| `dark` \| `no-preference` |  |
| `forcedColors` | `none` \| `active` | Windows high contrast mode |
| `reducedMotion` | `reduce` \| `no-preference` |  |
| `animations` | `freeze` \| `allow` | allow leaves the motion alone: transitions and animations keep running |
| `rtl` | boolean | Flip the page to right-to-left |
| `zoom` | number | Page zoom in percent: 200 halves the viewport |
| `textZoom` | number | Text-only zoom in percent (WCAG 1.4.4) |
| `pseudoLoc` | boolean | Pseudo-localization: diacritics and +40% string length |
| `deviceScaleFactor` | number | Device pixel ratio: 1, 2, 3 |
| `locale` | string |  |
| `timezoneId` | string |  |
| `userAgent` | string | A User-Agent string of your own: some sites answer a headless browser with 403 |
| `freezeTime` | boolean | Freeze Date and Math.random for stable screenshots |
| `throttle` | object | Throttling (chromium only): network 3g\|slow-3g\|4g, cpu is a slowdown multiplier |
| `auth` | string | HTTP basic auth as "user:password". Do not put credentials in the URL itself — they leak into every response afterwards |
| `extraHTTPHeaders` | object | Headers added to every request: Accept-Language, X-Forwarded-Proto and so on |
| `hostMap` | object | Name resolution override: {"www.site.local": "172.20.0.5"} — for environments behind a vhost. Chromium only |
| `storageState` | string | Name of a state saved with browser_storage: the session opens already logged in |
| `serviceWorkers` | `allow` \| `block` | block — stop the Service Worker from serving its own cache instead of the server |

## `browser_profile`

**Viewing condition profiles**

Pins the conditions of an open session under a name, so they can be given as one word: profile: "mobile-dark" in audit, screenshot, seo_page, web_vitals, page_save. That keeps rare conditions — zoom, RTL, throttling, hostMap, pseudo-localization — reachable from those tools without taking up room in their schema.

| Parameters | | |
|---|---|---|
| `action` | `save` \| `list` \| `remove` | Default list |
| `sessionId` | string | The session whose conditions are captured — required for save |
| `name` | string | Profile name — required for save and remove |
| `persist` | boolean | Write the profile to disk so it survives a stand restart. By default a profile lives in process memory only |

## `browser_route`

**Intercept requests**

Rules over the page network requests: cut analytics and chat widgets, replace a stylesheet or a script with your own version, stub missing images, rewrite addresses when the site returns absolute links to a production domain. With record a rule also captures what actually went to the server — read it back with action: requests.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `action` | `add` \| `list` \| `clear` \| `requests` | Default add. requests returns what the rules with record captured |
| `pattern` | string | A glob (**/analytics/**) or a regular expression written as /…/flags |
| `handler` | `block` \| `fulfill` \| `file` \| `redirect` \| `rewrite` \| `passthrough` | block — abort, fulfill — return a body, file — serve a file from the stand, redirect — send every match to one url, rewrite — replace part of the address while keeping the path |
| `body` | string |  |
| `contentType` | string |  |
| `status` | number |  |
| `url` | string | Where to send the request for redirect |
| `file` | string | Path relative to the stand working directory |
| `from` | string | For rewrite: what to replace in the address. A substring or a regular expression written as /…/flags, e.g. /^https?:\/\/site\.ru/ |
| `to` | string | For rewrite: the replacement. $1, $2 work with a regular expression |
| `record` | boolean | Capture matching requests: method, address, headers and body. For multipart — the field list and file names |
| `id` | string | For requests: show the entries of this rule only |
| `limit` | number | For requests: how many of the most recent entries to show. Default 20 |

## `browser_sessions`

**List sessions** — _read-only_

Which browser sessions are open right now, with their viewing conditions and current URL. Useful when a session was opened earlier and its id got lost. Alongside them, recentlyClosed lists sessions that were closed, why, and the conditions to reopen an equivalent one.

_no parameters_

## `browser_storage`

**Cookies and storage**

Reads and injects cookies, localStorage and sessionStorage; export and import carry a session state through disk. That is how a login survives browser_close and a stand restart.

| Parameters | | |
|---|---|---|
| `sessionId` | string | Not required only for action: list |
| `action` | `get` \| `set` \| `clear` \| `export` \| `import` \| `list` | Default get |
| `scope` | `cookies` \| `local` \| `session` \| `all` | Default all |
| `name` | string | Key for set in local and session; file name for export and import |
| `value` | string | Value for set. For cookies — JSON: a cookie object or an array of them |

## `browser_style`

**Patch CSS/JS onto the page**

Injects your own CSS or JS on top of the open page and reapplies it after every navigation. This is how you try a fix against someone else's or a production site without touching it: add a rule, take a screenshot, compare.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `action` | `add` \| `remove` \| `clear` \| `list` | Default add |
| `css` | string | CSS text |
| `js` | string | A script, executed on add and after every navigation |
| `href` | string | Attach a stylesheet by URL |
| `id` | string | Patch label: adding again with the same id replaces the previous one |

## `compare_layout`

**Compare layout of two pages**

Compares a mockup and a built page by DOM rather than by pixels: which classes exist in only one of them, and how same-named blocks differ in box size, font, spacing and grid. Independent of content, so it answers "does the layout match" where a pixel diff is useless because texts and photos differ.

| Parameters | | |
|---|---|---|
| `a` | object | The reference side — usually the mockup. required |
| `b` | object | The page under test. required |
| `viewport` | string |  |
| `tolerance` | number | Size tolerance in pixels, default 2 |
| `props` | array | Which CSS properties to compare |
| `maxItems` | number |  |

## `compare_pages`

**Compare two live pages**

Compares two live pages pixel by pixel across a list of widths: a mockup against the built page. Each side has its own HTTP access and its own conditions. Different heights are not a problem — frames are padded to a common canvas and the height difference is returned separately.

| Parameters | | |
|---|---|---|
| `a` | object | What counts as the reference — usually the mockup. required |
| `b` | object | The side under test — usually the built page. required |
| `viewports` | array | Default desktop |
| `name` | string |  |
| `selector` | string | Compare only this block |
| `fullPage` | boolean |  |
| `hide` | array |  |
| `mask` | array |  |
| `threshold` | number | Allowed difference as a percentage of pixels |

## `computed_styles`

**Computed styles** — _read-only_

Geometry and final CSS properties of an element — to understand why a block is not where it is expected. Handles pseudo-elements (::before, ::after) and all matches of a selector at once.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `selector` | string | required |
| `props` | array |  |
| `pseudo` | `::before` \| `::after` \| `::marker` \| `::placeholder` \| `::selection` \| `::first-line` \| `::first-letter` | Look at the pseudo-element instead of the element itself |
| `all` | boolean | All matches of the selector, not just the first one |
| `maxItems` | number |  |

## `crawl`

**Crawl a site**

Crawls a site along its internal links and stores the pages in a local archive. Returns control immediately and runs in the background — follow the progress with action: status. crawl_pages, crawl_query and seo_report work off the finished archive.

| Parameters | | |
|---|---|---|
| `action` | `start` \| `status` \| `stop` \| `resume` \| `list` \| `delete` | Default start |
| `url` | string | Where to start. Required for start |
| `siteId` | string | Crawl name. Taken from the host by default |
| `maxPages` | number | Default 500 |
| `maxDepth` | number | Depth from the starting page. Default 5 |
| `delayMs` | number | Pause between requests. Default 500 |
| `render` | `auto` \| `never` \| `always` | auto (default) starts a browser only for pages that look empty without JS |
| `sameOrigin` | boolean | true (default) — same host only; false also allows subdomains |
| `include` | string | Regular expression: take only matching addresses |
| `exclude` | string | Regular expression: skip matching addresses |
| `respectRobots` | boolean | Default true. Turn it off only for your own environments — the fact that it was off goes into the report |
| `userAgent` | string |  |
| `storageState` | string | Name of a login saved with browser_storage — for sections behind auth |
| `auth` | string | HTTP basic auth as "user:password" |
| `extraHTTPHeaders` | object |  |
| `assets` | boolean | Whether to fetch resources for the mirror. Default yes |
| `scripts` | `strip` \| `keep` |  |

## `crawl_pages`

**Pages of a crawl** — _read-only_

Selects over stored pages: filter by status code, depth, indexability, missing fields and word count; full-text search; grouping to find duplicate titles and descriptions. Returns a list of pages with their fields, not their markup — for markup use read_artifact or crawl_query.

| Parameters | | |
|---|---|---|
| `siteId` | string | required |
| `filter` | object |  |
| `text` | string | Search for a substring in the visible text of stored pages |
| `groupBy` | `title` \| `description` \| `h1` \| `canonical` | Group and show only groups larger than one page — that is, duplicates |
| `fields` | array | Which fields to return. All of them by default |
| `limit` | number | Default 50 |
| `offset` | number |  |

## `crawl_query`

**Selector across the archive** — _read-only_

Applies a CSS selector to every stored page and returns the matching nodes together with the page they came from. This answers questions like "where are inline styles still used", "which pages have no breadcrumb markup", "where do links open in a new tab without rel=noopener". The answer is a list of nodes, not of pages — a different question from crawl_pages.

| Parameters | | |
|---|---|---|
| `siteId` | string | required |
| `select` | string | CSS selector. required |
| `attr` | string | Which attribute to read off the matched nodes |
| `filter` | object |  |
| `limit` | number | How many pages to show in detail. Default 50 |
| `offset` | number | Skip this many matching pages, to reach the ones beyond the first batch |

## `element_layers`

**Layers and overlaps** — _read-only_

Why an element is invisible and who lies on top of it. Warns separately about a dead z-index: set on position: static, or resolved inside somebody else stacking context.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `selector` | string | required |
| `pseudo` | `::before` \| `::after` \| `::marker` \| `::placeholder` | Inspect the pseudo-element instead of the element itself |
| `maxItems` | number |  |

## `figma_behavior`

**Behavior from the prototype** — _read-only_

What is wired to what: which button opens which modal, what switches a component variant, where scrolling to an anchor happens, what stays pinned while scrolling. Links are grouped by target — six identical chevrons are one handler. Transitions come back as a ready transition line.

| Parameters | | |
|---|---|---|
| `figma` | array | figma.com links or key:id entries. Nodes of one file go out in a single request. required |
| `limit` | number | How many lines or entries to show |
| `offset` | number | Where to continue: the value from the note hint |

## `figma_breakpoints`

**One screen across widths** — _read-only_

Matches frames of one screen at different widths by content rather than position: what is the same element, what changed (sizes, spacing, layout direction), what disappeared, what replaced it and where the reading order diverges. Linearly changing values come back as a ready clamp().

| Parameters | | |
|---|---|---|
| `figma` | array | Frames of one screen at different widths: desktop, tablet, mobile. required |
| `limit` | number | How many lines or entries to show |

## `figma_comments`

**Design comments** — _read-only_

Figma comments with replies and Dev Mode annotations anchored to elements, so "fix the spacing" says what it is about. Half the requirements live here rather than in the design itself. REST channel only: the Plugin API has no access to comments.

| Parameters | | |
|---|---|---|
| `figma` | array | figma.com links or key:id entries. Nodes of one file go out in a single request. required |
| `resolved` | boolean | Include resolved threads too. Open ones only by default |
| `refresh` | boolean | Ask Figma again instead of taking the list from the 5-minute cache |
| `limit` | number | How many lines or entries to show |
| `offset` | number | Where to continue: the value from the note hint |

## `figma_compare`

**Does the build match the design**

Compares a page against a design frame: texts are matched by content, and each one shows its offset, size and typography differences — with a selector and a node id. The pixel diff comes as a second layer, a difference map. Separately lists what the page lacks and what the design lacks.

| Parameters | | |
|---|---|---|
| `figma` | string | A node: a figma.com link or a key:id entry. required |
| `sessionId` | string | A session with the page open: the comparison runs against it |
| `url` | string | A page address: the stand opens it itself at the width of the design frame |
| `selector` | string | The block on the page the design frame corresponds to |
| `mode` | `both` \| `semantic` \| `pixel` | both (default) — semantic and pixel; semantic — semantic only; pixel — pixel only |
| `tolerance` | number | Offset tolerance in pixels. Default 2 |
| `threshold` | number | Allowed difference as a percentage of pixels |
| `limit` | number | How many lines or entries to show |

## `figma_components`

**Design components** — _read-only_

Groups UI elements across frames so classes do not multiply: instances of one component and blocks with the same content collapse into one with modifiers. Separately shows drift — differences of a pixel or half a tone worth normalizing — and matches with existing project classes.

| Parameters | | |
|---|---|---|
| `figma` | array | figma.com links or key:id entries. Nodes of one file go out in a single request. required |
| `project` | object | A project to compare against: a page url — the stand collects its CSS itself — or CSS or SCSS text |
| `limit` | number | How many lines or entries to show |
| `offset` | number | Where to continue: the value from the note hint |

## `figma_export`

**Export from the design**

Files from the design into artifacts with permanent links: render — a PNG of a node, tall frames cut into readable parts; svg — icons with currentColor; image — raster fills cropped as in the design.

| Parameters | | |
|---|---|---|
| `figma` | array | figma.com links or key:id entries. Nodes of one file go out in a single request. required |
| `kind` | `render` \| `svg` \| `image` | render (default) — a PNG of the node; svg — vectors and icons; image — raster fills cropped as in the design |
| `scale` | number | Scale 0.5–4. For render it defaults to a readable width of about 1000px, for image to 1 and 2 |
| `clip` | object | For render: cut out a rectangle in node coordinates |
| `inline` | boolean | Embed the image in the response. Links only by default |

## `figma_inspect`

**Design node** — _read-only_

A design node from the snapshot: outline — the layer tree with sizes, layout and texts, identical siblings collapsed; css — compact node styles. Replaces get_metadata and get_design_context without a call limit.

| Parameters | | |
|---|---|---|
| `figma` | string | A node: a figma.com link or a key:id entry. required |
| `mode` | `outline` \| `css` | outline (default) — the layer tree with layout and texts; css — node styles |
| `depth` | number | Traversal depth. Default 6 for outline and 2 for css |
| `hidden` | boolean | Include hidden layers |
| `limit` | number | Default 200 outline lines or 60 css nodes |
| `offset` | number | Where to continue: the value from the note hint |

## `figma_status`

**Figma access** — _read-only_

Figma access: whether the REST token works and how much of the limit is left, whether the stand is logged into the editor, whether the API version fell behind. Never reveals secrets. The first step when figma_* fail; action: login logs into the editor again or finishes a login with a code.

| Parameters | | |
|---|---|---|
| `action` | `check` \| `login` \| `logout` \| `token` | check (default) — inspect; login — log into the editor again or finish a login with a code; logout — forget the saved login; token — issue a REST token through the account settings |
| `otp` | string | A two-factor authentication code, if Figma asked for one |
| `refresh` | boolean | Ask Figma again instead of using the check cached for 10 minutes |

## `figma_structure`

**Markup structure** — _read-only_

What the frame becomes in markup: a tree of tags and classes built from geometry rather than from layers. Backgrounds, decorations and overlays are pulled out, shuffled layers are reparented, repeats collapse into a list. Content slots for layout_stress come with it.

| Parameters | | |
|---|---|---|
| `figma` | string | A node: a figma.com link or a key:id entry. required |
| `depth` | number | Tree depth. Default 10 |
| `limit` | number | How many lines or entries to show |
| `offset` | number | Where to continue: the value from the note hint |

## `figma_sync`

**Pull the design**

Pulls design nodes into a local snapshot with one request per file: desktop, mobile, modals — all at once. Later analysis reads the snapshot without calling Figma. Returns a per-frame summary, the channel used and how many requests were spent.

| Parameters | | |
|---|---|---|
| `figma` | array | figma.com links or key:id entries. Nodes of one file go out in a single request. required |
| `refresh` | boolean | Check the file version with Figma even if the snapshot is fresh |
| `channel` | `auto` \| `rest` \| `editor` | auto (default) — the editor if the stand can log into it, otherwise REST; rest and editor — that channel only |
| `css` | boolean | Add the CSS computed by Figma itself. Editor channel only, about 13 ms per node |

## `figma_tokens`

**Design tokens** — _read-only_

What becomes a CSS variable: palette, typography, spacing and radius scales, shadows, durations. Shows how often a value is hardcoded while a Figma variable exists, merges colors the eye cannot tell apart, derives component variables from variants and clamp() for values that change with width.

| Parameters | | |
|---|---|---|
| `figma` | array | figma.com links or key:id entries. Nodes of one file go out in a single request. required |
| `project` | object | A project to compare against: a page url — the stand collects its CSS itself — or CSS or SCSS text |
| `minUses` | number | A value becomes a token from this many uses. Default 2 |

## `help`

**Stand reference** — _read-only_

Details deliberately left out of tool descriptions: how to address targets from inside the container, how url differs from internalUrl, how to set rare viewing conditions, what response size caps apply, how long a session lives, in what order to work through a typical task. With no arguments it lists the topics. tool: name gives the caveats of one tool.

| Parameters | | |
|---|---|---|
| `topic` | `addressing` \| `artifacts` \| `profiles` \| `limits` \| `sessions` \| `workflows` \| `figma` | Topic. With no arguments, lists the topics |
| `tool` | string | Tool name: the caveats and details specific to it |

## `layout_audit`

**Layout heuristics** — _read-only_

Finds horizontal scroll, elements past the viewport, overlapping content, clipped text, text under an opaque layer, dead z-index (set on position: static), broken images, images without dimensions, small tap targets and low contrast. The first thing to run when the complaint sounds like "the layout is broken".

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `minTarget` | number | Minimum tap target size in px (default 24) |
| `contrastRatio` | number | Required contrast for normal text (default 4.5) |
| `maxItems` | number | How many examples to show per category (default 50) |
| `categories` | array | Details for these categories only. Counters for all of them are always returned |
| `include` | array | Inspect only these blocks — the header and the footer otherwise pad the counters with their own findings |
| `exclude` | array | Skip these blocks |

## `layout_stress`

**Content stress test**

Replaces the content of a live page and watches what breaks: longer and empty text, a word with no break opportunities, a list of twelve items and of one, a vertical and a broken image, a range of widths. Reports only what the replacement caused and puts the page back as it was.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `scenarios` | array | Which scenarios to run. All by default: text, lists, images, widths |
| `selectors` | array | What to replace. Without them the stand picks on its own: texts, lists and images of the page |
| `factor` | number | How many times longer to make the text. Default 3 |
| `items` | number | How many items to grow a list to. Default 12 |
| `widths` | array | Widths to run through. From 320 to 1440 by default |
| `maxItems` | number | How many findings to show per scenario. Default 20 |

## `lighthouse`

**Lighthouse report**

A full Lighthouse run. Returns category scores (performance, accessibility, best practices, SEO), metrics and failing audits, and writes the HTML report into artifacts.

| Parameters | | |
|---|---|---|
| `url` | string | required |
| `categories` | array |  |
| `preset` | `mobile` \| `desktop` |  |

## `lint_css`

**Check CSS** — _read-only_

Stylelint over CSS: files in the stand working directory, or code passed inline. Answers "is this stylesheet written correctly", not "why is my rule not applied" — the latter is matched_rules.

| Parameters | | |
|---|---|---|
| `files` | array | Paths relative to the working directory; globs are supported |
| `code` | string |  |
| `config` | object |  |

## `matched_rules`

**Which rule won** — _read-only_

Which CSS rule won and where it is declared: selector, specificity, file and line, and for each property who overrode whom. Answers the question "why did my change not apply", which getComputedStyle cannot answer.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `selector` | string | required |
| `pseudo` | `::before` \| `::after` \| `::marker` \| `::placeholder` \| `::selection` \| `::first-line` \| `::first-letter` |  |
| `properties` | array | Properties of interest, e.g. ["z-index","position"]. Without them only conflicts are shown |
| `maxRules` | number |  |

## `matrix_run`

**Condition matrix**

Runs a page across the cartesian product of axes (browsers x viewport x color scheme x RTL x zoom x forced-colors x pseudo-localization x DPR) and assembles a single HTML report. This is how you check a page against every viewing condition at once instead of one by one.

| Parameters | | |
|---|---|---|
| `url` | string | required |
| `name` | string |  |
| `checks` | array |  |
| `browsers` | array |  |
| `viewports` | array |  |
| `colorSchemes` | array |  |
| `rtl` | array |  |
| `zooms` | array |  |
| `forcedColors` | array |  |
| `pseudoLoc` | array |  |
| `deviceScaleFactors` | array |  |
| `concurrency` | number | How many combinations to run in parallel (default 2) |
| `updateBaseline` | boolean |  |
| `mask` | array |  |
| `hide` | array | Remove from frame: cookie banners, chat widgets, popups |

## `page_logs`

**Page logs** — _read-only_

Console output, unhandled JS errors, failed network requests and the dialogs the page showed (alert, confirm, prompt). Next to the errors sits resourceErrors: scripts and stylesheets that never arrived, which leave a page looking whole but dead. By default only since the last navigation; sinceNavigation: false returns everything since the session was opened.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `kind` | `all` \| `console` \| `errors` \| `network` \| `dialogs` |  |
| `onlyProblems` | boolean |  |
| `sinceNavigation` | boolean | Only entries after the last navigation. Default true |
| `limit` | number | How many entries of each kind to return; the most recent ones. Default 100 |

## `page_save`

**Save the page locally**

Puts the page into a local mirror: the rendered DOM with links rewritten to local copies, the raw server response before JS kept separately, and the resources. After that the page can be examined as much as needed without touching the remote server.

| Parameters | | |
|---|---|---|
| `sessionId` | string | Save the current page of the session |
| `url` | string | Open a throwaway session at this address and save it |
| `siteId` | string | Directory name in the archive. Taken from the host by default |
| `assets` | boolean | Whether to fetch CSS, images and fonts. Default yes |
| `scripts` | `strip` \| `keep` | strip (default) removes scripts: on a local copy analytics would call home and an SPA router would replace the page. JSON-LD is kept either way |
| `raw` | boolean | Whether to keep the raw server response as a separate file. Default yes |
| `browser` | `chromium` \| `firefox` \| `webkit` | Browser engine |
| `viewport` | string | Size: WxH or a preset name (mobile, mobile-sm, tablet, laptop, desktop, wide) |
| `colorScheme` | `light` \| `dark` \| `no-preference` |  |
| `profile` | string | Name of a saved condition profile: the remaining conditions are taken from it. See stand_info for the list |

## `page_snapshot`

**Text outline of the page** — _read-only_

A tree of roles, names and selectors. An order of magnitude cheaper than a screenshot and every line carries a ready-to-use selector, so this is the cheapest way to start looking at a page.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `maxNodes` | number |  |
| `interactiveOnly` | boolean | Links, buttons and form fields only |

## `read_artifact`

**Read an artifact** — _read-only_

Reads a file from the artifacts directory. Text and JSON come back as they are; images and other binaries come back as base64 — otherwise a screenshot the stand itself produced could not be retrieved over MCP.

| Parameters | | |
|---|---|---|
| `file` | string | Path relative to the artifacts directory. required |
| `encoding` | `auto` \| `utf8` \| `base64` | auto (default) decides by file extension |
| `offset` | number | Character offset to read the text from, when the file did not fit in one response |

## `read_project_file`

**Read a stand file** — _read-only_

Reads a file from the stand working directory — a fixture, a matrix config, a CSS file. If a directory is given, returns its listing.

| Parameters | | |
|---|---|---|
| `file` | string | required |
| `offset` | number | Character offset to read from, when the file did not fit in one response |

## `screenshot`

**Screenshot**

A screenshot of the page or of one element. By default the whole page is captured rather than the visible area: on a long page that is a frame thousands of pixels tall, so a selector or a clip is usually what you want. Returns the artifact address; the image itself is embedded in the response only with inline: true. If some resources failed to load the response carries warnings — the shot is incomplete then.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `name` | string |  |
| `fullPage` | boolean | The whole page rather than the visible area. Default true |
| `selector` | string | Capture only this element |
| `clip` | object | Capture a rectangle of the page in CSS pixels — when there is no element a selector could target |
| `mask` | array | Selectors of unstable areas — they get painted over |
| `hide` | array | Remove from frame: cookie banners, chat widgets, popups. Uses visibility: hidden, so layout does not shift |
| `isolate` | array | Keep only these elements in frame and take the remaining siblings out of flow (display: none). This is how a pair of adjacent blocks is captured without the rest — to show an overlap, for instance |
| `format` | `png` \| `jpeg` \| `webp` | Default png |
| `quality` | number | Quality for jpeg and webp, 1–100 (default 80) |
| `maxWidth` | number | Downscale to this width — for embedding into documents |
| `inline` | boolean | Attach a downscaled image to the answer |
| `runId` | string |  |

## `seo_page`

**SEO fields of a page** — _read-only_

Title, description, canonical, hreflang, robots directives, Open Graph, Twitter cards, the heading tree, an inventory of links and images, and structured data (JSON-LD, microdata, RDFa). Separately computes indexable with the reasons a page would stay out of the index. The source can be an open session, a URL, or a saved copy — against a saved copy it makes no network request at all.

| Parameters | | |
|---|---|---|
| `sessionId` | string | Parse the page of an open session as it looks right now, after a login and with menus expanded |
| `url` | string | Open a throwaway session at this address |
| `html` | string | Parse the markup passed inline, without a browser |
| `file` | string | Parse a saved file: a path relative to the stand working directory |
| `pageUrl` | string | The address to resolve links against for html or file input. Without it relative URLs and canonical self-reference cannot be computed |
| `browser` | `chromium` \| `firefox` \| `webkit` | Browser engine |
| `viewport` | string | Size: WxH or a preset name (mobile, mobile-sm, tablet, laptop, desktop, wide) |
| `colorScheme` | `light` \| `dark` \| `no-preference` |  |
| `profile` | string | Name of a saved condition profile: the remaining conditions are taken from it. See stand_info for the list |

## `seo_report`

**Site-wide SEO report** — _read-only_

Sums up from a crawl archive what is invisible on a single page: duplicate titles, descriptions, h1s and content; broken internal links with the pages that lead to them; orphan pages; redirect chains; canonical and hreflang reciprocity issues; thin content; mixed content. Summarizes separately what was NOT checked. Writes JSON and a self-contained HTML report.

| Parameters | | |
|---|---|---|
| `siteId` | string | The crawl to build the report from. List them with crawl, action: list. required |
| `verify` | boolean | Whether to verify addresses outside the crawl with one-off requests: canonical and hreflang pointing away. Default yes |
| `thinWords` | number | Thin content threshold in words, default 200 |

## `site_files`

**robots.txt and sitemap.xml** — _read-only_

Fetches and parses robots.txt and sitemap.xml. Shows the rules for a given user agent, checks specific addresses against them and expands sitemap index files. With a siteId it also reconciles the sitemap against a finished crawl: what is listed but was never found, and what was found but is missing from the map.

| Parameters | | |
|---|---|---|
| `url` | string | Any address on the site — robots.txt and sitemap.xml are taken from its root. required |
| `userAgent` | string | Which user agent to show the rules for |
| `check` | array | Check these addresses against robots.txt |
| `siteId` | string | Reconcile the sitemap against a finished crawl |

## `stand_info`

**Stand status** — _read-only_

Stand status: version, paths, available browsers, viewport presets and saved condition profiles, artifact addresses, validator reachability, open sessions, interface language and available updates. A good place to start when it is unclear what the stand can reach, or when a check fails and you need to know whether the validator is up.

_no parameters_

## `storybook_audit`

**Walk through Storybook**

Walks every Storybook story, taking a screenshot of each and running layout heuristics and axe. This is how you check a component library as a whole instead of opening stories by hand. Stories are filtered by a regular expression over id and title.

| Parameters | | |
|---|---|---|
| `storybookUrl` | string | For example http://node_myapp:6006. required |
| `include` | string | A regular expression over story id and title |
| `limit` | number |  |
| `visual` | boolean | Compare every story against a baseline |
| `browser` | `chromium` \| `firefox` \| `webkit` | Browser engine |
| `viewport` | string | Size: WxH or a preset name (mobile, mobile-sm, tablet, laptop, desktop, wide) |
| `colorScheme` | `light` \| `dark` \| `no-preference` |  |
| `profile` | string | Name of a saved condition profile: the remaining conditions are taken from it. See stand_info for the list |

## `validate_html`

**Validate HTML** — _read-only_

Checks markup with the Nu HTML Checker (W3C validator): unclosed tags, duplicate ids, missing required attributes. The source can be an open session, an arbitrary URL or markup passed inline.

| Parameters | | |
|---|---|---|
| `sessionId` | string |  |
| `url` | string |  |
| `html` | string |  |

## `visual_baselines`

**Baselines** — _read-only_

Stored visual regression baselines: which pages and viewing conditions already have one — that is, where visual_compare will have something to compare against, and where the first shot will itself become the baseline. This is also where they are deleted: baselines are never pruned automatically, and since the name includes the condition profile, a wide matrix creates one per combination.

| Parameters | | |
|---|---|---|
| `action` | `list` \| `delete` \| `prune` | Default list |
| `name` | string | Which baseline to delete — for delete |
| `olderThanDays` | number | For prune: delete baselines older than this many days. Default 90 |
| `apply` | boolean | delete and prune only show what would be removed; apply: true actually removes it |

## `visual_compare`

**Compare against a baseline**

Takes a screenshot and compares it with the stored baseline. If there is no baseline, the shot becomes one and that is stated explicitly. Format and scale are deliberately not configurable here: the comparison is pixel-exact and any re-encoding would devalue the baselines already collected.

| Parameters | | |
|---|---|---|
| `sessionId` | string | required |
| `name` | string | Baseline name. required |
| `fullPage` | boolean |  |
| `selector` | string |  |
| `mask` | array |  |
| `hide` | array | Remove from frame: cookie banners, chat widgets, popups |
| `isolate` | array | Keep only these elements in frame (display: none for the remaining siblings) |
| `threshold` | number | Allowed difference as a percentage of pixels |
| `updateBaseline` | boolean | Overwrite the baseline with the current shot |

## `visual_guide`

**Visual reference document**

Builds one self-contained HTML: the listed page blocks captured at several widths, with captions for their parameters. A document for humans — to show a content manager what each combination of settings produces. Images are embedded in the file, so it can be forwarded as a single attachment.

| Parameters | | |
|---|---|---|
| `url` | string | The page to capture from. required |
| `items` | array | Variants in the order they appear in the document. required |
| `title` | string |  |
| `intro` | string | An intro paragraph under the title |
| `profiles` | array | Widths: preset names or WxH. Default ["desktop","mobile"] |
| `auth` | string | HTTP basic auth as "user:password" |
| `browser` | `chromium` \| `firefox` \| `webkit` |  |
| `format` | `png` \| `jpeg` \| `webp` | Format of the embedded images, default webp |
| `quality` | number |  |
| `maxWidth` | number | Width of the embedded images, default 1000 |

## `web_vitals`

**Web Vitals** — _read-only_

CLS, LCP, FCP and TTFB for a URL, with the elements that shifted the layout listed. Catches what a static screenshot cannot show: content jumping while the page loads.

| Parameters | | |
|---|---|---|
| `url` | string | required |
| `settleMs` | number |  |
| `browser` | `chromium` \| `firefox` \| `webkit` | Browser engine |
| `viewport` | string | Size: WxH or a preset name (mobile, mobile-sm, tablet, laptop, desktop, wide) |
| `colorScheme` | `light` \| `dark` \| `no-preference` |  |
| `profile` | string | Name of a saved condition profile: the remaining conditions are taken from it. See stand_info for the list |

---

# Prompts

- **`layout-broken`** — The order of investigation: from the whole page to one element, from cheap steps to expensive ones.
- **`visual-regression`** — Compare a page against its baseline, having first removed everything that changes on its own.
- **`seo-site`** — Crawl a site and collect what is invisible on a single page.
- **`figma-layout`** — How to work from a design: one snapshot, analysis over it, markup, then checks by comparison and by content.

---

# Resources

- `lt://artifacts/{+path}` — Screenshots, reports and summaries produced by the checks. A file inside a run is addressed as lt://artifacts/<run>/<file>.
- `lt://baselines/{name}` — The shots visual_compare checks the current state against. The name includes the condition profile, so the same block has its own baseline per width and color scheme.
- `lt://sites/{+path}` — Saved pages: what crawl and page_save put there. These directories are never pruned automatically — a crawl costs incomparably more than a screenshot.

---

_Generated: 2026-09-12_
