/**
 * The "Highlight with QuickNotes" context-menu item and the Alt+N command, the
 * menu of an existing highlight, and anchoring when the page text changes
 * between visits.
 *
 * Playwright cannot open Chrome's native context menu or press a browser-level
 * shortcut, so the service worker fires the extension's real listeners itself
 * with the events' `dispatch()` — the same code path as a user's click, with
 * the arguments Chrome passes (OnClickData and the tab).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PASSAGES, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts' });

const ARTICLE = fileURLToPath(new URL('../demo/article.html', import.meta.url));

interface DispatchableEvent {
  dispatch(...args: unknown[]): void;
}

test('context-menu highlighting, the highlight menu, and a page that changed', async ({ harness }) => {
  const page = await harness.openDemo();
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popup.close();
  // The worker is looked up for each call: Chrome may stop and restart it between them.
  const worker = () => harness.worker();

  /** Fires the context menu's onClicked listener, as a click on "Highlight with QuickNotes" does. */
  const menuClick = async (selectionText?: string) =>
    (await worker()).evaluate(
      async ({ url, selectionText }) => {
        const [tab] = await chrome.tabs.query({ url: `${url}*` });
        if (!tab) throw new Error('demo tab not found');
        const info = {
          menuItemId: 'quicknotes-highlight',
          editable: false,
          pageUrl: tab.url,
          ...(selectionText ? { selectionText } : {}),
        };
        (chrome.contextMenus.onClicked as unknown as DispatchableEvent).dispatch(info, tab);
      },
      { url: harness.demoUrl, selectionText },
    );
  const setDefaultColor = async (color: string) =>
    (await worker())
      .evaluate(async (defaultColor) => {
        const { settings } = await chrome.storage.sync.get('settings');
        await chrome.storage.sync.set({ settings: { ...(settings as object), defaultColor } });
      }, color)
      .then(() => page.waitForTimeout(300)); // let the page's storage listener catch up
  await page.bringToFront();

  // --- Context menu: the live selection, in the default color… ------------------
  await selectText(page, PASSAGES.yellow.selector, PASSAGES.yellow.text);
  await menuClick(PASSAGES.yellow.text);
  await expect(page.locator('quicknotes-mark[data-qn-color="yellow"]')).toHaveText([PASSAGES.yellow.text]);
  // …or Chrome's selectionText when the selection is gone, if it is unique…
  await setDefaultColor('pink');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await menuClick(PASSAGES.pink.text);
  await expect(page.locator('quicknotes-mark[data-qn-color="pink"]')).toHaveText([PASSAGES.pink.text]);
  await setDefaultColor('yellow');
  // …but never a guess between repeated passages.
  await menuClick('one idea per note');
  await expect(page.locator('[data-qn="toast"]')).toContainText('Select some text on the page first.');
  await expect.poll(async () => (await harness.demoRecord())?.highlights.length).toBe(2);

  // --- The highlight menu ------------------------------------------------------
  await page.locator('quicknotes-mark[data-qn-color="yellow"]').first().click();
  const menu = page.locator('[data-qn="highlight-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Change color to Yellow' })).toHaveAttribute('aria-pressed', 'true');
  await menu.getByRole('button', { name: 'Change color to Blue' }).click();
  await expect(page.locator('quicknotes-mark[data-qn-color="blue"]')).toHaveText([PASSAGES.yellow.text]);
  const record = await harness.demoRecord();
  const recolored = record?.highlights.find((highlight) => highlight.anchor.quote.exact === PASSAGES.yellow.text);
  expect(recolored?.color).toBe('blue');

  await menu.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('[data-qn="note"]')).toBeVisible();
  await page.keyboard.type('Attached to the blue passage.');
  await page.keyboard.press('Escape');
  await page.locator('quicknotes-mark[data-qn-color="blue"]').first().click();
  await expect(menu.getByRole('button', { name: 'Show note' })).toBeVisible();
  await menu.getByRole('button', { name: 'Delete highlight' }).click();
  await expect(page.locator('quicknotes-mark[data-qn-color="blue"]')).toHaveCount(0);
  // The note stays, as a standalone note.
  await expect(page.locator('[data-qn="note"]')).toBeVisible();
  await expect
    .poll(async () => {
      const current = await harness.demoRecord();
      return { highlights: current?.highlights.length, linked: current?.notes[0]?.highlightId ?? null };
    })
    .toEqual({ highlights: 1, linked: null });

  // --- The page changes between visits -------------------------------------------
  await selectText(page, PASSAGES.green.selector, PASSAGES.green.text);
  await page.getByRole('button', { name: 'Highlight in Green' }).click();
  await expect.poll(async () => (await harness.demoRecord())?.highlights.length).toBe(2);

  // The green sentence is rewritten; the pink one only changes case.
  const original = await readFile(ARTICLE, 'utf8');
  const changed = original
    .replace('memories drop steeply in the first day', 'recall falls sharply at first')
    .replace('Deciding is the useful part', 'deciding is the useful part');
  expect(changed).not.toBe(original);
  await page.route(harness.demoUrl, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: changed }),
  );
  await page.reload();
  const again = await harness.openPopup(page);
  await waitForQuickNotes(page);
  // The rewritten passage is reported as orphaned; the case change still anchors.
  await expect(page.locator('[data-qn="toast"]')).toContainText('Highlights not found on this page: 1');
  await expect(page.locator('quicknotes-mark[data-qn-color="pink"]')).toHaveText(['deciding is the useful part']);
  await expect(page.locator('quicknotes-mark[data-qn-color="green"]')).toHaveCount(0);
  await expect
    .poll(async () => (await harness.demoRecord())?.highlights.filter((highlight) => highlight.orphaned).length)
    .toBe(1);
  await again.waitFor('document.body.textContent.includes("1 not found on the page")');
  await again.close();

  // Back to the original text: found again, and no longer flagged.
  await page.unroute(harness.demoUrl);
  await page.reload();
  const last = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await expect(page.locator('quicknotes-mark[data-qn-color="green"]')).toHaveText([PASSAGES.green.text]);
  await expect
    .poll(async () => (await harness.demoRecord())?.highlights.filter((highlight) => highlight.orphaned).length)
    .toBe(0);
  await last.close();

  // --- The Alt+N command: a new note on the active page ----------------------------
  const notesBefore = (await harness.demoRecord())?.notes.length ?? 0;
  await page.bringToFront();
  await (
    await worker()
  ).evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}*` });
    (chrome.commands.onCommand as unknown as DispatchableEvent).dispatch('new-note', tab);
  }, harness.demoUrl);
  await expect(page.locator('[data-qn="note"]')).toHaveCount(notesBefore + 1);
  await expect.poll(async () => (await harness.demoRecord())?.notes.length).toBe(notesBefore + 1);

  expect(await harness.allErrors()).toEqual([]);
});
