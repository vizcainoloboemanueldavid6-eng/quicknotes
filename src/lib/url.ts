/**
 * URL normalization. Notes are stored under the normalized URL of the page, so
 * this function decides which addresses count as "the same page". It must be
 * deterministic and idempotent: normalizeUrl(normalizeUrl(x)) === normalizeUrl(x).
 *
 * Rules, applied to http:, https: and file: URLs:
 *  1. The fragment (#...) is dropped.
 *  2. Credentials (user:pass@) are dropped — they must never be stored.
 *  3. Scheme and host are lower-cased (by the URL parser) and a trailing dot on
 *     the host is removed; default ports (:80 for http, :443 for https) are dropped.
 *  4. Tracking parameters are removed: every `utm_*` parameter plus the list in
 *     TRACKING_PARAMS, matched case-insensitively.
 *  5. The remaining query parameters are sorted by name (stable, so repeated
 *     names keep their relative order) and re-serialized; an empty query is dropped.
 *  6. Trailing slashes are removed from the path, except for the root path "/".
 *
 * Other schemes are returned with only the fragment removed. Strings that are not
 * URLs at all are returned trimmed.
 */

const TRACKING_PARAMS = new Set(
  [
    'fbclid',
    'gclid',
    'gclsrc',
    'dclid',
    'gbraid',
    'wbraid',
    'msclkid',
    'yclid',
    'twclid',
    'ttclid',
    'li_fat_id',
    'igshid',
    'igsh',
    'mc_cid',
    'mc_eid',
    '_ga',
    '_gl',
    '_hsenc',
    '_hsmi',
    '__hssc',
    '__hstc',
    '__hsfp',
    'hsctatracking',
    'mkt_tok',
    'oly_anon_id',
    'oly_enc_id',
    'vero_id',
    'vero_conv',
    'rb_clickid',
    's_cid',
    'srsltid',
    'epik',
    'ref_src',
    'wickedid',
    'irclickid',
    '_kx',
  ].map((name) => name.toLowerCase()),
);

const TRACKING_PREFIXES = ['utm_'];

export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** The optional host permission requested for "Restore my notes automatically on every site". */
export const HOST_PERMISSION_ORIGINS: readonly string[] = Object.freeze(['http://*/*', 'https://*/*']);

const NORMALIZED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

export function normalizeUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  url.hash = '';
  if (!NORMALIZED_PROTOCOLS.has(url.protocol)) {
    return url.href;
  }

  url.username = '';
  url.password = '';
  if (url.hostname.endsWith('.')) {
    url.hostname = url.hostname.replace(/\.+$/, '');
  }

  const kept: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    if (!isTrackingParam(name)) kept.push([name, value]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const search = new URLSearchParams(kept).toString();

  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) {
    path = path.replace(/\/+$/, '') || '/';
  }

  return `${url.protocol}//${url.host}${path}${search ? `?${search}` : ''}`;
}

/** Lower-case hostname of a URL without a trailing dot, or '' when there is none. */
export function hostOf(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** The key a site is paused under: the hostname without a leading `www.`. */
export function siteOf(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^www\./, '');
}

const SITE_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Turns whatever a user typed in the paused-sites list ("https://www.Example.com/x",
 * "example.com", "news.example.com") into a site key, or null when it is not a host.
 */
export function parseSiteEntry(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const host = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? hostOf(trimmed) : hostOf(`https://${trimmed}`);
  if (!host) return null;
  const site = siteOf(host);
  return SITE_PATTERN.test(site) ? site : null;
}

/**
 * A URL is paused when its host equals a paused site or is a subdomain of one.
 * `www.` is ignored on both sides.
 */
export function isPausedUrl(input: string, pausedSites: readonly string[]): boolean {
  const host = hostOf(input);
  if (!host) return false;
  const site = siteOf(host);
  return pausedSites.some((entry) => site === entry || site.endsWith(`.${entry}`));
}

/** Pages QuickNotes can inject into (the browser still refuses some, e.g. its own store). */
export function isSupportedUrl(input: string | undefined): boolean {
  if (!input) return false;
  try {
    const { protocol } = new URL(input);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

/** Match patterns covering a paused site and all of its subdomains (for excludeMatches). */
export function matchPatternsForSite(site: string): string[] {
  if (!SITE_PATTERN.test(site)) return [];
  return [`*://${site}/*`, `*://*.${site}/*`];
}
