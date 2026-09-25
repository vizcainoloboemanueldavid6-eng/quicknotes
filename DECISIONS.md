# Decisions

Choices the specification left open, and why each one went the way it did. Anything a future
maintainer would otherwise have to reverse-engineer.

---

## Stack

### CRXJS 2.7.1, not 3.0.0

`@crxjs/vite-plugin` 3.0.0 was published on the day this project started. The brief asks for the
current stable 2.x line, and 2.7.1 has three months of use behind it and supports Vite 8.

### Vite 8 with its built-in JSX transform instead of `@preact/preset-vite`

Vite 8 compiles TSX with Oxc, which only needs `jsx.importSource: 'preact'`. The preset would add
Babel (and a second copy of `@babel/core`) just for Prefresh hot reloading, which matters little
in an extension: CRXJS reloads the extension on change anyway.

### Tailwind 3.4 (the `v3-lts` line), not Tailwind 4

Tailwind 4 declares its internal variables (`--tw-shadow`, `--tw-ring-*`, transforms…) with
`@property`. `@property` rules are ignored inside shadow roots, so every shadow, ring and transform
utility breaks in the injected UI unless the defaults are re-declared by hand. Tailwind 3 sets those
variables with a plain `*, ::before, ::after` rule, which works inside a shadow root unchanged.

### Two Tailwind configs, one preset

`tailwind.content.config.js` only scans `src/content/`, so the CSS string embedded in the content
script contains nothing but what the injected UI uses. Extension pages use `tailwind.config.js`.
Both share `tailwind.preset.js` (paper palette, primary `#F2B705`, system font stack, shadows).

### `rem` is converted to `px` at build time

`rem` is relative to the host page's `<html>` font size, which the injected UI cannot control — a
site with `html { font-size: 10px }` would shrink every rem-based size by 37 %. A small PostCSS step
in `postcss.config.js` rewrites every `rem` value to pixels (16 px = 1 rem).

### Shadow utilities are called `soft`, not `paper`

The preset has a `paper` color, so a `paper` box shadow would make `shadow-paper` two utilities at
once — the shadow and a shadow _color_ (`#FFFDF7`) generated later in the file, which replaced the
soft dark shadow with a near-white one (invisible on light pages, a glow on dark ones). The shadows
are `shadow-soft` and `shadow-soft-lg`; an end-to-end test checks a note's computed shadow.

### TypeScript 6.0, not 7.0

`typescript-eslint` 8.70 (the current release) supports TypeScript `< 6.1`. Type-aware linting is
worth more than the native TypeScript 7 compiler here.

### jsdom rather than happy-dom for unit tests

Anchoring depends on `Range`, `TreeWalker` and `compareDocumentPosition` behaving exactly like a
browser; jsdom's implementations are the more complete ones.

### ESLint: only the two classic React-hooks rules

`eslint-plugin-react-hooks` 7 ships React Compiler rules by default. They assume React's compiler,
which a Preact project does not use, so only `rules-of-hooks` and `exhaustive-deps` are enabled.

### Exact versions, no zip library

Every dependency is pinned exactly, as in the other projects. `npm run zip` uses a 100-line ZIP
writer on top of `node:zlib` (`deflateRawSync`, `crc32`) instead of a dependency; entries are sorted
and timestamped with a fixed date so the same build always produces the same archive.

---

## Permissions and injection

### On-demand injection by default; automatic restore only as an opt-in

This is the main trade-off of the extension.

- **Default (no host permissions).** The manifest asks only for `storage`, `activeTab`,
  `scripting`, `contextMenus` and `sidePanel`, so installing it shows no "read and change all your
  data" warning. The content script runs only on a tab the user acts on: opening the popup, the
  "Highlight with QuickNotes" menu item, or <kbd>Alt</kbd>+<kbd>N</kbd>. Each of these grants
  `activeTab` for that tab, and the background injects the script with
  `chrome.scripting.executeScript`. The cost: after a reload, a page's highlights and notes are only
  drawn again once the user clicks the QuickNotes button (or uses the menu or shortcut) on it.
