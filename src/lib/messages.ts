/**
 * Message protocol between the extension's contexts.
 *
 *  - ContentMessage: sent to a tab with chrome.tabs.sendMessage and handled by
 *    the content script (src/content/index.ts).
 *  - BackgroundMessage: sent with chrome.runtime.sendMessage from the popup,
 *    side panel, options page or content script and handled by the service
 *    worker (src/background/index.ts), which injects the content script first
 *    when needed.
 *
 * Every handler answers with a Reply.
 */
import type { Color } from './types';

export type ContentMessage =
  | { type: 'qn:ping' }
  | { type: 'qn:get-status' }
  | { type: 'qn:new-note' }
  | { type: 'qn:highlight-selection'; color?: Color }
  | { type: 'qn:scroll-to'; id: string };

export type BackgroundMessage =
  | { type: 'qn:bg:inject'; tabId: number }
  | { type: 'qn:bg:get-status'; tabId: number }
  | { type: 'qn:bg:new-note'; tabId: number }
  | { type: 'qn:bg:highlight-selection'; tabId: number; color?: Color }
  | { type: 'qn:bg:scroll-to'; tabId: number; id: string }
  | { type: 'qn:bg:open-side-panel'; windowId?: number; tabId?: number }
  | { type: 'qn:bg:sync-auto-restore' };

/** Why an action did not happen. */
export type ErrorCode =
  | 'paused'
  | 'unsupported-page'
  | 'no-selection'
  | 'cannot-highlight'
  | 'not-found'
  | 'inject-failed'
  | 'no-tab'
  | 'unknown-message'
  | 'failed';

export type Reply<T = undefined> = { ok: true; data: T } | { ok: false; error: ErrorCode; detail?: string };

/** Snapshot of the content script's view of its page (for the popup and side panel). */
export interface PageStatus {
  url: string;
  title: string;
  paused: boolean;
  highlights: number;
  notes: number;
  /** Ids of highlights that could not be anchored on the page. */
  orphans: string[];
}

export function ok<T>(data: T): Reply<T> {
  return { ok: true, data };
}

export function fail(error: ErrorCode, detail?: string): { ok: false; error: ErrorCode; detail?: string } {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

const CONTENT_TYPES = new Set<string>([
  'qn:ping',
  'qn:get-status',
  'qn:new-note',
  'qn:highlight-selection',
  'qn:scroll-to',
]);

const BACKGROUND_TYPES = new Set<string>([
  'qn:bg:inject',
  'qn:bg:get-status',
  'qn:bg:new-note',
  'qn:bg:highlight-selection',
  'qn:bg:scroll-to',
  'qn:bg:open-side-panel',
  'qn:bg:sync-auto-restore',
]);

function hasType(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function isContentMessage(value: unknown): value is ContentMessage {
  return hasType(value) && CONTENT_TYPES.has(value.type);
}

export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  return hasType(value) && BACKGROUND_TYPES.has(value.type);
}

/** Typed wrapper around chrome.runtime.sendMessage for extension pages. */
export async function sendToBackground<T = undefined>(message: BackgroundMessage): Promise<Reply<T>> {
  try {
    const reply = await chrome.runtime.sendMessage<BackgroundMessage, Reply<T> | undefined>(message);
    return reply ?? fail('failed', 'no reply');
  } catch (error) {
    return fail('failed', error instanceof Error ? error.message : String(error));
  }
}
