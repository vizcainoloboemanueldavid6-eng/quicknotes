import { describe, expect, it } from 'vitest';
import {
  LOCAL_FILES_SITE,
  fold,
  listSites,
  markMatches,
  pageItems,
  queryTerms,
  searchPages,
  siteKey,
  summarize,
} from '../src/lib/search';
import type { PageData } from '../src/lib/types';
import { makeHighlight, makeNote, makePage } from './fixtures';

function quote(exact: string, start: number) {
  return {
    ...makeHighlight('x').anchor,
    quote: { exact, prefix: '', suffix: '' },
    position: { start, end: start + exact.length },
  };
}

const article = makePage('https://www.example.com/reading', {
  title: 'Reading With a Pencil',
  updatedAt: 3,
  highlights: [
    makeHighlight('h-late', { color: 'green', anchor: quote('Deciding is the useful part.', 500) }),
    makeHighlight('h-early', { color: 'yellow', anchor: quote('The margin is the only part of a page', 100) }),
    makeHighlight('h-orphan', { color: 'pink', orphaned: true, anchor: quote('A sentence that is gone', 900) }),
  ],
  notes: [
    makeNote('n-second', { color: 'blue', html: '<b>Résumé</b> the argument', createdAt: 20 }),
    makeNote('n-first', { color: 'yellow', html: '<ul><li>Check the sample size</li></ul>', createdAt: 10 }),
  ],
});

const recipes = makePage('https://blog.example.com/bread', {
  title: 'Bread notes',
  updatedAt: 2,
  highlights: [makeHighlight('b1', { color: 'yellow', anchor: quote('Let the dough rest overnight', 40) })],
});

const local = makePage('file:///C:/demo/article.html', {
  title: 'Local copy',
  updatedAt: 1,
  notes: [makeNote('l1', { color: 'pink', html: 'offline margin note' })],
});

const other = makePage('https://another.test/', {
  title: 'Another site',
  updatedAt: 0,
  highlights: [makeHighlight('o1', { color: 'blue', anchor: quote('nothing in common', 5) })],
});

const PAGES: PageData[] = [article, recipes, local, other];

