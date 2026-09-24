/**
 * Export (Markdown and JSON) and JSON import with schema validation.
 *
 * The export text is data rather than UI, so its few labels are fixed English
 * words: an exported file reads the same whichever language the browser uses.
 */
import { mergePages } from './merge';
import { escapeMarkdown, htmlToMarkdown } from './richtext';
import { sanitizeHtml } from './sanitize';
import {
  COLORS,
  NOTE_MAX_SIZE,
  NOTE_MIN_SIZE,
  isColor,
  type Anchor,
  type Color,
  type Highlight,
  type PageData,
  type StickyNote,
  type XPathPoint,
} from './types';
import { isSupportedUrl, normalizeUrl } from './url';

export const EXPORT_FORMAT = 'quicknotes';
export const EXPORT_VERSION = 1;

const COLOR_LABEL: Readonly<Record<Color, string>> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local calendar date as YYYY-MM-DD. */
export function formatDate(timestamp: number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function quoteBlock(text: string): string {
  return escapeMarkdown(collapse(text))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function pageHeading(page: PageData): string {
  return escapeMarkdown(collapse(page.title) || page.url);
}

/**
 * One page as Markdown. `level` is the heading level of the page title, so the
 * same function renders a standalone file (level 1) or a section of the
 * all-pages export (level 2).
 */
export function pageToMarkdown(page: PageData, level = 1): string {
  const h = (depth: number) => '#'.repeat(Math.min(6, level + depth));
  const out: string[] = [`${h(0)} ${pageHeading(page)}`, `<${page.url}>`];

  const highlights = [...page.highlights].sort((a, b) => a.anchor.position.start - b.anchor.position.start);
  const notes = [...page.notes].sort((a, b) => a.createdAt - b.createdAt);
  const quoteById = new Map(highlights.map((hl) => [hl.id, hl.anchor.quote.exact]));

  if (highlights.length > 0) {
    out.push(`${h(1)} Highlights (${highlights.length})`);
    for (const highlight of highlights) {
      const meta = [`${COLOR_LABEL[highlight.color]} highlight`, formatDate(highlight.createdAt)];
      if (highlight.orphaned) meta.push('not found on the page when last checked');
      out.push(quoteBlock(highlight.anchor.quote.exact), `*${meta.join(' · ')}*`);
    }
  }

  if (notes.length > 0) {
    out.push(`${h(1)} Notes (${notes.length})`);
    notes.forEach((note, index) => {
      out.push(`${h(2)} Note ${index + 1} · ${COLOR_LABEL[note.color]} · ${formatDate(note.createdAt)}`);
      const quote = note.highlightId ? quoteById.get(note.highlightId) : undefined;
      if (quote) out.push(`> On: “${escapeMarkdown(truncate(collapse(quote), 120))}”`);
      out.push(htmlToMarkdown(note.html) || '*(empty note)*');
    });
  }

  if (highlights.length === 0 && notes.length === 0) out.push('*No highlights or notes.*');
  return `${out.join('\n\n')}\n`;
}

/** Every page in one document, most recently updated first. */
export function pagesToMarkdown(pages: readonly PageData[], now: Date = new Date()): string {
  const sorted = [...pages].sort((a, b) => b.updatedAt - a.updatedAt);
  const highlightCount = sorted.reduce((sum, page) => sum + page.highlights.length, 0);
  const noteCount = sorted.reduce((sum, page) => sum + page.notes.length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const header = [
    '# QuickNotes export',
    `Exported ${formatDate(now)} · ${plural(sorted.length, 'page')} · ${plural(highlightCount, 'highlight')} · ${plural(noteCount, 'note')}`,
  ].join('\n\n');
  if (sorted.length === 0) return `${header}\n`;
  return `${header}\n\n---\n\n${sorted.map((page) => pageToMarkdown(page, 2).trimEnd()).join('\n\n---\n\n')}\n`;
}

/** A file-system friendly name such as `quicknotes-example-com-article-2026-09-24.md`. */
export function exportFileName(extension: 'md' | 'json', page?: PageData, now: Date = new Date()): string {
  let slug = 'all';
  if (page) {
    let source = page.url;
    try {
      const url = new URL(page.url);
      source = `${url.hostname}${url.pathname}`;
    } catch {
      // keep the raw string
    }
    slug =
      source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '') || 'page';
  }
  return `quicknotes-${slug}-${formatDate(now)}.${extension}`;
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  pages: PageData[];
}

export function toJsonExport(pages: readonly PageData[], now: Date = new Date()): string {
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    pages: pages.map((page) => structuredClone(page)),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Import validation
// ---------------------------------------------------------------------------

export type ImportResult = { ok: true; pages: PageData[] } | { ok: false; errors: string[] };

const MAX_REPORTED_ERRORS = 20;
const MAX_ID = 128;
const MAX_QUOTE = 20_000;
const MAX_CONTEXT = 256;
const MAX_XPATH = 4_000;
const MAX_TITLE = 1_000;
const MAX_HTML_INPUT = 200_000;
const XPATH_RE = /^(\/[^/[\]]+\[[1-9]\d*\])+$/;

type Json = Record<string, unknown>;

class Collector {
  readonly errors: string[] = [];
  add(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function checkId(value: unknown, path: string, errors: Collector): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) {
    errors.add(path, `expected a non-empty string of at most ${MAX_ID} characters`);
    return false;
  }
  return true;
}

function checkColor(value: unknown, path: string, errors: Collector): value is Color {
  if (!isColor(value)) {
    errors.add(path, `expected one of ${COLORS.join(', ')}`);
    return false;
  }
  return true;
}

function checkTimestamps(value: Json, path: string, errors: Collector): boolean {
  let ok = true;
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (!isTimestamp(value[key])) {
      errors.add(`${path}.${key}`, 'expected a non-negative number (milliseconds since 1970)');
      ok = false;
    }
  }
  return ok;
}

function validatePoint(value: unknown, path: string, errors: Collector): XPathPoint | null {
  if (!isObject(value)) {
    errors.add(path, 'expected an object with xpath and offset');
    return null;
  }
  const { xpath, offset } = value;
  let ok = true;
  if (typeof xpath !== 'string' || xpath.length > MAX_XPATH || !XPATH_RE.test(xpath)) {
    errors.add(`${path}.xpath`, 'expected an element path such as /html[1]/body[1]/p[2]');
    ok = false;
  }
  if (!isNonNegativeInteger(offset)) {
    errors.add(`${path}.offset`, 'expected a non-negative integer');
    ok = false;
  }
  return ok ? { xpath: xpath as string, offset: offset as number } : null;
}

function validateAnchor(value: unknown, path: string, errors: Collector): Anchor | null {
  if (!isObject(value)) {
    errors.add(path, 'expected an object');
    return null;
  }
  const before = errors.errors.length;
  const quote = value.quote;
  if (!isObject(quote)) {
    errors.add(`${path}.quote`, 'expected an object with exact, prefix and suffix');
  } else {
    if (typeof quote.exact !== 'string' || quote.exact.trim() === '' || quote.exact.length > MAX_QUOTE) {
      errors.add(`${path}.quote.exact`, `expected non-empty text of at most ${MAX_QUOTE} characters`);
    }
    for (const key of ['prefix', 'suffix'] as const) {
      if (typeof quote[key] !== 'string' || quote[key].length > MAX_CONTEXT) {
        errors.add(`${path}.quote.${key}`, `expected text of at most ${MAX_CONTEXT} characters`);
      }
    }
  }
  const start = validatePoint(value.start, `${path}.start`, errors);
  const end = validatePoint(value.end, `${path}.end`, errors);
  const position = value.position;
  if (
    !isObject(position) ||
    !isNonNegativeInteger(position.start) ||
    !isNonNegativeInteger(position.end) ||
    position.end < position.start
  ) {
    errors.add(`${path}.position`, 'expected { start, end } with 0 <= start <= end');
  }
  if (errors.errors.length > before || !isObject(quote) || !start || !end || !isObject(position)) return null;
  return {
    quote: { exact: quote.exact as string, prefix: quote.prefix as string, suffix: quote.suffix as string },
    start,
    end,
    position: { start: position.start as number, end: position.end as number },
  };
}

function validateHighlight(value: unknown, path: string, errors: Collector): Highlight | null {
  if (!isObject(value)) {
    errors.add(path, 'expected an object');
    return null;
  }
  const before = errors.errors.length;
  checkId(value.id, `${path}.id`, errors);
  checkColor(value.color, `${path}.color`, errors);
  checkTimestamps(value, path, errors);
  if (value.orphaned !== undefined && typeof value.orphaned !== 'boolean') {
    errors.add(`${path}.orphaned`, 'expected true or false');
  }
  const anchor = validateAnchor(value.anchor, `${path}.anchor`, errors);
  if (errors.errors.length > before || !anchor) return null;
  const highlight: Highlight = {
    id: value.id as string,
    anchor,
    color: value.color as Color,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  };
  if (value.orphaned === true) highlight.orphaned = true;
  return highlight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validateNote(
  value: unknown,
  path: string,
  errors: Collector,
  sanitize: (html: string) => string,
): StickyNote | null {
  if (!isObject(value)) {
    errors.add(path, 'expected an object');
    return null;
  }
  const before = errors.errors.length;
  checkId(value.id, `${path}.id`, errors);
  checkColor(value.color, `${path}.color`, errors);
  checkTimestamps(value, path, errors);
  if (typeof value.html !== 'string' || value.html.length > MAX_HTML_INPUT) {
    errors.add(`${path}.html`, `expected HTML text of at most ${MAX_HTML_INPUT} characters`);
  }
  const { position, size } = value;
  if (
    !isObject(position) ||
    typeof position.x !== 'number' ||
    typeof position.y !== 'number' ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    errors.add(`${path}.position`, 'expected { x, y } as percentages');
  }
  if (
    !isObject(size) ||
    typeof size.width !== 'number' ||
    typeof size.height !== 'number' ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height)
  ) {
    errors.add(`${path}.size`, 'expected { width, height } in pixels');
  }
  if (typeof value.minimized !== 'boolean') errors.add(`${path}.minimized`, 'expected true or false');
  if (value.highlightId !== undefined) checkId(value.highlightId, `${path}.highlightId`, errors);
  if (errors.errors.length > before || !isObject(position) || !isObject(size)) return null;

  const note: StickyNote = {
    id: value.id as string,
    html: sanitize(value.html as string),
    color: value.color as Color,
    position: { x: clamp(position.x as number, 0, 100), y: clamp(position.y as number, 0, 100) },
    size: {
      width: clamp(size.width as number, NOTE_MIN_SIZE.width, NOTE_MAX_SIZE.width),
      height: clamp(size.height as number, NOTE_MIN_SIZE.height, NOTE_MAX_SIZE.height),
    },
    minimized: value.minimized as boolean,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  };
  if (typeof value.highlightId === 'string') note.highlightId = value.highlightId;
  return note;
}

function validatePage(
  value: unknown,
  path: string,
  errors: Collector,
  sanitize: (html: string) => string,
): PageData | null {
  if (!isObject(value)) {
    errors.add(path, 'expected an object');
    return null;
  }
  const before = errors.errors.length;
  let url = '';
  if (typeof value.url !== 'string' || !isSupportedUrl(value.url)) {
    errors.add(`${path}.url`, 'expected an http(s) or file URL');
  } else {
    url = normalizeUrl(value.url);
  }
  if (typeof value.title !== 'string') errors.add(`${path}.title`, 'expected text');
  if (!isTimestamp(value.updatedAt)) {
    errors.add(`${path}.updatedAt`, 'expected a non-negative number (milliseconds since 1970)');
  }

  const highlights: Highlight[] = [];
  if (!Array.isArray(value.highlights)) {
    errors.add(`${path}.highlights`, 'expected a list');
  } else {
    value.highlights.forEach((item, i) => {
      const highlight = validateHighlight(item, `${path}.highlights[${i}]`, errors);
      if (highlight) highlights.push(highlight);
    });
  }

  const notes: StickyNote[] = [];
  if (!Array.isArray(value.notes)) {
    errors.add(`${path}.notes`, 'expected a list');
  } else {
    value.notes.forEach((item, i) => {
      const note = validateNote(item, `${path}.notes[${i}]`, errors, sanitize);
      if (note) notes.push(note);
    });
  }

  const ids = new Set<string>();
  for (const item of [...highlights, ...notes]) {
    if (ids.has(item.id)) errors.add(path, `duplicate id "${item.id}"`);
    ids.add(item.id);
  }

  if (errors.errors.length > before) return null;
  return {
    url,
    title: (value.title as string).slice(0, MAX_TITLE),
    highlights,
    notes,
    updatedAt: value.updatedAt as number,
  };
}

/**
 * Parses and validates a QuickNotes JSON export. All-or-nothing: if any part is
 * invalid nothing is imported and every problem (up to 20) is reported with its
 * path, e.g. `pages[2].notes[0].color: expected one of yellow, green, blue, pink`.
 * Note HTML is re-sanitized and URLs re-normalized; pages whose URLs normalize
 * to the same address are merged.
 */
export function parseJsonImport(text: string, sanitize: (html: string) => string = sanitizeHtml): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['The file is not valid JSON.'] };
  }
  if (!isObject(data)) return { ok: false, errors: ['Expected a QuickNotes export object.'] };
  if (data.format !== EXPORT_FORMAT) return { ok: false, errors: ['This is not a QuickNotes export (format).'] };
  if (data.version !== EXPORT_VERSION) {
    return { ok: false, errors: [`Unsupported export version ${String(data.version)}; expected ${EXPORT_VERSION}.`] };
  }
  if (!Array.isArray(data.pages)) return { ok: false, errors: ['pages: expected a list'] };

  const errors = new Collector();
  const byUrl = new Map<string, PageData>();
  data.pages.forEach((item, i) => {
    const page = validatePage(item, `pages[${i}]`, errors, sanitize);
    if (!page) return;
    const existing = byUrl.get(page.url);
    byUrl.set(page.url, existing ? mergePages(existing, page) : page);
  });

  if (errors.errors.length > 0) {
    const shown = errors.errors.slice(0, MAX_REPORTED_ERRORS);
    const hidden = errors.errors.length - shown.length;
    return { ok: false, errors: hidden > 0 ? [...shown, `…and ${hidden} more`] : shown };
  }
  return { ok: true, pages: [...byUrl.values()] };
}
