# QuickNotes privacy policy

_Effective September 24, 2026 · applies to QuickNotes 1.0.0 for Chrome_

QuickNotes is a browser extension for highlighting text and pinning sticky notes on web pages.
It works entirely inside your browser. **It has no servers, no account, no analytics and makes no
network requests.** Nothing you highlight or write is sent to the developer or to anyone else.

## What QuickNotes stores, and where

| Data                                                                                                                                               | Where it is kept                                                                  | Why                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| For each page you annotate: its address (URL, without tracking parameters or `#fragment`) and title                                                | `chrome.storage.local`, on your device                                            | To show your notes again when you come back       |
| The text you highlighted, up to 32 characters around it, and its position in the page                                                              | `chrome.storage.local`, on your device                                            | To find the passage again after a reload          |
| Your notes: their text, color, position, size and whether they are minimized                                                                       | `chrome.storage.local`, on your device                                            | To draw them where you left them                  |
| Settings: default color, whether the selection toolbar is shown, the list of paused sites (host names), theme, and whether automatic restore is on | `chrome.storage.sync` — synced to your Google account only if you use Chrome sync | To keep your preferences across your own browsers |

QuickNotes does **not** read, record or keep anything about pages you do not annotate. It does not
store your browsing history, it does not track which pages you visit, and it contains no
advertising, analytics or telemetry code.

## What QuickNotes never does

- It never sends data over the network (the code contains no `fetch`, `XMLHttpRequest`, WebSocket or
  beacon calls, and loads no remote code).
- It never sells, shares or transfers your data to anyone.
- It never uses your data for advertising, creditworthiness, or anything other than showing you
  your own highlights and notes.

## Permissions

QuickNotes asks for the smallest set of permissions it can work with:

- **storage** — keep your highlights, notes and settings.
- **activeTab** — work on the tab you are using, and only after you act on it (toolbar button,
  right-click menu, or <kbd>Alt</kbd>+<kbd>N</kbd>).
- **scripting** — draw your highlights and notes inside that tab.
- **contextMenus** — the "Highlight with QuickNotes" item in the right-click menu.
- **sidePanel** — the side panel that lists your notes.
- **Access to all http/https sites (optional, off by default)** — only if you turn on
  "Restore my notes automatically on every site" in Options, and only after Chrome asks you. You
  can turn it off in Options or on `chrome://extensions` at any time.

## Your control over your data

- **Export**: the side panel exports one page or everything to Markdown or JSON.
- **Delete**: delete single highlights and notes, whole pages (side panel → All notes), or
  everything (Options → "Delete all data", confirmed by typing the word shown).
- **Uninstall**: removing the extension removes all of its stored data from your browser.
- **Pause**: "Pause on this site" stops QuickNotes from running on a site at all.

## Children

QuickNotes is a general-purpose tool and does not knowingly collect any information from anyone,
including children.

## Changes

If a future version changes what is stored or starts to transmit anything, this policy will be
updated before that version is published, and the change will be described in the release notes.

## Contact

Questions about this policy can be sent through the support link of the QuickNotes listing on the
Chrome Web Store.

---

# Chrome Web Store — "Privacy practices" tab

Ready-to-paste answers for the Developer Dashboard. Each justification is well under the 1,000
character limit of its field.

## Single purpose

> QuickNotes lets you highlight text and attach sticky notes to web pages, and shows them again when
> you return to the page. Everything it does — highlighting, notes, the side panel that lists and
> searches them, export and import — serves that one purpose.

## Permission justifications

**storage**

> Stores the user's highlights and notes (chrome.storage.local) and their settings
> (chrome.storage.sync) so they reappear when the user comes back to a page. Nothing is sent
> anywhere; the data stays in the browser.

**activeTab**

> Gives QuickNotes temporary access to the tab the user is acting on — when they click the toolbar
> button, choose "Highlight with QuickNotes" in the context menu, or press the Alt+N shortcut — so it
> can show that page's highlights and notes. This is what lets the extension work without asking
> for access to all websites.

**scripting**

> Used with activeTab to inject QuickNotes' content script into the current tab
> (chrome.scripting.executeScript), which draws the highlights, the selection toolbar and the
> sticky notes. If the user opts in to automatic restore, it registers the same script with
> chrome.scripting.registerContentScripts. The script is bundled in the package; no remote code is
> executed.

**contextMenus**

> Adds one item, "Highlight with QuickNotes", to the right-click menu when text is selected.

**sidePanel**

> Provides the side panel where users see the highlights and notes of the current page (click to
> scroll to one), browse and search all their notes, and export or import them.

**Host permissions (optional: `http://*/*`, `https://*/*`)**

> Optional and off by default. Requested at runtime only when the user turns on "Restore my notes
> automatically on every site" in Options. With it, QuickNotes registers its content script so that
> highlights and notes reappear as soon as a page loads, instead of after a click on the toolbar
> button. It is used for nothing else: the extension makes no network requests and does not read
> pages the user has not annotated. Turning the option off (or revoking the permission in Chrome)
> unregisters the script.

## Remote code

> **No, I am not using remote code.** All JavaScript is included in the package; the extension does
> not load or evaluate code from any server.

## Data usage

QuickNotes stores page addresses, highlighted text and notes **only on the user's device** and never
transmits them, so nothing is "collected" in the sense of the Chrome Web Store user-data policy. In
the "What user data do you plan to collect" list, **leave every category unchecked**.

> If a reviewer asks, the accurate description is: "Website content (highlighted passages and the
> user's own notes) and the URLs of annotated pages are stored locally with chrome.storage and are
> never transmitted off the device."

Tick all three certifications:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single
      purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

Publish this file at a public URL (for example, the rendered `PRIVACY.md` of a public repository, or
a GitHub Gist) and paste that URL into the "Privacy policy" field. `docs/PUBLISHING.md` explains the
options.
