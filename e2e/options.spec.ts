/** The options page, and the effect of each setting on the demo page. */
import { PASSAGES, registeredScripts, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts' });

test('default color, selection toolbar, shortcut, paused sites and theme', async ({ harness }) => {
  const options = await harness.extensionPage('src/options/index.html');
  const worker = await harness.worker();
  const settings = () =>
    worker.evaluate(async () => (await chrome.storage.sync.get('settings')).settings as Record<string, unknown>);

  // Shortcut: shows Alt+N and explains where to change it.
  await expect(options.getByTestId('shortcut')).toHaveText('Alt+N');
  await expect(options.getByText('chrome://extensions/shortcuts', { exact: false })).toBeVisible();
  const [shortcutsTab] = await Promise.all([
    harness.context.waitForEvent('page'),
    options.getByRole('button', { name: 'Change shortcuts' }).click(),
  ]);
  await expect.poll(() => shortcutsTab.url()).toBe('chrome://extensions/shortcuts');
  await shortcutsTab.close();

  // Default color.
  await options.getByRole('radio', { name: 'Green' }).check();
  await expect.poll(async () => (await settings())?.defaultColor).toBe('green');

  const page = await harness.openDemo();
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popup.close();
  await selectText(page, PASSAGES.yellow.selector, PASSAGES.yellow.text);
  const swatches = page.locator('[data-qn="toolbar"]').getByRole('button', { name: /^Highlight in / });
  await expect(swatches.first()).toHaveAttribute('aria-label', 'Highlight in Green');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('quicknotes-mark[data-qn-color="green"]')).toHaveText([PASSAGES.yellow.text]);
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.color).toBe('green');
  await page.keyboard.press('Escape');

  // Hiding the selection toolbar.
  await options.bringToFront();
  await options.getByRole('checkbox', { name: 'Show the toolbar when I select text' }).uncheck();
  await expect.poll(async () => (await settings())?.showToolbar).toBe(false);
  await page.bringToFront();
  await selectText(page, PASSAGES.green.selector, PASSAGES.green.text);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-qn="toolbar"]')).toHaveCount(0);
  await options.bringToFront();
  await options.getByRole('checkbox', { name: 'Show the toolbar when I select text' }).check();
  await expect.poll(async () => (await settings())?.showToolbar).toBe(true);
  await page.bringToFront();
  await selectText(page, PASSAGES.green.selector, PASSAGES.green.text);
  await expect(page.locator('[data-qn="toolbar"]')).toBeVisible();

  // Paused sites: add (a URL is reduced to its site), reject nonsense, remove.
  await options.bringToFront();
  const siteInput = options.getByRole('textbox', { name: 'Paused sites' });
  await siteInput.fill('https://www.example.org/some/article?x=1');
  await options.getByRole('button', { name: 'Add site' }).click();
  await expect(options.getByText('example.org', { exact: true })).toBeVisible();
  await expect.poll(async () => (await settings())?.pausedSites).toEqual(['example.org']);
  await siteInput.fill('not a site!');
  await options.getByRole('button', { name: 'Add site' }).click();
  await expect(options.getByText('Enter a site such as example.com.')).toBeVisible();
  await options.getByRole('button', { name: 'Remove example.org' }).click();
  await expect(options.getByText('No paused sites.')).toBeVisible();
  await expect.poll(async () => (await settings())?.pausedSites).toEqual([]);

  // Theme: applies to the options page and the side panel.
  const panel = await harness.extensionPage('src/sidepanel/index.html');
  await options.bringToFront();
  await options.getByRole('radio', { name: 'Dark' }).check();
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await options.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(31, 28, 25)');
  await options.getByRole('radio', { name: 'Light' }).check();
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'light');
  await options.getByRole('radio', { name: 'System' }).check();
  await expect.poll(async () => (await settings())?.theme).toBe('system');

  expect(await harness.allErrors()).toEqual([]);
});

test('automatic restore is opt-in, and revoking the permission turns it off', async ({ harness }) => {
  const options = await harness.extensionPage('src/options/index.html');
  const worker = await harness.worker();
  const checkbox = options.getByRole('checkbox', { name: /Restore my notes automatically/ });
  await expect(checkbox).not.toBeChecked();
  expect(await registeredScripts(worker)).toEqual([]);

  await checkbox.check();
  await expect.poll(async () => (await registeredScripts(worker)).length).toBe(1);
  const [script] = await registeredScripts(worker);
  expect(script).toMatchObject({
    id: 'quicknotes-auto-restore',
    js: ['src/content/index.js'],
    matches: ['http://*/*', 'https://*/*'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  });

  // A new page gets the script without any click.
  const page = await harness.openDemo();
  await waitForQuickNotes(page);

  // Revoking site access on chrome://extensions unregisters it and unticks the option.
  await harness.setSiteAccess('on-click');
  await expect.poll(async () => (await registeredScripts(worker)).length).toBe(0);
  await options.bringToFront();
  await expect(checkbox).not.toBeChecked();
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('quicknotes-root')).toHaveCount(0);

  // Granting it again does not silently opt back in…
  await harness.setSiteAccess('all');
  await options.waitForTimeout(500);
  expect(await registeredScripts(worker)).toEqual([]);
  await expect(checkbox).not.toBeChecked();
  // …the user does, and can turn it off again.
  await checkbox.check();
  await expect.poll(async () => (await registeredScripts(worker)).length).toBe(1);
  await checkbox.uncheck();
  await expect.poll(async () => (await registeredScripts(worker)).length).toBe(0);

  expect(await harness.allErrors()).toEqual([]);
});

test('"Delete all data" needs the typed confirmation', async ({ harness }) => {
  const page = await harness.openDemo();
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popup.close();
  await selectText(page, PASSAGES.blue.selector, PASSAGES.blue.text);
  await page.getByRole('button', { name: 'Highlight in Blue' }).click();
  await expect.poll(async () => (await harness.demoRecord())?.highlights.length).toBe(1);

  const options = await harness.extensionPage('src/options/index.html');
  await options.getByRole('radio', { name: 'Pink' }).check();
  const confirm = options.getByRole('textbox', { name: 'Delete all data' });
  const button = options.getByRole('button', { name: 'Delete everything' });
  await expect(button).toBeDisabled();
  await confirm.fill('delete');
  await expect(button).toBeDisabled();
  await confirm.fill('DELETE');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(options.getByRole('status')).toHaveText('All data deleted.');

  const worker = await harness.worker();
  expect(Object.keys(await harness.storage()).filter((key) => key.startsWith('page:'))).toEqual([]);
  expect(await worker.evaluate(() => chrome.storage.sync.get('settings'))).toMatchObject({
    settings: { autoRestore: false, defaultColor: 'yellow' },
  });
  await expect(options.getByRole('radio', { name: 'Yellow' })).toBeChecked();
  // The open page drops the deleted highlight.
  await expect(page.locator('quicknotes-mark')).toHaveCount(0);

  expect(await harness.allErrors()).toEqual([]);
});