- **Opt-in ("Restore my notes automatically on every site").** Options requests the optional host
  permission `http://*/*` + `https://*/*` at runtime, and the background then registers the same
  script with `chrome.scripting.registerContentScripts` (`document_idle`, top frame, persisted across
  sessions). Notes reappear as soon as a page loads, at the price of a broad permission — even
  though nothing ever leaves the device. Turning the option off unregisters the script and gives the
  permission back; if the user revokes the permission in Chrome, the option switches itself off.

Opening the popup injects the script (unless the site is paused): opening it is the user's action
on that tab, and seeing the page's notes come back is what they expect.

The registration is only replaced when it actually changes (for example a new paused site in
`excludeMatches`). Settings and permission events often arrive together, and re-registering on each
one left short gaps in which a loading page got no script.

### The content script is a single IIFE file, and it is not web-accessible

The background imports it with CRXJS's `?script&iife`, so `executeScript` and
`registerContentScripts` both load one self-contained file — no loader that `import()`s module
chunks. CRXJS still lists that file in `web_accessible_resources` for every http(s) page, which is
not needed by either API and would let any website detect the extension by probing its URL; a small
build plugin removes the entry. The same plugin drops a module copy of the content script that
CRXJS emits but nothing loads.

### The build's one warning, and why it stays

`npm run build` (and so `zip`, `test:e2e` and `store-assets`) prints "`inlineDynamicImports` option
is ignored because `codeSplitting: false` is set" while CRXJS builds the IIFE content script. It is
harmless: the ignored option asks for exactly what `codeSplitting: false` already does, so the
output is the same single self-contained file.

It cannot be removed from this project's config. CRXJS 2.7.1 builds the IIFE with a nested Vite
build (`createIifeConfig` in `node_modules/@crxjs/vite-plugin/dist/index.mjs`) that uses
`configFile: false` and no plugins and hard-codes `output.inlineDynamicImports: true`; Vite 8 adds
`codeSplitting: false` to every IIFE build, and Rolldown warns when it sees both. Nothing in
`vite.config.ts` reaches that nested build (it inherits only `root`, `mode`, `resolve`, `define` and
`esbuild`). CRXJS 3.0.0 still sets the same option, so upgrading would not help either. What was
rejected:

- **Filtering the message** out of the build output: it would hide the next real warning too.
- **Patching `node_modules`** (or a patch tool): not config, and silently lost on a fresh install
  unless another dependency re-applies it.
- **Building the content script without CRXJS** (our own IIFE build instead of `?script&iife`): it
  would remove the warning, but it replaces the tested packaging path — the file both
  `executeScript` and `registerContentScripts` load, and its `vite dev` rebuilds — to silence a
  cosmetic line. Not worth the risk for v1.0; worth revisiting if CRXJS changes the option.

### `src/background/service-worker.ts` is the manifest entry

The service-worker logic lives in `src/background/index.ts`, as the spec lays out. The manifest
points at a one-line `service-worker.ts` that imports it, because two emitted chunks both named
`index.ts` (background and content) made the bundler wire the service-worker loader to the content
script chunk.

### The pause list is enforced in three places

A paused site (hostname without `www.`, which also covers its subdomains) is respected by the
background before injecting anything, by the content script itself (no toolbar, no restore; notes
and highlights are removed from the page the moment the site is paused), and by the registered
script's `excludeMatches`. The context-menu item is disabled on the active tab when its URL is known
to be paused — Chrome only reveals tab URLs for tabs the user acted on or with host permissions, so
elsewhere the item stays enabled and the click is refused, with an "off" badge on the button.

The "off" badge is set whenever the background learns that a tab is on a paused site (an action was
refused, the tab finished loading, or the pause list changed) and cleared when the site is resumed —
only a badge QuickNotes set itself is ever cleared. An IP address has no subdomains, so a paused IP
gets a single `excludeMatches` pattern instead of the `*.site` pair.

### Top frame only; `file://` works when Chrome allows it

The script is injected into the top frame only; text inside iframes cannot be highlighted in v1.0.
`file://` pages (such as a local copy of the demo article) work while "Allow access to file URLs" is
on for the extension (Chrome turns it on for unpacked extensions and off for store installs).

