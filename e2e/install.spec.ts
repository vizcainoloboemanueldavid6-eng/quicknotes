/** The shipped build loads cleanly, with exactly the permissions it declares. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSION_DIR, expect, test } from './harness';

test.use({ variant: 'default', shadow: 'shipped' });

interface PackageModule {
  INSTALL_FOLDER: string;
  packageFiles: (dir: string) => Promise<string[]>;
  packageEntries: (dir: string, folder?: string) => Promise<Array<{ name: string; data?: Buffer }>>;
}

const packageModule = () => import(new URL('../scripts/package.mjs', import.meta.url).href) as Promise<PackageModule>;

test('the package holds only files the extension uses', async () => {
  const { packageFiles } = await packageModule();
  // Throws, listing them, if a file is unused or a file the manifest or a page names is missing.
  const files = await packageFiles(EXTENSION_DIR);
  expect(files).toEqual(expect.arrayContaining(['manifest.json', 'service-worker-loader.js', 'src/content/index.js']));
  expect(files.filter((file) => /\.(map|svg|ts|tsx|md)$|^\.vite\/|test|e2e/.test(file))).toEqual([]);
});

test('the install zip is one QuickNotes folder; the store zip has manifest.json at its root', async () => {
  const { INSTALL_FOLDER, packageEntries, packageFiles } = await packageModule();
  const files = await packageFiles(EXTENSION_DIR);
  expect(INSTALL_FOLDER).toBe('QuickNotes');

  const install = await packageEntries(EXTENSION_DIR, INSTALL_FOLDER);
  expect(install.every((entry) => entry.name.startsWith('QuickNotes/'))).toBe(true);
  expect(install.map((entry) => entry.name)).toContain('QuickNotes/manifest.json');
  expect(install.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name)).toEqual(
    files.map((file) => `QuickNotes/${file}`),
  );

  const store = await packageEntries(EXTENSION_DIR);
  expect(store.map((entry) => entry.name)).toEqual(files);
});

test('the build contains no network or remote-code APIs', async () => {
  const dist = EXTENSION_DIR;
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

test('on a page QuickNotes cannot run on, the popup says so and still opens the side panel', async ({ harness }) => {
  const page = await harness.context.newPage();
  await page.goto('about:blank');
  const popup = await harness.openPopup(page);
  await popup.waitFor('document.body.textContent.includes("can\'t run on this page")');
  await popup.click('button', 'Open side panel');
  const panel = await harness.attach('/src/sidepanel/index.html');
  await panel.click('[data-testid="tab-all"]');
  await panel.waitFor('document.querySelector("[data-testid=summary]") !== null');
  expect(await harness.allErrors()).toEqual([]);
});
