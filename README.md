# QuickNotes — highlights and sticky notes for any web page

A Manifest V3 Chrome extension. Select text to highlight it in one of four pastel colors, pin
draggable sticky notes anywhere on a page, and find everything again when you come back — anchored
to the text, not to pixel positions. Everything stays in your browser: no account, no network
requests, no analytics.

Interface in English and Spanish (follows the browser language).

## Features

- **Highlight** — a small toolbar appears over any text selection: yellow, green, blue, pink, or
  "Add note". Also available from the right-click menu ("Highlight with QuickNotes").
- **Robust anchoring** — highlights come back after a reload even when the page changed around them;
  repeated phrases are told apart by their context; highlights whose text is gone are listed as
  _orphaned_ instead of being drawn in the wrong place.
- **Sticky notes** — draggable, resizable, minimizable, four paper colors, bold / italic / bulleted
  and numbered lists (<kbd>Ctrl</kbd>+<kbd>B</kbd>, <kbd>Ctrl</kbd>+<kbd>I</kbd>). Positions are
  stored relative to the page size.
- **Click a highlight** to recolor it, attach a note, or delete it.
- **Keyboard shortcut** — <kbd>Alt</kbd>+<kbd>N</kbd> adds a note to the current page (change it at
  `chrome://extensions/shortcuts`).
- **Popup** — counts for the current page, New note, Open side panel, Pause on this site.
- **Side panel** — the current page's highlights and notes; click one to scroll to it.
- **Options** — default color, show/hide the selection toolbar, paused sites, theme, opt-in
  automatic restore on every site, and delete-all behind a typed confirmation.
- **Export / import** — Markdown for one page or all pages, JSON export and a validated JSON import
  (library functions in `src/lib/markdown.ts`).
- **Isolated UI** — everything QuickNotes draws lives in a Shadow DOM: the page's CSS cannot break it
  and its CSS cannot leak into the page.

## Permissions

| Permission                                     | Why                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `storage`                                      | Keep notes and highlights (`storage.local`) and settings (`storage.sync`).                                  |
| `activeTab`                                    | Run on the tab you act on — popup, context menu or shortcut — without access to any other site.             |
| `scripting`                                    | Inject the note/highlight script into that tab; register it for all sites only if you opt in.               |
| `contextMenus`                                 | The "Highlight with QuickNotes" item.                                                                       |
| `sidePanel`                                    | The side panel.                                                                                             |
| `http://*/*`, `https://*/*` (optional, opt-in) | Requested only when you enable "Restore my notes automatically on every site"; removed when you disable it. |

Without the opt-in, a page's notes reappear when you click the QuickNotes button on it. See
[DECISIONS.md](DECISIONS.md) for the reasoning.

## Install (unpacked)

Requirements: Node.js 22.22+ (developed with Node 24) and Chrome 116+.

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and choose the
`dist/` folder. Pin QuickNotes to the toolbar, open any article, select some text and pick a color.

To use it on local `file://` pages, open the extension's details and enable **Allow access to file
URLs**.

## Development

| Command          | What it does                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`    | Vite dev server (port 4320) writing a live-reloading build to `dist/`; load it unpacked. |
| `npm run build`  | Type-checks (`tsc`) and builds the production extension into `dist/`.                    |
| `npm run lint`   | ESLint (flat config, type-aware).                                                        |
| `npm test`       | Vitest unit tests (jsdom).                                                               |
| `npm run smoke`  | Builds, then drives the real extension in Chrome (see below).                            |
| `npm run zip`    | Builds and packs `dist/` into `quicknotes-v1.0.0.zip` with `manifest.json` at the root.  |
| `npm run icons`  | Re-renders `public/icons/icon-{16,32,48,128}.png` from `public/icons/icon.svg`.          |
| `npm run format` | Prettier.                                                                                |

### Tests

`npm test` covers URL normalization, storage (against an in-memory `chrome.storage` mock),
anchor serialization and resolution (text changed around a quote, repeated quotes, whitespace,
XPath fallback, orphans), highlight wrapping and removal, the HTML sanitizer, Markdown export, JSON
import validation and the locale files.

`npm run smoke` loads the built extension into Chrome through the DevTools protocol and checks, on a
page with deliberately hostile CSS: on-demand injection, the selection toolbar, highlights via the
toolbar and via the context-menu path, notes with formatting, dragging, Shadow-DOM isolation,
restore after reload (including a repeated quote), the highlight menu, orphan detection, pausing a
site, and the opt-in registered content script. Screenshots land in `test-results/`.

## How highlight anchoring works

When you highlight text, QuickNotes stores:

1. **the quote** — the exact text — with up to 32 characters of **context** before and after it;
2. **a fallback position** — the XPath of the element around each end of the selection, plus a
   character offset into that element's text;
3. the character position in the page text, used only to break ties.

When the page loads again, QuickNotes builds an index of the page's text and searches for the quote,
ignoring whitespace differences. If it appears once, that's it. If it appears several times, the
occurrence whose surroundings best match the saved context wins. If the quote is gone, the XPath
fallback is tried, and its text is accepted only if it is still at least 75 % similar to the quote.
Anything else is reported as orphaned. Pages that render late (single-page apps) are watched for a
few seconds before a highlight is declared orphaned.

Highlights are drawn by wrapping the matching text in `<quicknotes-mark>` elements; notes, toolbars
and menus live in a single Shadow DOM host.

## Project structure

```
src/
  background/   service worker: context menu, Alt+N, injection, auto-restore registration
  content/      index.ts (controller), anchor.ts, highlighter.ts, shadow.ts,
                toolbar.tsx, stickyNote.tsx, app.tsx, icons.tsx, content.css
  lib/          types, storage, url, markdown (export/import), richtext, sanitize,
                messages, i18n, colors, merge
  popup/  sidepanel/  options/  ui/  styles/
  _locales/en  _locales/es
tests/          Vitest unit tests
scripts/        zip.mjs, smoke.mjs, icons.mjs
public/icons/   icon.svg and the rendered PNGs
```

## Privacy

QuickNotes makes no network requests and contains no analytics. Notes, highlights and settings are
stored with the `chrome.storage` API in your browser profile; settings may follow your profile if
you use Chrome sync. Deleting the extension deletes its data.
