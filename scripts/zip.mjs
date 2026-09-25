// Packs dist/ for distribution (run after `npm run build`; the npm scripts do).
//
//   node scripts/zip.mjs            → quicknotes-v<version>.zip, for the Chrome
//                                     Web Store: manifest.json at the archive
//                                     root, as the dashboard requires.
//   node scripts/zip.mjs --install  → QuickNotes-v<version>-install.zip, for
//                                     people who install it by hand: one folder,
//                                     QuickNotes/, with manifest.json inside —
//                                     the folder to pick in "Load unpacked".
//
// Both hold exactly the same files: the ones the extension uses (see
// scripts/package.mjs, which refuses to pack a build with anything else in it).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_FOLDER, packageEntries, zip } from './package.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const install = process.argv.includes('--install');

try {
  const entries = await packageEntries(dist, install ? INSTALL_FOLDER : undefined);
  const { version } = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  const outName = install ? `${INSTALL_FOLDER}-v${version}-install.zip` : `quicknotes-v${version}.zip`;
  const archive = zip(entries);
  await writeFile(join(root, outName), archive);
  const files = entries.filter((entry) => !entry.name.endsWith('/')).length;
  console.log(`${outName}: ${files} files, ${(archive.length / 1024).toFixed(1)} KiB`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
