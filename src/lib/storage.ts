/**
 * Persistence.
 *
 *  - Notes and highlights: chrome.storage.local, one record per page under the
 *    key `page:<normalized URL>`. A page record is deleted as soon as it holds
 *    no highlight and no note, so "all pages" is simply every `page:` key.
 *  - Settings: chrome.storage.sync under the key `settings` (small, follows the
 *    user's browser profile if they sync it).
 *
 * Writes are read-modify-write and are serialized through one queue per
 * JavaScript context, so two quick edits in the same tab never overwrite each
 * other. See DECISIONS.md for the cross-context trade-off.
 */
import { mergePages } from './merge';
import {
  DEFAULT_SETTINGS,
  isColor,
  isTheme,
  type Highlight,
  type PageData,
  type Settings,
  type StickyNote,
} from './types';
import { entryCoversSite, normalizeUrl, parseSiteEntry } from './url';

export const PAGE_KEY_PREFIX = 'page:';
export const SETTINGS_KEY = 'settings';

export function pageKey(url: string): string {
  return `${PAGE_KEY_PREFIX}${normalizeUrl(url)}`;
}

export function isPageKey(key: string): boolean {
  return key.startsWith(PAGE_KEY_PREFIX);
}

export function emptyPage(url: string, title = ''): PageData {
  return { url: normalizeUrl(url), title, highlights: [], notes: [], updatedAt: Date.now() };
}

/** Defensive read of a stored page record (older or hand-edited data must not crash the UI). */
export function coercePage(value: unknown, fallbackUrl = ''): PageData | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<PageData>;
  return {
    url: typeof record.url === 'string' ? record.url : normalizeUrl(fallbackUrl),
    title: typeof record.title === 'string' ? record.title : '',
    highlights: Array.isArray(record.highlights) ? record.highlights : [],
    notes: Array.isArray(record.notes) ? record.notes : [],
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  };
}

export function coerceSettings(value: unknown): Settings {
  const record = typeof value === 'object' && value !== null ? (value as Partial<Settings>) : {};
  const pausedSites = Array.isArray(record.pausedSites)
    ? [
        ...new Set(
          record.pausedSites
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => parseSiteEntry(entry))
            .filter((entry): entry is string => entry !== null),
        ),
      ].sort()
    : [];
  return {
    defaultColor: isColor(record.defaultColor) ? record.defaultColor : DEFAULT_SETTINGS.defaultColor,
    showToolbar: typeof record.showToolbar === 'boolean' ? record.showToolbar : DEFAULT_SETTINGS.showToolbar,
    pausedSites,
    theme: isTheme(record.theme) ? record.theme : DEFAULT_SETTINGS.theme,
    autoRestore: typeof record.autoRestore === 'boolean' ? record.autoRestore : DEFAULT_SETTINGS.autoRestore,
  };
}

// ---------------------------------------------------------------------------
// Write queue
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function getPage(url: string): Promise<PageData | null> {
  const key = pageKey(url);
  const result = await chrome.storage.local.get(key);
  return coercePage(result[key], url);
}

/** Every stored page, most recently updated first. */
export async function getAllPages(): Promise<PageData[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => isPageKey(key))
    .map(([key, value]) => coercePage(value, key.slice(PAGE_KEY_PREFIX.length)))
    .filter((page): page is PageData => page !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface UpdateOptions {
  /** Page title to record (the latest known title wins). */
  title?: string;
  /** Bump the page's updatedAt (default true). Housekeeping writes pass false. */
  touch?: boolean;
}

/**
 * Read-modify-write of one page. The mutator edits a draft copy; returning
 * `false` from it cancels the write (any other result proceeds). The record is removed when it ends up
 * empty. Resolves with the stored page, or null when the page no longer exists.
 */
export function updatePage(
  url: string,
  mutate: (draft: PageData) => boolean | void,
  options: UpdateOptions = {},
): Promise<PageData | null> {
  return serialize(async () => {
    const key = pageKey(url);
    const current = (await getPage(url)) ?? emptyPage(url, options.title ?? '');
    const draft = structuredClone(current);
    if (mutate(draft) === false) return current.highlights.length + current.notes.length > 0 ? current : null;
    if (options.title) draft.title = options.title;
    if (options.touch !== false) draft.updatedAt = Date.now();

    if (draft.highlights.length === 0 && draft.notes.length === 0) {
      await chrome.storage.local.remove(key);
      return null;
    }
    await chrome.storage.local.set({ [key]: draft });
    return draft;
  });
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = item;
}

export function saveHighlight(url: string, highlight: Highlight, title?: string): Promise<PageData | null> {
  return updatePage(url, (page) => upsert(page.highlights, highlight), { title });
}

/** Removes a highlight; notes that were attached to it stay, as standalone notes. */
export function removeHighlight(url: string, id: string): Promise<PageData | null> {
  return updatePage(url, (page) => {
    const before = page.highlights.length;
    page.highlights = page.highlights.filter((highlight) => highlight.id !== id);
    if (page.highlights.length === before) return false;
    for (const note of page.notes) {
      if (note.highlightId === id) delete note.highlightId;
    }
    return true;
  });
}

export function saveNote(url: string, note: StickyNote, title?: string): Promise<PageData | null> {
  return updatePage(url, (page) => upsert(page.notes, note), { title });
}

export function removeNote(url: string, id: string): Promise<PageData | null> {
  return updatePage(url, (page) => {
    const before = page.notes.length;
    page.notes = page.notes.filter((note) => note.id !== id);
    return page.notes.length !== before;
  });
}

/**
 * Records which highlights could not be anchored on the page. Only writes when a
 * flag actually changes, and does not count as user activity (updatedAt stays).
 */
export function setOrphans(url: string, orphanIds: ReadonlySet<string>): Promise<PageData | null> {
  return updatePage(
    url,
    (page) => {
      let changed = false;
      for (const highlight of page.highlights) {
        const orphaned = orphanIds.has(highlight.id);
        if (Boolean(highlight.orphaned) !== orphaned) {
          changed = true;
          if (orphaned) highlight.orphaned = true;
          else delete highlight.orphaned;
        }
      }
      return changed;
    },
    { touch: false },
  );
}

export function deletePage(url: string): Promise<void> {
  return serialize(() => chrome.storage.local.remove(pageKey(url)));
}

/** Deletes every page. With `includeSettings`, settings go back to their defaults too. */
export function clearAllData({ includeSettings = true } = {}): Promise<void> {
  return serialize(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(isPageKey);
    if (keys.length > 0) await chrome.storage.local.remove(keys);
    if (includeSettings) await chrome.storage.sync.remove(SETTINGS_KEY);
  });
}