- **Local files cannot be paused.** The pause list holds host names, and a file URL has none, so the
  popup shows a one-line explanation instead of the "Pause on this site" switch. A special "local
  files" entry was considered and rejected: files only ever run QuickNotes on the user's own click,
  so there is nothing automatic to pause.
- **When file access is off,** Chrome hides a `file://` tab's URL (and title) from the extension
  even after a toolbar click, so the popup cannot tell a local file from a `chrome://` page. It shows
  the usual "can't run on this page" text plus a line asking whether this is a file from the
  computer, with a button to the extension's details page (`chrome://extensions/?id=…`), where the
  setting lives. When the URL is visible (older Chromium), the popup says it outright and disables
  New note instead of letting it fail with a generic error.

### "Highlight with QuickNotes" can fall back to the menu's selection text

If the page selection is gone by the time the menu item runs, the text Chrome passes in
`selectionText` is searched on the page and highlighted — but only when it occurs exactly once;
otherwise the user is asked to select the text again rather than risk highlighting the wrong
occurrence.

---

## Storage

### One record per page, keyed by normalized URL

`chrome.storage.local` holds `page:<normalized URL>` → `{ url, title, highlights, notes, updatedAt }`.
A record is deleted as soon as it is empty, so "all pages" is simply every `page:` key. Settings live
in `chrome.storage.sync` under `settings`, validated field by field on every read.

### Writes are serialized per context; the content script re-syncs after its own writes

Every write is a read-modify-write of the page record, queued so two quick edits in the same tab
never overwrite each other. Different contexts (a tab and the side panel) are not locked against
each other — the last write wins — but the content script ignores storage events while its own
writes are in flight and re-reads the page once they land, so it never shows a stale state.

### No `unlimitedStorage`

The permission list is fixed by the spec. The 10 MB `storage.local` quota holds thousands of notes;
a write that fails anyway is reported with a toast instead of being lost silently.

### Orphan flags do not count as activity

Whether a highlight could be found is stored on the highlight (`orphaned: true`) so the popup and
side panel can list it, but writing that flag does not bump the page's `updatedAt`, which orders the
"All notes" list by the user's own activity.

---

## URL normalization

Deterministic and idempotent (`normalize(normalize(x)) === normalize(x)`, covered by tests):

- the fragment is dropped — even `#/route` hash routes, as the brief asks;
- credentials are dropped, host and scheme lower-cased, a trailing dot on the host removed, default
  ports dropped;
- `utm_*` and a list of click/mail tracking parameters (`fbclid`, `gclid`, `msclkid`, `mc_eid`,
  `_ga`, …) are removed; `ref` is kept because it is often meaningful (e.g. a Git branch);
- the remaining parameters are sorted by name (stable, so repeated names keep their order);
- trailing slashes are removed except for the root path;
- percent-escapes in the path are normalized (RFC 3986 §6.2.2): escapes of unreserved characters are
  decoded and the rest get upper-case hex digits, so `/caf%c3%a9`, `/caf%C3%A9` and `/café` are one
  page, as are `/%7Euser` and `/~user`. Escaped reserved characters (`%2F`, `%3F`) stay escaped
  because decoding them would change the path's meaning.

`www.example.com` and `example.com` stay different pages: some sites serve different content on
them, and merging is not reversible. (The pause list, by contrast, ignores `www.`.)

---

## Anchoring highlights

### What is stored

The exact quote, up to 32 characters before and after it, the character position in the page text,
and for each end the XPath of the enclosing element plus a character offset into that element's
text. The XPath deliberately stops at elements and skips QuickNotes' own `<quicknotes-mark>`
elements, so wrapping text never invalidates another highlight's anchor.

### How it is resolved

All matching happens on a text index (every text node under `<body>`, skipping `script`, `style`,
`textarea`, … and the QuickNotes host) and ignores whitespace differences. Two more kinds of text are
left out, so they are never wrapped in a mark:

- **SVG and MathML** (anything outside the HTML namespace): an HTML element inside an SVG `<text>`
  is not rendered, so a chart label caught in a selection would disappear.
