import type { Highlight, PageData, StickyNote } from '../src/lib/types';

/** 2026-09-24 12:00 UTC — noon, so the local date is the same in every time zone within ±11 h. */
export const NOON = Date.UTC(2026, 8, 24, 12, 0, 0);

export function makeHighlight(id: string, overrides: Partial<Highlight> = {}): Highlight {
  return {
    id,
    color: 'yellow',
    anchor: {
      quote: { exact: `quote ${id}`, prefix: 'before ', suffix: ' after' },
      start: { xpath: '/html[1]/body[1]/p[1]', offset: 7 },
      end: { xpath: '/html[1]/body[1]/p[1]', offset: 20 },
      position: { start: 7, end: 20 },
    },
    createdAt: NOON,
    updatedAt: NOON,
    ...overrides,
  };
}

export function makeNote(id: string, overrides: Partial<StickyNote> = {}): StickyNote {
  return {
    id,
    html: `<div>note ${id}</div>`,
    color: 'yellow',
    position: { x: 10, y: 20 },
    size: { width: 240, height: 200 },
    minimized: false,
    createdAt: NOON,
    updatedAt: NOON,
    ...overrides,
  };
}

export function makePage(url: string, overrides: Partial<PageData> = {}): PageData {
  return { url, title: 'A page', highlights: [], notes: [], updatedAt: NOON, ...overrides };
}
