/**
 * The default install: no host permissions, nothing registered. The content
 * script only runs after the user clicks the toolbar button (which grants
 * activeTab), and after a reload the page's notes come back on the next click.
 *
 * Clicking the toolbar button needs Extensions.triggerAction, which only recent
 * Chrome has, so this file always runs in the installed Chrome (whatever
 * QN_E2E_BROWSER says for the rest of the suite). It is skipped only when the
 * run is explicitly limited to Chromium (QN_E2E_BROWSER=chromium).
 */
import { PASSAGES, markBoxes, noteBox, popupReady, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'default', browserKind: 'chrome' });

test.skip(process.env.QN_E2E_BROWSER === 'chromium', 'This run is limited to Chromium, which cannot click the button.');

/** demo/article.html opened from disk (file://). */
const LOCAL_ARTICLE = new URL('../demo/article.html', import.meta.url).href;

test('the toolbar button injects on demand and restores the page after a reload', async ({ harness }) => {
  expect(harness.canTriggerAction()).toBe(true);

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
  await popupReady(popup);
  expect(await popup.text('[data-testid="count-notes"]')).toEqual(['0']);
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
  await popupReady(popup);
  expect(await popup.text('[data-testid="count-highlights"]')).toEqual(['1']);
  expect(await popup.text('[data-testid="count-notes"]')).toEqual(['1']);

  // "Open side panel" from the popup (a user gesture) opens the side panel.
  await popup.click('button', 'Open side panel');
  const panel = await harness.attach('/src/sidepanel/index.html');
  await panel.waitFor('document.querySelectorAll("[data-testid=item-highlight]").length === 1');
  expect(await panel.text('[data-testid="item-note"]')).toEqual([expect.stringContaining('Added from the popup.')]);

  expect(await harness.allErrors()).toEqual([]);
});

test('on a local file the popup explains file access and offers no pause switch', async ({ harness }) => {
  // Chrome's "Allow access to file URLs" is off for an extension installed from the
  // Web Store (an unpacked one starts with it on): say how to turn it on.
  await harness.setFileAccess(false);
  const page = await harness.context.newPage();
  await page.goto(LOCAL_ARTICLE);
  // Chrome then hides even the tab's URL from the extension (Chrome 153), or shows
  // it (older Chromium): the popup mentions the setting either way.
  let popup = await harness.clickAction(page);
  await popup.waitFor('document.querySelector("[data-testid=file-access], [data-testid=file-access-hint]") !== null');
  expect(await popup.evaluate(() => document.body.innerText)).toContain('"Allow access to file URLs"');
  expect(await popup.evaluate(() => document.querySelector('input[role=switch]') === null)).toBe(true);
  expect(
    await popup.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => b.textContent === 'New note' && !b.disabled),
    ),
  ).toBe(false);
  await popup.close();

  // With file access on, QuickNotes runs there; a file has no site to pause.
  await harness.setFileAccess(true);
  await page.reload();
  popup = await harness.clickAction(page);
  await waitForQuickNotes(page);
  await popup.waitFor('document.querySelector("[data-testid=local-file]") !== null');
  expect(await popup.text('[data-testid="site"]')).toEqual(['Local files']);
  expect(await popup.evaluate(() => document.querySelector('input[role=switch]') === null)).toBe(true);
  await popup.waitFor(
    '[...document.querySelectorAll("button")].some((b) => b.textContent === "New note" && !b.disabled)',
  );
  await popup.click('button', 'New note');
  await expect(page.locator('[data-qn="note"]')).toBeVisible();

  expect(await harness.allErrors()).toEqual([]);
});