- **The page's own editors** (`contenteditable`, except `="false"`): a mark inside a comment box or a
  CMS editor would end up in whatever the site saves. A selection that ends inside an editor stops
  where the editor begins.

Resolution:

1. find every occurrence of the quote;
2. one occurrence → done; several → score each by how much of the stored prefix and suffix matches
   the text around it, ties broken by closeness to the stored position;
3. no occurrence → try the XPath + offsets, and accept the text found there only if it is still at
   least 75 % similar to the quote (Levenshtein), so a typo fix keeps the highlight but a rewritten
   paragraph does not get a highlight on the wrong words;
4. otherwise the highlight is **orphaned**.

### Orphans are retried while the page settles

Single-page apps render after `document_idle`. While highlights are missing, the content script
retries after each burst of DOM changes and reports once the page has been quiet for 1.5 s (10 s at
most). A toast appears only for highlights that were not already known to be orphaned.

### How highlights look on the page

Each covered text node is wrapped in `<quicknotes-mark>` with inline `!important` styles set through
the CSSOM — page stylesheets cannot override them and page CSP does not apply to CSSOM writes. The
text inside is forced to the dark ink color, because a pastel background under a dark site's white
text would be unreadable. Whitespace-only text between table rows or list items is not wrapped.
Overlapping highlights nest; the innermost one wins the color and the click. Clicking a highlight
inside a link follows the link instead of opening the highlight menu. Marks are looked up by
comparing their id attribute as a string, never by building a CSS selector from the id, and
imported ids are limited to letters, digits, `-` and `_` (what `crypto.randomUUID()` produces).

### Known limitation: text directly inside a flex or grid container

A mark is `display: inline`, but a direct child of a flex or grid container becomes its own layout
item, so highlighting part of such a text run splits it into items and the container's `gap`
appears around the mark. This is rare in article text (flex containers normally hold elements, not
bare text). The alternative — the CSS Custom Highlight API — needs a document-level stylesheet
(`::highlight()` rules cannot live in the shadow root), its own hit-testing for clicks and a second
drawing path; not worth it for v1.0.

### The selection toolbar

- It listens for `mouseup`, `mousedown` and `keyup` on `window` in the **capture** phase: many sites
  stop these events from bubbling (widgets, frameworks that handle events at their root), which would
  otherwise keep the toolbar from appearing.
- It is first placed with an estimated width, then re-centered with its measured width (it is wider
  in Spanish than in English) so it always stays 8 px inside the window, scrollbar excluded. The
  highlight menu does the same.

---

## Injected UI

### One shadow host, isolated both ways

