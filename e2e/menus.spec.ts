/**
 * The "Highlight with QuickNotes" context-menu path, the menu of an existing
 * highlight, and anchoring when the page text changes between visits.
 *
 * Playwright cannot open Chrome's native context menu, so the menu item's
 * handler is exercised through the same background message it uses
 * (qn:bg:highlight-selection, with Chrome's selectionText as fallback).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PASSAGES, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts' });

const ARTICLE = fileURLToPath(new URL('../demo/article.html', import.meta.url));

test('context-menu highlighting, the highlight menu, and a page that changed', async ({ harness }) => {
  const page = await harness.openDemo();
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popup.close();
  const manager = await harness.extensionPage('src/options/index.html');
  const tabId = await manager.evaluate(
    async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0]?.id ?? -1,
    harness.demoUrl,
  );
  const menuClick = (text?: string, color?: string) =>
    manager.evaluate((message) => chrome.runtime.sendMessage(message), {
      type: 'qn:bg:highlight-selection',
      tabId,
      ...(text ? { text } : {}),
      ...(color ? { color } : {}),
    });
  await page.bringToFront();

  // --- Context menu: the live selection… -----------------------------------
  await selectText(page, PASSAGES.yellow.selector, PASSAGES.yellow.text);
  expect(await menuClick(undefined, 'yellow')).toEqual({ ok: true });
  await expect(page.locator('quicknotes-mark[data-qn-color="yellow"]')).toHaveText([PASSAGES.yellow.text]);
  // …or Chrome's selectionText when the selection is gone, if it is unique…
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  expect(await menuClick(PASSAGES.pink.text, 'pink')).toEqual({ ok: true });
  await expect(page.locator('quicknotes-mark[data-qn-color="pink"]')).toHaveText([PASSAGES.pink.text]);
  // …but never a guess between repeated passages.
  expect(await menuClick('one idea per note')).toEqual({ ok: false, error: 'no-selection' });
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

  expect(await harness.allErrors()).toEqual([]);
});
