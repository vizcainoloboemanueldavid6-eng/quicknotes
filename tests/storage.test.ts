import { describe, expect, it, vi } from 'vitest';
import {
  PAGE_KEY_PREFIX,
  SETTINGS_KEY,
  clearAllData,
  coerceSettings,
  deletePage,
  getAllPages,
  getPage,
  getSettings,
  importPages,
  pageKey,
  removeHighlight,
  removeNote,
  saveHighlight,
  saveNote,
  setOrphans,
  setSitePaused,
  subscribe,
  subscribePage,
  updatePage,
  updateSettings,
  type StoreChange,
} from '../src/lib/storage';
import { DEFAULT_SETTINGS } from '../src/lib/types';
import { flushEvents } from './chromeMock';
import { NOON, makeHighlight, makeNote, makePage } from './fixtures';

const URL_A = 'https://example.com/article';

describe('page storage', () => {
  it('stores pages in chrome.storage.local under the normalized URL', async () => {
    await saveHighlight('https://Example.com/article/?utm_source=x#intro', makeHighlight('h1'), 'Article');
    const raw = mockChrome.storage.local.dump();
    expect(Object.keys(raw)).toEqual([`${PAGE_KEY_PREFIX}https://example.com/article`]);
    expect(pageKey(URL_A)).toBe('page:https://example.com/article');

    const page = await getPage('https://example.com/article#other');
    expect(page?.url).toBe('https://example.com/article');
    expect(page?.title).toBe('Article');
    expect(page?.highlights.map((h) => h.id)).toEqual(['h1']);
  });

  it('returns null for a page without data', async () => {
    expect(await getPage('https://example.com/nothing')).toBeNull();
  });

  it('upserts highlights and notes by id', async () => {
    await saveHighlight(URL_A, makeHighlight('h1'));
    await saveHighlight(URL_A, makeHighlight('h1', { color: 'pink' }));
    await saveNote(URL_A, makeNote('n1'));
    await saveNote(URL_A, makeNote('n1', { html: '<b>edited</b>' }));
    const page = await getPage(URL_A);
    expect(page?.highlights).toHaveLength(1);
    expect(page?.highlights[0]?.color).toBe('pink');
    expect(page?.notes).toHaveLength(1);
    expect(page?.notes[0]?.html).toBe('<b>edited</b>');
  });

  it('bumps updatedAt on edits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    await saveNote(URL_A, makeNote('n1'));
    vi.setSystemTime(NOON + 60_000);
    await saveNote(URL_A, makeNote('n2'));
    expect((await getPage(URL_A))?.updatedAt).toBe(NOON + 60_000);
    vi.useRealTimers();
  });

  it('deletes the page record when its last item is removed', async () => {
    await saveHighlight(URL_A, makeHighlight('h1'));
    await saveNote(URL_A, makeNote('n1'));
    await removeNote(URL_A, 'n1');
    expect(await getPage(URL_A)).not.toBeNull();
    await removeHighlight(URL_A, 'h1');
    expect(await getPage(URL_A)).toBeNull();
    expect(mockChrome.storage.local.dump()).toEqual({});
  });

  it('removing a highlight keeps its notes as standalone notes', async () => {
    await saveHighlight(URL_A, makeHighlight('h1'));
    await saveNote(URL_A, makeNote('n1', { highlightId: 'h1' }));
    await removeHighlight(URL_A, 'h1');
    const page = await getPage(URL_A);
    expect(page?.highlights).toEqual([]);
    expect(page?.notes[0]?.id).toBe('n1');
    expect(page?.notes[0]).not.toHaveProperty('highlightId');
  });

  it('does not write when removing something that does not exist', async () => {
    await saveNote(URL_A, makeNote('n1'));
    const setSpy = vi.spyOn(mockChrome.storage.local, 'set');
    await removeNote(URL_A, 'missing');
    await removeHighlight(URL_A, 'missing');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('serializes concurrent writes so none is lost', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => saveNote(URL_A, makeNote(`n${i}`))));
    const page = await getPage(URL_A);
    expect(page?.notes).toHaveLength(25);
  });

  it('a cancelled mutation leaves storage untouched', async () => {
    await saveNote(URL_A, makeNote('n1'));
    const before = mockChrome.storage.local.dump();
    const result = await updatePage(URL_A, () => false);
    expect(result?.notes).toHaveLength(1);
    expect(mockChrome.storage.local.dump()).toEqual(before);
  });

  it('records orphans without touching updatedAt, and only when they change', async () => {
    await saveHighlight(URL_A, makeHighlight('h1'));
    await saveHighlight(URL_A, makeHighlight('h2'));
    const before = (await getPage(URL_A))?.updatedAt;

    await setOrphans(URL_A, new Set(['h2']));
    let page = await getPage(URL_A);
    expect(page?.highlights.find((h) => h.id === 'h2')?.orphaned).toBe(true);
    expect(page?.highlights.find((h) => h.id === 'h1')).not.toHaveProperty('orphaned');
    expect(page?.updatedAt).toBe(before);

    const setSpy = vi.spyOn(mockChrome.storage.local, 'set');
    await setOrphans(URL_A, new Set(['h2']));
    expect(setSpy).not.toHaveBeenCalled();

    await setOrphans(URL_A, new Set());
    page = await getPage(URL_A);
    expect(page?.highlights.every((h) => !('orphaned' in h))).toBe(true);
  });

  it('lists all pages, most recently updated first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    await saveNote('https://example.com/old', makeNote('a'));
    vi.setSystemTime(NOON + 1000);
    await saveNote('https://example.com/new', makeNote('b'));
    vi.useRealTimers();
    await chrome.storage.local.set({ unrelated: 1 });
    const pages = await getAllPages();
    expect(pages.map((p) => p.url)).toEqual(['https://example.com/new', 'https://example.com/old']);
  });

  it('tolerates malformed stored records', async () => {
    await chrome.storage.local.set({ [pageKey(URL_A)]: { title: 42, highlights: 'nope' } });
    const page = await getPage(URL_A);
    expect(page).toEqual({ url: URL_A, title: '', highlights: [], notes: [], updatedAt: 0 });
  });

  it('deletes one page or everything', async () => {
    await saveNote('https://example.com/1', makeNote('a'));
    await saveNote('https://example.com/2', makeNote('b'));
    await updateSettings({ defaultColor: 'blue' });
    await deletePage('https://example.com/1#x');
    expect((await getAllPages()).map((p) => p.url)).toEqual(['https://example.com/2']);

    await chrome.storage.local.set({ unrelated: true });
    await clearAllData();
    expect(await getAllPages()).toEqual([]);
    expect(mockChrome.storage.local.dump()).toEqual({ unrelated: true });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('import into storage', () => {
  it('merges by id, keeping the newer copy', async () => {
    await saveNote(URL_A, makeNote('n1', { html: 'old', updatedAt: NOON }));
    await saveNote(URL_A, makeNote('n2', { html: 'mine', updatedAt: NOON + 5000 }));
    const incoming = makePage(URL_A, {
      notes: [
        makeNote('n1', { html: 'newer', updatedAt: NOON + 1000 }),
        makeNote('n2', { html: 'stale', updatedAt: NOON }),
      ],
      highlights: [makeHighlight('h9')],
    });
    const count = await importPages([incoming], 'merge');
    expect(count).toBe(1);
    const page = await getPage(URL_A);
    const html = Object.fromEntries((page?.notes ?? []).map((n) => [n.id, n.html]));
    expect(html).toEqual({ n1: 'newer', n2: 'mine' });
    expect(page?.highlights.map((h) => h.id)).toEqual(['h9']);
  });

  it('replace mode drops existing pages first', async () => {
    await saveNote('https://example.com/keep-not', makeNote('x'));
    await importPages([makePage(URL_A, { notes: [makeNote('n1')] })], 'replace');
    expect((await getAllPages()).map((p) => p.url)).toEqual([URL_A]);
  });
});

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('are stored in chrome.storage.sync', async () => {
    await updateSettings({ defaultColor: 'green', showToolbar: false });
    expect(mockChrome.storage.sync.dump()[SETTINGS_KEY]).toMatchObject({ defaultColor: 'green', showToolbar: false });
    expect(mockChrome.storage.local.dump()).toEqual({});
    expect((await getSettings()).defaultColor).toBe('green');
  });

  it('coerces invalid values back to defaults', () => {
    expect(
      coerceSettings({
        defaultColor: 'purple',
        showToolbar: 'yes',
        pausedSites: ['https://www.Example.com/x', 'example.com', 42, 'not a site!'],
        theme: 'neon',
        autoRestore: 1,
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, pausedSites: ['example.com'] });
    expect(coerceSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('pauses and resumes sites', async () => {
    await setSitePaused('https://www.example.com/article', true);
    await setSitePaused('news.example.org', true);
    expect((await getSettings()).pausedSites).toEqual(['example.com', 'news.example.org']);
    await setSitePaused('example.com', false);
    expect((await getSettings()).pausedSites).toEqual(['news.example.org']);
    await setSitePaused('not a site!', true);
    expect((await getSettings()).pausedSites).toEqual(['news.example.org']);
  });
});

describe('change subscription', () => {
  it('reports page and settings changes from any context', async () => {
    const changes: StoreChange[] = [];
    const unsubscribe = subscribe((change) => changes.push(change));
    await saveNote(URL_A, makeNote('n1'));
    await updateSettings({ theme: 'dark' });
    await chrome.storage.local.set({ unrelated: 1 });
    await flushEvents();

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ type: 'page', url: URL_A });
    expect(changes[0]?.type === 'page' && changes[0].page?.notes[0]?.id).toBe('n1');
    expect(changes[1]).toMatchObject({ type: 'settings', settings: { theme: 'dark' } });

    unsubscribe();
    await saveNote(URL_A, makeNote('n2'));
    await flushEvents();
    expect(changes).toHaveLength(2);
  });

  it('reports a deleted page as null', async () => {
    await saveNote(URL_A, makeNote('n1'));
    await flushEvents();
    const seen: unknown[] = [];
    subscribePage(`${URL_A}/#frag`, (page) => seen.push(page));
    subscribePage('https://example.com/other', () => seen.push('wrong page'));
    await removeNote(URL_A, 'n1');
    await flushEvents();
    expect(seen).toEqual([null]);
  });
});