`<quicknotes-root>` is appended to `<html>` (outside `<body>`, whose transforms or overflow would
otherwise affect it) and hosts everything in a shadow root. `:host { all: initial !important; … }`
cuts off inherited styles, and — because `!important` declarations of a shadow tree's `:host` rule
beat the page's own `!important` rules — survives hostile selectors such as `* { display: none
!important }`. The stylesheet is adopted with `adoptedStyleSheets` (not blocked by page CSP), with a
`<style>` fallback. The end-to-end suite runs against a page with deliberately hostile CSS to prove
both directions.

### The shadow root is closed

With an open root, any script of the annotated site — its own code, an analytics or
session-recording tag — could call `host.shadowRoot` and read every note shown on the page, rewrite
one (saved on blur like a user edit) or click its delete button twice. A closed root returns `null`
there; only the controller keeps the `ShadowRoot` that `attachShadow()` returned. A page that
patches `Element.prototype.attachShadow` in its own world cannot catch the call either, because the
content script runs in an isolated world with its own prototypes. An end-to-end test checks all of
this against the shipped build.

What the page can still see, stated in PRIVACY.md:

- **Highlights** are part of the page's own DOM (they have to wrap its text).
- **Keystrokes typed in a note.** Keyboard events are stopped at the shadow boundary, which hides
  them from every bubble-phase listener of the page, but listeners the page registered on
  `window`/`document` in the capture phase run before that point. An isolated world cannot keep
  them out: stopping the event on `window` would also stop it from reaching the note's own editor.

`isTrusted` checks were not added to the note's buttons: with the root closed, page scripts cannot
reach those elements at all.

### The injected UI always uses the light paper look

Pastel notes on a light toolbar are the product's visual identity and stay readable on light and
dark sites alike. The theme setting applies to the popup, side panel and options.

### Note positions are percentages of a document measured without the notes

A note near the bottom would make the document taller, and a percentage of a taller document moves
the note further down — a feedback loop. While measuring, the notes layer is clipped so it
contributes nothing to the document size.

### "Add note" on a selection highlights it too

A note made from the toolbar is attached to a new highlight (default color) and placed next to it,
so the side panel and exports can show which passage it is about. The highlight menu offers "Add
note", or "Show note" when one exists. Deleting a highlight keeps its notes as standalone notes.

### Editor details

- `document.execCommand` is deprecated but is still the only API that edits a `contenteditable`
  selection with native undo; it is used for bold, italic and the two list types.
- Chrome moves the caret to the start of the line after list commands inside a shadow root; the
  caret is restored by character offset.
- Paste inserts plain text: the whitelist sanitizer would strip pasted styling on save anyway, and
  it would otherwise stay visible until then.
- Deleting a note takes two clicks on the same button (a 3-second confirmation state) instead of a
  modal dialog on someone else's web page.
- Empty notes are kept until deleted — a note created by accident is one click away from gone, while
  a note silently discarded on blur would be surprising.
- <kbd>Ctrl</kbd>+<kbd>U</kbd> is swallowed: Chrome's built-in underline would show a `<u>` that the
  whitelist drops on save. The whitelist was not extended because the brief lists bold, italic and
  lists only.

### Note length: refuse, never cut

A note's stored HTML is capped at 100,000 characters (about as much text: a long article), so one
note cannot eat the 10 MB `storage.local` quota. The editor enforces it before anything is lost:

- typing, dropping and formatting are refused once the editor's HTML reaches the cap (deleting and
  undo still work), with a toast;
- a paste is refused as a whole — the clipboard still has it — when its estimated size (escapes, a
  `<div></div>` per line, `&nbsp;` for runs of spaces) would cross the cap;
- if an edit is still over the cap when it is saved, it is **not** saved: the last saved version
  stays and the toast says so, instead of storing a shortened copy.

The sanitizer's own cap therefore only applies to imported or hand-made data. Even then it keeps as
much text as fits, with a `<br>` per line, instead of the first fifth as plain text.

### Orphaned content scripts step aside

When the extension is updated or reloaded while pages stay open, the old copy of the content script
loses its connection to Chrome. It notices within a second (or at the next page event), stops
listening, and the next injection replaces its UI and re-draws the highlights without wrapping them
twice.

---

## Export and import

- **Markdown labels are English words** ("Highlights", "Note 1 · Yellow · 2026-09-24"): an export is
  data, and it should read the same whichever language the browser uses. Dates are local
  `YYYY-MM-DD`.
- **HTML → Markdown/plain text is DOM-free**, so it also works in the service worker.
- **JSON import is all-or-nothing.** Every problem is reported with its path
  (`pages[2].notes[0].color: expected one of yellow, green, blue, pink`, at most 20), nothing is
  written unless the whole file is valid, note HTML is sanitized again, URLs are re-normalized and
  pages that normalize to the same URL are merged. Storage offers `merge` (newer `updatedAt` wins
  per item) and `replace`.

---

## Localization

Every visible string, including the manifest name, the context-menu title and the command
description, goes through `chrome.i18n` (English default, Spanish). The locales live in
`src/_locales` as the spec lays out; a small build plugin copies them to the extension root, where
Chrome requires them. Its name starts with `crx:` on purpose: during `vite dev` CRXJS writes `dist/`
with a Rollup build that only runs plugins with that prefix. A unit test fails if the two languages
drift apart, if a placeholder is missing, or if the code uses a key that does not exist.

### Color names: a label is capitalized, a word in a sentence is not

A color name plays two roles. Standing alone as a label — the color chips in "All notes", the
default-color choice in Options, the tag on a listed highlight — it is capitalized: "Yellow",
"Amarillo". Inside a sentence — the accessible names and tooltips "Highlight in yellow", "Change
color to green", "Note color: pink" and their Spanish counterparts ("Resaltar en amarillo", "Cambiar
el color a verde", "Color de la nota: rosa") — it is lower case, as both languages write it.

Each locale has its own `color…InSentence` messages (read through `colorNameInSentence()`) instead of
the code lower-casing the label: the mid-sentence form belongs to the language (German, for one,
capitalizes nouns everywhere). English changed along with Spanish — "Highlight in Yellow" was just
as wrong there. A unit test renders every message with a `$COLOR$` placeholder in both languages and
scans the source so each of those messages is filled with the in-sentence form.

---

## Side panel

### Two views in one panel, "This page" first

The panel opens on "This page" (what the user is looking at) with "All notes" one tab away, instead
of two separate panels: Chrome allows one side panel per extension, and a tab switch keeps both a
click apart. The tabs follow the WAI-ARIA tab pattern (arrow keys, Home/End).

### "This page"

Highlights are listed in reading order, then notes in creation order (a note attached to a highlight
shows the start of its passage), then an **Orphaned** section with a one-line explanation — orphans
cannot be scrolled to, so they are not buttons, but they can be deleted. Clicking an item asks the
content script to scroll to it and flash it. That needs access to the tab; when the panel cannot
reach the page (no `activeTab` grant yet, no host permission) it says so and suggests clicking the
toolbar button, rather than failing silently. Deleting from the panel takes two clicks on the same
button, like deleting a note on the page, and the open page follows through storage events.

### "All notes": search semantics

- Case- and accent-insensitive (`resume` finds "Résumé"), whitespace-collapsed.
- The query is split into words and **every word must match**, either in the item itself or in its
  page's title or URL — so "bread dough" finds a highlight about dough on a page titled "bread".
- A page whose title or URL matches the whole query shows all of its items; otherwise only the
  matching items are shown. Matches are marked in the results.
- Color chips are a multi-select (none selected = all colors); the site filter groups by host name
  without `www.`, and `file://` pages are grouped under "Local files".
