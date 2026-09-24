/** "Pause on this site" from the popup turns QuickNotes off on the demo's site. */
import { PASSAGES, registeredScripts, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts' });

test('"Pause on this site" disables the toolbar and the restore, and resuming brings them back', async ({
  harness,
}) => {
  // Automatic restore on, so that a reload would normally bring the notes back.
  const options = await harness.extensionPage('src/options/index.html');
  await options.getByRole('checkbox', { name: /Restore my notes automatically/ }).check();
  const worker = await harness.worker();
  await expect.poll(async () => (await registeredScripts(worker)).length).toBe(1);
  await options.close();

  const page = await harness.openDemo();
  await waitForQuickNotes(page);
  await selectText(page, PASSAGES.pink.selector, PASSAGES.pink.text);
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('[data-qn="note"]')).toBeVisible();
  await page.keyboard.type('Paused sites keep their notes.');
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.html ?? '').toContain('Paused sites');
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0]?.id ?? -1,
    harness.demoUrl,
  );

  // Pause from the popup.
  let popup = await harness.openPopup(page);
  await popup.waitFor('document.querySelector("[data-testid=count-notes]")?.textContent === "1"');
  await popup.click('input[role="switch"]');
  await expect
    .poll(() =>
      worker.evaluate(
        async () => ((await chrome.storage.sync.get('settings')).settings as { pausedSites?: string[] }).pausedSites,
      ),
    )
    .toEqual(['127.0.0.1']);
  await expect(page.locator('quicknotes-mark')).toHaveCount(0);
  await expect(page.locator('[data-qn="note"]')).toHaveCount(0);
  await popup.waitFor('document.querySelector("button.qn-btn-primary")?.disabled === true');
  expect(await popup.text('main')).toEqual([expect.stringContaining('No toolbar, highlights or notes on 127.0.0.1')]);
  await expect.poll(() => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('off');
  await popup.close();

  // No toolbar on selection.
  await selectText(page, PASSAGES.yellow.selector, PASSAGES.yellow.text);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-qn="toolbar"]')).toHaveCount(0);

  // No restore after a reload: the site is excluded from the registered script…
  const [script] = await registeredScripts(worker);
  expect(script?.excludeMatches).toEqual(['*://127.0.0.1/*']);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('quicknotes-root')).toHaveCount(0);
  // …and opening the popup does not inject it either.
  popup = await harness.openPopup(page);
  await popup.waitFor('document.querySelector("input[role=switch]")?.checked === true');
  await page.waitForTimeout(500);
  await expect(page.locator('quicknotes-root')).toHaveCount(0);
  expect((await harness.demoRecord())?.notes).toHaveLength(1);

  // Resume: the note and the highlight come back.
  await popup.click('input[role="switch"]');
  await waitForQuickNotes(page);
  await expect(page.locator('[data-qn="note"]')).toBeVisible();
  await expect(page.locator('quicknotes-mark[data-qn-color="yellow"]')).toHaveText([PASSAGES.pink.text]);
  await expect.poll(() => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('');
  await expect.poll(async () => (await registeredScripts(worker))[0]?.excludeMatches).toBeUndefined();
  await popup.close();
  await selectText(page, PASSAGES.yellow.selector, PASSAGES.yellow.text);
  await expect(page.locator('[data-qn="toolbar"]')).toBeVisible();

  expect(await harness.allErrors()).toEqual([]);
});