describe('text folding', () => {
  it('ignores case, accents and repeated whitespace', () => {
    expect(fold('  Résumé\n  CAFÉ  ')).toBe('resume cafe');
  });

  it('splits a query into unique terms', () => {
    expect(queryTerms('  Margin   margin PAGE ')).toEqual(['margin', 'page']);
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('page items', () => {
  it('lists highlights in page order, then notes in creation order', () => {
    expect(pageItems(article).map((item) => item.id)).toEqual(['h-early', 'h-late', 'h-orphan', 'n-first', 'n-second']);
  });

  it('uses plain text for notes and flags orphans', () => {
    const items = pageItems(article);
    expect(items.find((item) => item.id === 'n-second')?.text).toBe('Résumé the argument');
    const orphan = items.find((item) => item.id === 'h-orphan');
    expect(orphan?.kind === 'highlight' && orphan.orphaned).toBe(true);
  });
});

describe('sites', () => {
  it('groups by hostname without www and files under a local key', () => {
    expect(siteKey('https://www.example.com/a')).toBe('example.com');
    expect(siteKey('https://blog.example.com/a')).toBe('blog.example.com');
    expect(siteKey('file:///C:/demo/article.html')).toBe(LOCAL_FILES_SITE);
  });

  it('lists every site once, sorted, local files last', () => {
    expect(listSites(PAGES)).toEqual([
      { site: 'another.test', count: 1 },
      { site: 'blog.example.com', count: 1 },
      { site: 'example.com', count: 1 },
      { site: LOCAL_FILES_SITE, count: 1 },
    ]);
  });
});

describe('searchPages', () => {
  const none = { query: '', colors: [], site: '' };

  it('returns every page and item without filters, keeping the page order', () => {
    const results = searchPages(PAGES, none);
    expect(results.map((result) => result.page.url)).toEqual(PAGES.map((page) => page.url));
    expect(summarize(results)).toEqual({ pages: 4, highlights: 5, notes: 3 });
  });

  it('finds items by their text, ignoring case and accents', () => {
    const results = searchPages(PAGES, { ...none, query: 'resume' });
    expect(results).toHaveLength(1);
    expect(results[0]?.items.map((item) => item.id)).toEqual(['n-second']);
  });

  it('requires every word of the query to match', () => {
    expect(searchPages(PAGES, { ...none, query: 'margin page' })[0]?.items.map((item) => item.id)).toEqual(['h-early']);
    expect(searchPages(PAGES, { ...none, query: 'margin bread' })).toEqual([]);
  });

  it('matches words across an item and its page title', () => {
    const results = searchPages(PAGES, { ...none, query: 'bread dough' });
    expect(results.map((result) => result.page.url)).toEqual([recipes.url]);
  });

  it('shows all items of a page whose title matches', () => {
    const results = searchPages(PAGES, { ...none, query: 'pencil' });
    expect(results).toHaveLength(1);
    expect(results[0]?.items).toHaveLength(5);
  });

  it('matches the URL too', () => {
    expect(searchPages(PAGES, { ...none, query: 'another.test' }).map((result) => result.page.url)).toEqual([
      other.url,
    ]);
  });

  it('searches inside note formatting and lists', () => {
    expect(searchPages(PAGES, { ...none, query: 'sample size' })[0]?.items.map((item) => item.id)).toEqual(['n-first']);
  });

  it('filters by one or several colors', () => {
    const yellow = searchPages(PAGES, { ...none, colors: ['yellow'] });
    expect(yellow.flatMap((result) => result.items.map((item) => item.id))).toEqual(['h-early', 'n-first', 'b1']);
    const pinkOrBlue = searchPages(PAGES, { ...none, colors: ['pink', 'blue'] });
    expect(pinkOrBlue.flatMap((result) => result.items.map((item) => item.id))).toEqual([
      'h-orphan',
      'n-second',
      'l1',
      'o1',
    ]);
  });

  it('filters by site', () => {
    expect(searchPages(PAGES, { ...none, site: 'example.com' }).map((result) => result.page.url)).toEqual([
      article.url,
    ]);
    expect(searchPages(PAGES, { ...none, site: LOCAL_FILES_SITE }).map((result) => result.page.url)).toEqual([
      local.url,
    ]);
  });

  it('combines query, color and site', () => {
    const results = searchPages(PAGES, { query: 'part', colors: ['green'], site: 'example.com' });
    expect(results.flatMap((result) => result.items.map((item) => item.id))).toEqual(['h-late']);
    expect(searchPages(PAGES, { query: 'part', colors: ['blue'], site: 'example.com' })).toEqual([]);
  });
});

describe('markMatches', () => {
  it('returns the text untouched without a query', () => {
    expect(markMatches('Hello', '')).toEqual([{ text: 'Hello', match: false }]);
  });

  it('marks every occurrence of every term', () => {
    expect(markMatches('One margin, two margins', 'margin')).toEqual([
      { text: 'One ', match: false },
      { text: 'margin', match: true },
      { text: ', two ', match: false },
      { text: 'margin', match: true },
      { text: 's', match: false },
    ]);
  });

  it('maps accent-free matches back onto the accented original', () => {
    expect(markMatches('Un résumé corto', 'RESUME')).toEqual([
      { text: 'Un ', match: false },
      { text: 'résumé', match: true },
      { text: ' corto', match: false },
    ]);
  });

  it('keeps astral characters intact', () => {
    const parts = markMatches('note 📝 here', 'here');
    expect(parts.map((part) => part.text).join('')).toBe('note 📝 here');
    expect(parts.at(-1)).toEqual({ text: 'here', match: true });
  });
});