- Pages keep their order: most recently edited first.

### Export is a download, import merges

Exports are Blob downloads through a temporary `<a download>` link — no `downloads` permission.
File names are `quicknotes-<host-and-path>-<date>.md|json` or `quicknotes-all-<date>.*`. The panel
only offers **merge** on import (the storage layer also has `replace`): merging can never lose data,
importing the same backup twice changes nothing, and a user who wants a clean slate can delete
everything in Options first. Files over 10 MB (the `storage.local` quota) are refused before
parsing. Validation messages come from the (English-only) validator because they quote JSON paths.

### Imported highlights that are not on the open page are reported at once

If an import or another tab adds highlights to the page being shown and some cannot be anchored, the
content script starts the same orphan watch as on a fresh load, so they are flagged and listed as
orphaned immediately instead of after the next reload.

## Popup and options

- The popup's "Open side panel" calls `chrome.sidePanel.open()` synchronously inside the click
  handler (the API requires a user gesture) and closes the popup. On pages QuickNotes cannot run on
  (new tab, `chrome://` pages, the Web Store) the popup says so but still offers "Open side panel",
  using the current window, so "All notes" is reachable from anywhere.
- The popup's controls stay disabled until the content script has answered with the page's status,
  so a click can never act on a half-loaded state.
- **"Pause on this site" shows what is saved.** While a change is being written the switch shows the
  requested position; afterwards it follows the stored list, so a write that did not happen never
  leaves the switch on. The hint names the entry that pauses the page — which can be a parent domain
  (`example.com` pauses `blog.example.com`) — and turning the switch off removes every entry that
  covers the page, so the page is really resumed (Options still removes exactly the entry clicked).
- **Settings writes can fail** (`storage.sync` allows 8,192 bytes per item, so the paused-sites list
  holds roughly 300–400 sites). The size is checked before writing; a write that would not fit, or
  that Chrome rejects, is reported in the popup or at the top of Options, the optimistic change is
  rolled back to what is stored, and the site input keeps its text. No fixed cap on the number of
  sites: the byte limit is the real constraint, and the message says what to do.