/**
 * Stores imported pages. `merge` keeps existing data and, for items present on
 * both sides, the copy with the newer updatedAt; `replace` deletes every stored
 * page first.
 */
export function importPages(pages: readonly PageData[], mode: 'merge' | 'replace'): Promise<number> {
  return serialize(async () => {
    const all = await chrome.storage.local.get(null);
    const existingKeys = Object.keys(all).filter(isPageKey);
    if (mode === 'replace' && existingKeys.length > 0) await chrome.storage.local.remove(existingKeys);

    const updates: Record<string, PageData> = {};
    for (const page of pages) {
      const key = pageKey(page.url);
      const existing = mode === 'merge' ? coercePage(all[key], page.url) : null;
      const merged = existing ? mergePages(existing, { ...page, url: existing.url }) : page;
      if (merged.highlights.length + merged.notes.length > 0) updates[key] = merged;
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
    return Object.keys(updates).length;
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return coerceSettings(result[SETTINGS_KEY]);
}

/** chrome.storage.sync limit for one item (8,192 bytes), which all settings share. */
const SYNC_QUOTA_BYTES_PER_ITEM = 8_192;

/** The settings no longer fit in one storage.sync item (in practice: too many paused sites). */
export class SettingsTooLargeError extends Error {
  constructor() {
    super('The settings are larger than chrome.storage.sync allows for one item.');
    this.name = 'SettingsTooLargeError';
  }
}

/** Size of an item as chrome.storage.sync counts it: the key plus the JSON of the value, in bytes. */
export function syncItemBytes(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

/**
 * Read-modify-write of the settings. Rejects — and stores nothing — with
 * SettingsTooLargeError when the result would not fit in one storage.sync item,
 * or with Chrome's own error when the write fails; callers show the error and
 * keep the previous state.
 */
export function updateSettings(
  patch: Partial<Settings> | ((current: Settings) => Partial<Settings>),
): Promise<Settings> {
  return serialize(async () => {
    const current = await getSettings();
    const changes = typeof patch === 'function' ? patch(current) : patch;
    const next = coerceSettings({ ...current, ...changes });
    const quota = chrome.storage.sync.QUOTA_BYTES_PER_ITEM || SYNC_QUOTA_BYTES_PER_ITEM;
    if (syncItemBytes(SETTINGS_KEY, next) > quota) throw new SettingsTooLargeError();
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

/** Adds or removes one entry of the paused list (Options). Accepts a URL, a host or a bare site. */
export function setSitePaused(siteOrUrl: string, paused: boolean): Promise<Settings> {
  const site = parseSiteEntry(siteOrUrl);
  return updateSettings((current) => {
    if (!site) return {};
    const others = current.pausedSites.filter((entry) => entry !== site);
    return { pausedSites: paused ? [...others, site] : others };
  });
}

/**
 * The popup's "Pause on this site" for a page. Pausing adds the page's site;
 * resuming removes every entry that covers it — its own site and any parent
 * domain (a page on blog.example.com is also paused by "example.com") — so the
 * page really is resumed. Rejects for pages without a host name (file://).
 */
export function setUrlPaused(url: string, paused: boolean): Promise<Settings> {
  const site = parseSiteEntry(url);
  if (!site) return Promise.reject(new Error(`No site to pause for ${url}`));
  return updateSettings((current) => {
    const others = current.pausedSites.filter((entry) => (paused ? entry !== site : !entryCoversSite(entry, site)));
    return { pausedSites: paused ? [...others, site] : others };
  });
}

// ---------------------------------------------------------------------------
// Change subscription
// ---------------------------------------------------------------------------

export type StoreChange =
  { type: 'page'; url: string; page: PageData | null } | { type: 'settings'; settings: Settings };

/**
 * Calls `listener` for every page or settings change made from any context
 * (content scripts, side panel, popup, options, background). Returns an
 * unsubscribe function.
 */
export function subscribe(listener: (change: StoreChange) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    for (const [key, change] of Object.entries(changes)) {
      if (area === 'local' && isPageKey(key)) {
        const url = key.slice(PAGE_KEY_PREFIX.length);
        listener({ type: 'page', url, page: coercePage(change.newValue, url) });
      } else if (area === 'sync' && key === SETTINGS_KEY) {
        listener({ type: 'settings', settings: coerceSettings(change.newValue) });
      }
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** Convenience: changes to one page only (URL is normalized before comparing). */
export function subscribePage(url: string, listener: (page: PageData | null) => void): () => void {
  const target = normalizeUrl(url);
  return subscribe((change) => {
    if (change.type === 'page' && change.url === target) listener(change.page);
  });
}

export function subscribeSettings(listener: (settings: Settings) => void): () => void {
  return subscribe((change) => {
    if (change.type === 'settings') listener(change.settings);
  });
}
