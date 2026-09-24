/**
 * Full-text search and filters for the side panel's "All notes" tab. Pure
 * functions over stored pages, so they are unit-tested without a browser.
 *
 * Matching is case- and accent-insensitive ("resume" finds "Résumé"). The query
 * is split into words and every word must appear — in the item's own text, or
 * in the page's title or URL. A page whose title/URL matches shows all of its
 * items (after the color filter); otherwise only the items that match are shown.
 */
import { htmlToText } from './richtext';
import type { Color, Highlight, PageData, StickyNote } from './types';
import { hostOf, siteOf } from './url';

export interface SearchFilters {
  query: string;
  /** Colors to keep; an empty list keeps every color. */
  colors: readonly Color[];
  /** A site key from `siteKey()` ('' = every site). */
  site: string;
}

export type SearchItem =
  | { kind: 'highlight'; id: string; color: Color; text: string; orphaned: boolean; highlight: Highlight }
  | { kind: 'note'; id: string; color: Color; text: string; note: StickyNote };

export interface PageResult {
  page: PageData;
  site: string;
  items: SearchItem[];
}

export interface SearchSummary {
  pages: number;
  highlights: number;
  notes: number;
}

/** Special site key for pages without a host (file:// URLs). */
export const LOCAL_FILES_SITE = '(local files)';

/** The site a page belongs to, for the domain filter: hostname without `www.`. */
export function siteKey(url: string): string {
  return siteOf(hostOf(url)) || LOCAL_FILES_SITE;
}

/** Lower-cased, accent-free, whitespace-collapsed text used for matching. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryTerms(query: string): string[] {
  const folded = fold(query);
  return folded ? [...new Set(folded.split(' '))] : [];
}

function containsAll(haystack: string, terms: readonly string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

/** The page's items in reading order: highlights by position, then notes by creation. */
export function pageItems(page: PageData): SearchItem[] {
  const highlights = [...page.highlights]
    .sort((a, b) => a.anchor.position.start - b.anchor.position.start)
    .map(
      (highlight): SearchItem => ({
        kind: 'highlight',
        id: highlight.id,
        color: highlight.color,
        text: highlight.anchor.quote.exact.replace(/\s+/g, ' ').trim(),
        orphaned: highlight.orphaned === true,
        highlight,
      }),
    );
  const notes = [...page.notes]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((note): SearchItem => ({ kind: 'note', id: note.id, color: note.color, text: htmlToText(note.html), note }));
  return [...highlights, ...notes];
}

/** Every site that has stored pages, sorted, with its page count. */
export function listSites(pages: readonly PageData[]): Array<{ site: string; count: number }> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const site = siteKey(page.url);
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => (a.site === LOCAL_FILES_SITE ? 1 : b.site === LOCAL_FILES_SITE ? -1 : a.site.localeCompare(b.site)));
}

/** Applies the search and filters; pages keep their given order (most recently updated first). */
export function searchPages(pages: readonly PageData[], filters: SearchFilters): PageResult[] {
  const terms = queryTerms(filters.query);
  const colors = new Set(filters.colors);
  const results: PageResult[] = [];

  for (const page of pages) {
    const site = siteKey(page.url);
    if (filters.site && site !== filters.site) continue;

    const colored = pageItems(page).filter((item) => colors.size === 0 || colors.has(item.color));
    if (colored.length === 0) continue;

    let items = colored;
    if (terms.length > 0) {
      const pageText = fold(`${page.title} ${page.url}`);
      if (!containsAll(pageText, terms)) {
        items = colored.filter((item) => containsAll(fold(`${item.text} ${pageText}`), terms));
      }
    }
    if (items.length > 0) results.push({ page, site, items });
  }
  return results;
}

export function summarize(results: readonly PageResult[]): SearchSummary {
  let highlights = 0;
  let notes = 0;
  for (const result of results) {
    for (const item of result.items) {
      if (item.kind === 'highlight') highlights++;
      else notes++;
    }
  }
  return { pages: results.length, highlights, notes };
}

/**
 * Splits `text` into plain and matching parts for rendering search hits, using
 * the same folding as the search itself (so an accent-free query marks the
 * accented original).
 */
export function markMatches(text: string, query: string): Array<{ text: string; match: boolean }> {
  const terms = queryTerms(query);
  if (terms.length === 0 || !text) return [{ text, match: false }];

  // Fold character by character so every folded position maps back to the original.
  let folded = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const piece = char
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/\s/g, ' ');
    for (let k = 0; k < piece.length; k++) origin.push(i);
    folded += piece;
    i += char.length;
  }

  const hits = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (let at = folded.indexOf(term, from); at !== -1; at = folded.indexOf(term, from)) {
      const start = origin[at] ?? 0;
      const lastOrigin = origin[at + term.length - 1] ?? start;
      const end = lastOrigin + String.fromCodePoint(text.codePointAt(lastOrigin) ?? 0).length;
      for (let i = start; i < end; i++) hits[i] = true;
      from = at + term.length;
    }
  }

  const parts: Array<{ text: string; match: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const match = hits[i] === true;
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += text[i];
    else parts.push({ text: text[i] ?? '', match });
  }
  return parts;
}