- **An Options section names a feature; its checkbox says what ticking it does.** "Selection
  toolbar" holds "Show the toolbar when I select text" and "Automatic restore" holds "Restore my
  notes automatically on every site" (the name README, PRIVACY.md and the store texts use), instead
  of each title repeating the checkbox right under it. The help line below a checkbox is its
  accessible description (`aria-describedby`), not part of its name. The toolbar's help says that
  highlighting still works from the context menu when the toolbar is off; an end-to-end test checks
  exactly that.
- The side panel's "This page" follows the active tab of **its own window** (`currentWindow`), and
  only that window's tab events: focusing another window no longer retargets it.
- Options shows the current shortcut from `chrome.commands.getAll()` and re-reads it whenever the
  page becomes visible again, because the shortcut is changed on `chrome://extensions/shortcuts` in
  another tab (the "Change shortcuts" button opens it; extensions may open that page with
  `chrome.tabs.create`).
- The confirmation word for "Delete all data" is localized: `DELETE` in English, `BORRAR` in
  Spanish — the help text shows the word to type, and a Spanish speaker should not have to type an
  English word to delete their own data.
- "Delete all data" also turns automatic restore off, gives the host permission back and
  unregisters the content script, so nothing keeps running for data that no longer exists.

## Demo article

`demo/article.html` is original sample text about reading with a pencil, from a fictional
publication. Its hostile stylesheet is the kind real sites ship — universal `!important` rules
(`font-family`, `color`, `box-sizing`, `letter-spacing`, `line-height`), restyled `div`, `span`,
`button`, `mark`, `p`, lists and `svg`, attribute selectors that hide `[role=toolbar]`,
`[role=group]` and `[contenteditable]`, and a header, a banner and a vignette at `z-index:
2147483647`. `#calm` switches the hostile sheet (and the banner describing it) off; the fragment is
ignored by URL normalization, so both modes share the same notes. `npm run demo` serves it over http
on port 4323 because `file://` pages need the user to enable "Allow access to file URLs" first. Its
"Try it" card tells the reader to click the QuickNotes button after reloading, because the default
install only restores a page on the next click (see "On-demand injection by default").

## Verification tooling

### Ports

`npm run dev` uses 4320 (its websocket 4321), `npm run demo` 4323, the end-to-end tests and the
store-image capture 4324. The dev server listens on `localhost` (Vite's default); the others bind to
127.0.0.1.

### `npm run dev`: `server.ws`, and the deprecation notice that remains

The websocket port is set with `server.ws.port`; Vite 8 deprecates the old `server.hmr.port`. The
dev server still prints one "`server.hmr.protocol/host/port/…` is deprecated" line, and it does not
come from this project's config: `VITE_DEPRECATION_TRACE=1` shows CRXJS 2.7.1's own `crx:hmr` config
hook writing `server.hmr.host = "localhost"` (`node_modules/@crxjs/vite-plugin/dist/index.mjs`).
When Vite merges the config file's `server` block with the command line's server options, it turns
`server.hmr` into a compatibility object that logs this notice on every write to its old keys, and
this project needs a `server` block (fixed ports). What was rejected:

- **`server.hmr: false`**, the only value that stops CRXJS from writing the key: its live-reload
  client then has no host and would connect to the extension's own id instead of `localhost`.
- **Moving the ports into a plugin hook that runs after CRXJS's**, so the write lands on a plain
  object: CRXJS would still set the deprecated key; that hides the notice instead of fixing it.
- **CRXJS 3.0.0**, which writes `server.ws.host` instead: a new major version of the build plugin
  (out for one day when this was checked) for a one-line notice in dev mode is not worth the risk.
  The notice goes away with the move to CRXJS 3.

The live-reload client was checked after the change: it connects to `ws://localhost:4321`.

### End-to-end tests: which browser

The suite (`@playwright/test` 1.57.0) prefers Playwright's bundled Chromium 143 with
`--load-extension`, as intended for this project. On the development machine that binary does not
start from Playwright's cache (Windows reports a side-by-side error for `chrome.exe` in
`ms-playwright/chromium-1200`, although an identical copy elsewhere starts fine), so the harness
falls back to the installed Chrome, loading the extension with the DevTools method
`Extensions.loadUnpacked` (branded Chrome ignores `--load-extension` since version 137).
`QN_CHROMIUM_PATH` points the harness at another Chromium executable; the suite was run both ways.

