/** The shipped build loads cleanly, with exactly the permissions it declares. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './harness';

test.use({ variant: 'default' });

test('the build contains no network or remote-code APIs', async () => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const files = (await readdir(dist, { recursive: true })).filter((file) => /\.(js|html)$/.test(file));
  expect(files.length).toBeGreaterThan(5);
  const offenders: string[] = [];
  for (const file of files) {
    const code = await readFile(join(dist, file), 'utf8');
    const match =
      /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|\beval\(|new Function\(/.exec(code);
    if (match) offenders.push(`${file}: ${match[0]}`);
  }
  expect(offenders).toEqual([]);
});

test('loads without errors or warnings, asking only for the declared permissions', async ({ harness }) => {
  const worker = await harness.worker();
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest).toMatchObject({
    manifest_version: 3,
    name: 'QuickNotes: Highlights & Sticky Notes',
    version: '1.0.0',
    permissions: ['storage', 'activeTab', 'scripting', 'contextMenus', 'sidePanel'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    commands: { 'new-note': { suggested_key: { default: 'Alt+N' } } },
  });
  expect(manifest).not.toHaveProperty('content_scripts');
  expect(manifest).not.toHaveProperty('host_permissions');
  expect(manifest).not.toHaveProperty('web_accessible_resources');

  // Nothing is granted beyond the required permissions until the user opts in.
  expect(await worker.evaluate(() => chrome.permissions.getAll())).toEqual({
    origins: [],
    permissions: expect.arrayContaining(['storage', 'activeTab', 'scripting', 'contextMenus', 'sidePanel']) as unknown,
  });

  // Every extension page renders without errors.
  for (const path of ['src/popup/index.html', 'src/sidepanel/index.html', 'src/options/index.html']) {
    const page = await harness.extensionPage(path);
    await expect(page.locator('#app > *').first()).toBeVisible();
    await page.close();
  }

  const info = await harness.extensionInfo();
  expect(info).toEqual({ runtimeErrors: [], manifestErrors: [], installWarnings: [] });
  expect(await harness.allErrors()).toEqual([]);
});
