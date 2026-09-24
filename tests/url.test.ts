import { describe, expect, it } from 'vitest';
import {
  canPauseUrl,
  hostOf,
  isPausedUrl,
  pausedEntryFor,
  isSupportedUrl,
  isTrackingParam,
  matchPatternsForSite,
  normalizeUrl,
  parseSiteEntry,
  siteOf,
} from '../src/lib/url';

describe('normalizeUrl', () => {
  it.each([
    ['drops the fragment', 'https://example.com/article#section-2', 'https://example.com/article'],
    ['drops an empty fragment', 'https://example.com/article#', 'https://example.com/article'],
    ['lower-cases scheme and host', 'HTTPS://Example.COM/Path', 'https://example.com/Path'],
    ['keeps path case', 'https://example.com/Docs/ReadMe', 'https://example.com/Docs/ReadMe'],
    ['drops the default https port', 'https://example.com:443/a', 'https://example.com/a'],
    ['drops the default http port', 'http://example.com:80/a', 'http://example.com/a'],
    ['keeps a non-default port', 'http://localhost:4320/demo/', 'http://localhost:4320/demo'],
    ['removes a trailing slash', 'https://example.com/docs/', 'https://example.com/docs'],
    ['removes repeated trailing slashes', 'https://example.com/docs///', 'https://example.com/docs'],
    ['keeps the root slash', 'https://example.com', 'https://example.com/'],
    ['keeps the root slash when given', 'https://example.com/', 'https://example.com/'],
    [
      'strips utm_* parameters',
      'https://example.com/a?utm_source=x&utm_medium=y&utm_campaign=z',
      'https://example.com/a',
    ],
    ['strips utm_* case-insensitively', 'https://example.com/a?UTM_Source=x&id=3', 'https://example.com/a?id=3'],
    ['strips fbclid and gclid', 'https://example.com/a?fbclid=abc&gclid=def&page=2', 'https://example.com/a?page=2'],
    ['strips msclkid, mc_eid, _ga', 'https://example.com/a?msclkid=1&mc_eid=2&_ga=3', 'https://example.com/a'],
    ['sorts the remaining parameters', 'https://example.com/s?q=notes&a=1', 'https://example.com/s?a=1&q=notes'],
    [
      'keeps the order of repeated names',
      'https://example.com/s?tag=b&x=1&tag=a',
      'https://example.com/s?tag=b&tag=a&x=1',
    ],
    ['keeps meaningful "ref" parameters', 'https://example.com/tree?ref=main', 'https://example.com/tree?ref=main'],
    ['drops an empty query', 'https://example.com/a?', 'https://example.com/a'],
    ['drops credentials', 'https://user:secret@example.com/private', 'https://example.com/private'],
    ['drops a trailing dot on the host', 'https://example.com./a', 'https://example.com/a'],
    ['trims whitespace', '  https://example.com/a  ', 'https://example.com/a'],
    ['handles file URLs', 'file:///C:/demo/article.html#top', 'file:///C:/demo/article.html'],
    ['upper-cases percent-escapes in the path', 'https://example.com/caf%c3%a9', 'https://example.com/caf%C3%A9'],
    ['encodes non-ASCII path characters', 'https://example.com/café', 'https://example.com/caf%C3%A9'],
    [
      'decodes escaped unreserved characters',
      'https://example.com/%7Euser/%41-b%2Ec',
      'https://example.com/~user/A-b.c',
    ],
    ['keeps escaped reserved characters', 'https://example.com/a%2fb%3Fc', 'https://example.com/a%2Fb%3Fc'],
    ['removes a trailing slash after decoding', 'https://example.com/docs%2F/', 'https://example.com/docs%2F'],
    [
      'only drops the hash of other schemes',
      'chrome-extension://abc/page.html?x=1#y',
      'chrome-extension://abc/page.html?x=1',
    ],
    ['returns non-URLs trimmed', '  not a url ', 'not a url'],
  ])('%s', (_label, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('treats tracking-only variants of a page as the same page', () => {
    const variants = [
      'https://Example.com/blog/post/',
      'https://example.com/blog/post#comments',
      'https://example.com:443/blog/post?utm_source=newsletter',
      'https://example.com/blog/post?fbclid=123&utm_campaign=x#top',
    ];
    const normalized = new Set(variants.map(normalizeUrl));
    expect([...normalized]).toEqual(['https://example.com/blog/post']);
  });

  it('keeps different pages apart', () => {
    expect(normalizeUrl('https://example.com/a?page=1')).not.toBe(normalizeUrl('https://example.com/a?page=2'));
    expect(normalizeUrl('http://example.com/a')).not.toBe(normalizeUrl('https://example.com/a'));
    expect(normalizeUrl('https://www.example.com/a')).not.toBe(normalizeUrl('https://example.com/a'));
  });

  it('is idempotent', () => {
    const inputs = [
      'https://Example.com:443/a/b/?utm_source=x&z=1&a=2#hash',
      'https://example.com/search?q=a+b&q=c%20d&lang=es',
      'https://example.com/path%20with%20spaces/?x=%E2%9C%93',
      'https://example.com/%7e%2e%2Fa/caf%c3%a9/',
      'https://example.com/a/%2E%2E/b/./c',
      'http://localhost:4321/',
      'file:///home/user/demo/article.html',
    ];
    for (const input of inputs) {
      const once = normalizeUrl(input);
      expect(normalizeUrl(once)).toBe(once);
    }
  });

  it('is deterministic for equivalent query orders', () => {
    expect(normalizeUrl('https://example.com/?b=2&a=1&c=3')).toBe(normalizeUrl('https://example.com/?c=3&a=1&b=2'));
  });
});

describe('isTrackingParam', () => {
  it('recognizes tracking parameters and leaves others alone', () => {
    expect(isTrackingParam('utm_content')).toBe(true);
    expect(isTrackingParam('GCLID')).toBe(true);
    expect(isTrackingParam('igshid')).toBe(true);
    expect(isTrackingParam('id')).toBe(false);
    expect(isTrackingParam('ref')).toBe(false);
    expect(isTrackingParam('utm')).toBe(false);
  });
});

describe('sites and pausing', () => {
  it('extracts hosts and site keys', () => {
    expect(hostOf('https://News.Example.com./x')).toBe('news.example.com');
    expect(hostOf('nonsense')).toBe('');
    expect(siteOf('www.example.com')).toBe('example.com');
    expect(siteOf('news.example.com')).toBe('news.example.com');
  });

  it.each([
    ['example.com', 'example.com'],
    ['https://www.Example.com/some/path?q=1', 'example.com'],
    ['  news.example.com ', 'news.example.com'],
    ['localhost', 'localhost'],
    ['http://localhost:4320/demo', 'localhost'],
    ['', null],
    ['not a host!', null],
    ['exa mple.com', null],
  ])('parseSiteEntry(%j) → %j', (input, expected) => {
    expect(parseSiteEntry(input)).toBe(expected);
  });

  it('pauses a site and its subdomains, ignoring www', () => {
    const paused = ['example.com'];
    expect(isPausedUrl('https://example.com/a', paused)).toBe(true);
    expect(isPausedUrl('https://www.example.com/a', paused)).toBe(true);
    expect(isPausedUrl('https://news.example.com/a', paused)).toBe(true);
    expect(isPausedUrl('https://notexample.com/a', paused)).toBe(false);
    expect(isPausedUrl('https://example.org/a', paused)).toBe(false);
    expect(isPausedUrl('not a url', paused)).toBe(false);
  });

  it('pausing a subdomain does not pause its parent', () => {
    expect(isPausedUrl('https://example.com/', ['news.example.com'])).toBe(false);
    expect(isPausedUrl('https://news.example.com/', ['news.example.com'])).toBe(true);
  });

  it('names the entry that pauses a page, its own site first', () => {
    expect(pausedEntryFor('https://blog.example.com/post', ['example.com'])).toBe('example.com');
    expect(pausedEntryFor('https://blog.example.com/post', ['example.com', 'blog.example.com'])).toBe(
      'blog.example.com',
    );
    expect(pausedEntryFor('https://www.example.com/', ['example.com'])).toBe('example.com');
    expect(pausedEntryFor('https://example.org/', ['example.com'])).toBeNull();
    expect(pausedEntryFor('file:///C:/demo/article.html', ['example.com'])).toBeNull();
  });

  it('only pages with a host name can be paused (not file:// pages)', () => {
    expect(canPauseUrl('https://example.com/a')).toBe(true);
    expect(canPauseUrl('http://127.0.0.1:4323/article.html')).toBe(true);
    expect(canPauseUrl('file:///C:/demo/article.html')).toBe(false);
    expect(canPauseUrl('about:blank')).toBe(false);
  });

  it('builds excludeMatches patterns for a paused site', () => {
    expect(matchPatternsForSite('example.com')).toEqual(['*://example.com/*', '*://*.example.com/*']);
    expect(matchPatternsForSite('127.0.0.1')).toEqual(['*://127.0.0.1/*']);
    expect(matchPatternsForSite('bad site')).toEqual([]);
  });

  it('knows which pages it can run on', () => {
    expect(isSupportedUrl('https://example.com')).toBe(true);
    expect(isSupportedUrl('http://localhost:4320/demo/article.html')).toBe(true);
    expect(isSupportedUrl('file:///C:/demo/article.html')).toBe(true);
    expect(isSupportedUrl('chrome://extensions')).toBe(false);
    expect(isSupportedUrl('about:blank')).toBe(false);
    expect(isSupportedUrl(undefined)).toBe(false);
    expect(isSupportedUrl('garbage')).toBe(false);
  });
});