### How the tests reach what Playwright cannot

- **The closed shadow root.** Playwright locators only pierce open shadow roots, so the harness
  loads a copy of `dist/` in which the content script's single `attachShadow({mode:"closed"})` call
  is replaced by `"open"` (the harness fails if it does not find exactly one). Everything else is the
  shipped build byte for byte. The install and privacy specs load `dist/` itself, and the privacy
  spec proves the page cannot reach a note there. A build-time test hook was rejected: it would put
  test code in the package.
- **The toolbar button (`activeTab`).** Recent Chrome exposes `Extensions.triggerAction`, a real
  action click that grants `activeTab` and opens the popup. The activeTab spec is pinned to the
  installed Chrome (`test.use({ browserKind: 'chrome' })`) so the default install's main path is
  always tested, and it is skipped only when a run is explicitly limited to Chromium.
  `chrome.action.openPopup()` opens the popup but grants nothing, so it is only used where host
  access exists.
- **The optional host permission.** A headless browser cannot show the permission prompt, so tests
  that need it load a copy of `dist/` (`dist-e2e-hosts/`) whose optional host permissions are
  declared as granted — standing in for the user clicking "Allow". Revocation is real: the tests
  switch site access to "on click" through `chrome://extensions` (`chrome.developerPrivate`), which
  fires `permissions.onRemoved` exactly as a user's click would.
- **Popup and side panel.** Playwright does not expose them as pages, so the harness attaches to
  their DevTools targets and evaluates code there with a user gesture (which `sidePanel.open()`
  needs). Downloads are checked on the side panel opened as a normal tab, where Playwright sees
  them.
- **Errors in every context.** The harness turns on developer mode and reads Chrome's own
  extension error log (`developerPrivate.getExtensionInfo`: runtime errors from the service worker,
  pages and content scripts, manifest errors, install warnings) in addition to console errors of the
  pages, popup and side panel.
- **The context menu and Alt+N** cannot be triggered from automation (the native menu and
  browser-level shortcuts are outside the page). The tests fire the extension's real
  `contextMenus.onClicked` and `commands.onCommand` listeners inside the service worker with the
  events' `dispatch()` method, passing the arguments Chrome passes (click data and the tab). An
  earlier test-only background message that bypassed the real listener was removed.

`scripts/smoke.mjs` from the first stage was folded into the suite and removed.

### Store images are captured, not drawn

`npm run store-assets` drives the real extension on the demo article (`#calm`) with the same
harness and saves 1x PNGs. The side panel and popup are captured from their own DevTools targets and
placed next to / over the page with `sharp`, because a headless browser renders no browser UI. The
store summary is the manifest description itself (the dashboard takes it from the package), so both
locales were rewritten to fit 132 characters and mention the four colors, search and Markdown export.
Screenshots and the promo tile are written as 24-bit PNGs without an alpha channel (the dashboard
asks for JPEG or 24-bit PNG); the composed ones are flattened in a second `sharp` pass, and both the
capture and a unit test check the channel count.

### No fetch in the package

Vite's modulepreload polyfill is disabled (`build.modulePreload.polyfill: false`; Chrome 116+
supports modulepreload natively). It only fetched the extension's own chunks, but it put a `fetch()`
into every extension page; without it the build contains no network API at all, which an end-to-end
test checks and PRIVACY.md states.

## Git history

Two commits from interrupted work sessions keep their `wip:` messages: `b5039fd` (the first part of
the "All notes" feature, finished in the `feat(sidepanel)` commit right after it) and `a74ab5e`
(the paused-site badge, percent-escape URL normalization and the denied-permission checkbox). Folding
them into conventional commits means rewriting every later commit; that needs the owner's go-ahead,
so the history was left as it is. The code in both was verified by the later stages (build, lint,
unit and end-to-end tests).
