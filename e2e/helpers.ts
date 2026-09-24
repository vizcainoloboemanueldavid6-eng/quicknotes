/** Page-level helpers shared by the end-to-end specs. */
import type { Page, Worker } from '@playwright/test';
import type { CdpTarget } from './harness';

export const COLOR_NAMES = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink' } as const;
export type ColorKey = keyof typeof COLOR_NAMES;

/** Passages of demo/article.html used by the tests (each occurs once). */
export const PASSAGES = {
  yellow: { selector: '#intro', text: 'Readers who keep a pencil in hand tend to remember more' },
  green: { selector: '#forgetting-1', text: 'memories drop steeply in the first day' },
  blue: { selector: '#margin-1', text: 'The margin is the only part of a page that belongs to the reader' },
  pink: { selector: '#margin-2', text: 'Deciding is the useful part' },
} as const;

/**
 * Selects `phrase` inside `selector` with a real mouse drag, from the left
 * half of its first character to the right half of its last one, and returns
 * the text the browser selected.
 */
export async function selectText(page: Page, selector: string, phrase: string): Promise<string> {
  // Pressing inside an existing selection would drag the selected text instead.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const points = await page.evaluate(
    ({ selector, phrase }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error(`No element ${selector}`);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number }> = [];
      let text = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node: node as Text, start: text.length });
        text += (node as Text).data;
      }
      const index = text.indexOf(phrase);
      if (index === -1) throw new Error(`"${phrase}" not found in ${selector}`);
      const charRect = (offset: number) => {
        const entry = [...nodes].reverse().find((candidate) => candidate.start <= offset);
        if (!entry) throw new Error('offset out of range');
        const range = document.createRange();
        range.setStart(entry.node, offset - entry.start);
        range.setEnd(entry.node, offset - entry.start + 1);
        return range.getBoundingClientRect();
      };
      (root as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' });
      const first = charRect(index);
      const last = charRect(index + phrase.length - 1);
      return {
        start: { x: first.left + Math.min(2, first.width / 3), y: first.top + first.height / 2 },
        end: { x: last.right - Math.min(2, last.width / 3), y: last.top + last.height / 2 },
      };
    },
    { selector, phrase },
  );
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 10 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/** Document-relative boxes of every highlight mark, keyed by highlight id (first mark of each). */
export function markBoxes(page: Page): Promise<Record<string, { x: number; y: number; text: string; color: string }>> {
  return page.evaluate(() => {
    const boxes: Record<string, { x: number; y: number; text: string; color: string }> = {};
    for (const mark of document.querySelectorAll('quicknotes-mark')) {
      const id = mark.getAttribute('data-qn-id') ?? '';
      const rect = mark.getBoundingClientRect();
      if (boxes[id]) {
        boxes[id].text += mark.textContent ?? '';
        continue;
      }
      boxes[id] = {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        text: mark.textContent ?? '',
        color: mark.getAttribute('data-qn-color') ?? '',
      };
    }
    return boxes;
  });
}

/** Document-relative box of a sticky note (inside the shadow root). */
export function noteBox(page: Page, id?: string): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate((id) => {
    const root = document.querySelector('quicknotes-root')?.shadowRoot;
    const note = root?.querySelector(id ? `[data-qn-note-id="${id}"]` : '[data-qn="note"]');
    if (!note) throw new Error('No note on the page');
    const rect = note.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, id);
}

/** Number of registered (automatic restore) content scripts, read in the service worker. */
export function registeredScripts(worker: Worker): Promise<chrome.scripting.RegisteredContentScript[]> {
  return worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
}

/**
 * Resolves once the popup has the page's status: its controls stay disabled
 * until then (the pause switch is enabled last).
 */
export async function popupReady(popup: CdpTarget): Promise<void> {
  await popup.waitFor(
    '(() => { const s = document.querySelector("input[role=switch]"); return s !== null && !s.disabled; })()',
    15_000,
  );
}

/** Resolves once the content script's UI host exists on the page. */
export async function waitForQuickNotes(page: Page): Promise<void> {
  await page.locator('quicknotes-root').waitFor({ state: 'attached', timeout: 15_000 });
}
