/**
 * Shared data model. Everything QuickNotes stores is described here, and the
 * JSON import validator in `markdown.ts` checks incoming data against exactly
 * these shapes.
 */

export const COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type Color = (typeof COLORS)[number];

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The quoted text plus up to ~32 characters of context on each side. */
export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

/**
 * Fallback position: the element that contains a boundary point, as a simple
 * absolute XPath (`/html[1]/body[1]/article[1]/p[3]`), plus a character offset
 * into that element's rendered text. QuickNotes' own highlight elements are
 * transparent to both, so wrapping text never invalidates an anchor.
 */
export interface XPathPoint {
  xpath: string;
  offset: number;
}

export interface Anchor {
  quote: TextQuote;
  start: XPathPoint;
  end: XPathPoint;
  /** Character offsets into the page text when the anchor was created (tie-breaker only). */
  position: { start: number; end: number };
}

export interface Highlight {
  id: string;
  anchor: Anchor;
  color: Color;
  /** Set by the content script when the anchor could not be found on the page. */
  orphaned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NotePosition {
  /** Left edge as a percentage (0–100) of the document width. */
  x: number;
  /** Top edge as a percentage (0–100) of the document height. */
  y: number;
}

export interface NoteSize {
  width: number;
  height: number;
}

export interface StickyNote {
  id: string;
  /** Sanitized HTML (whitelist: b strong i em ul ol li br p div). */
  html: string;
  color: Color;
  position: NotePosition;
  size: NoteSize;
  minimized: boolean;
  /** The highlight this note was created from, if any. */
  highlightId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PageData {
  /** Normalized URL (see `url.ts`); also the storage key suffix. */
  url: string;
  title: string;
  highlights: Highlight[];
  notes: StickyNote[];
  updatedAt: number;
}

export interface Settings {
  defaultColor: Color;
  /** Show the floating toolbar when text is selected. */
  showToolbar: boolean;
  /** Paused sites, stored as hostnames without a leading `www.`. */
  pausedSites: string[];
  theme: Theme;
  /**
   * Opt-in: restore notes automatically on every site. Only effective while the
   * optional host permission is granted.
   */
  autoRestore: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  defaultColor: 'yellow',
  showToolbar: true,
  pausedSites: [],
  theme: 'system',
  autoRestore: false,
});

export const NOTE_DEFAULT_SIZE: Readonly<NoteSize> = Object.freeze({ width: 240, height: 200 });
export const NOTE_MIN_SIZE: Readonly<NoteSize> = Object.freeze({ width: 160, height: 110 });
export const NOTE_MAX_SIZE: Readonly<NoteSize> = Object.freeze({ width: 640, height: 800 });

export function isColor(value: unknown): value is Color {
  return typeof value === 'string' && (COLORS as readonly string[]).includes(value);
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
