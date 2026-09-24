/**
 * The default install: no host permissions, nothing registered. The content
 * script only runs after the user clicks the toolbar button (which grants
 * activeTab), and after a reload the page's notes come back on the next click.
 * Needs a browser that can click the toolbar button for us
 * (Extensions.triggerAction, recent Chrome).
 */
import { PASSAGES, markBoxes, noteBox, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'default' });

test('the toolbar button injects on demand and restores the page after a reload', async ({ harness }) => {
  test.skip(!harness.canTriggerAction(), 'This browser cannot click the toolbar button (Extensions.triggerAction).');

  const page = await harness.openDemo();
  // Nothing runs before the user acts: no host permission, nothing registered.
  const worker = await harness.worker();
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
  await selectText(page, PASSAGES.green.selector, PASSAGES.green.text);
  await page.waitForTimeout(500);
  await expect(page.locator('quicknotes-root')).toHaveCount(0);

  // Click the toolbar button: the popup opens and the script is injected.
  let popup = await harness.clickAction(page);
  await waitForQuickNotes(page);
  await popup.waitFor('document.querySelector("[data-testid=count-notes]")?.textContent === "0"');
  expect(await popup.text('[data-testid="count-highlights"]')).toEqual(['0']);

  // "New note" from the popup.
  await popup.click('button', 'New note');
  const note = page.locator('[data-qn="note"]');
  await expect(note).toBeVisible();
  await page.keyboard.type('Added from the popup.');
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.html ?? '').toContain('Added from the popup.');

  // A highlight from the selection toolbar.
  await selectText(page, PASSAGES.green.selector, PASSAGES.green.text);
  await page.getByRole('button', { name: 'Highlight in Green' }).click();
  await expect(page.locator('quicknotes-mark[data-qn-color="green"]').first()).toBeAttached();
  await expect.poll(async () => (await harness.demoRecord())?.highlights.length).toBe(1);
  const marks = await markBoxes(page);
  const box = await noteBox(page);

  // Reload: the grant ends with the navigation, so nothing is drawn yet…
  await page.reload();
  await page.waitForTimeout(1000);
  await expect(page.locator('quicknotes-root')).toHaveCount(0);

  // …until the button is clicked again.
  popup = await harness.clickAction(page);
  await waitForQuickNotes(page);
  await expect(page.locator('[data-qn="note"]')).toBeVisible();
  await expect.poll(() => markBoxes(page)).toEqual(marks);
  expect(await noteBox(page)).toEqual(box);
  await popup.waitFor('document.querySelector("[data-testid=count-highlights]")?.textContent === "1"');
  expect(await popup.text('[data-testid="count-notes"]')).toEqual(['1']);

  // "Open side panel" from the popup (a user gesture) opens the side panel.
  await popup.click('button', 'Open side panel');
  const panel = await harness.attach('/src/sidepanel/index.html');
  await panel.waitFor('document.querySelectorAll("[data-testid=item-highlight]").length === 1');
  expect(await panel.text('[data-testid="item-note"]')).toEqual([expect.stringContaining('Added from the popup.')]);

  expect(await harness.allErrors()).toEqual([]);
});
