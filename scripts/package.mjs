// What goes into the QuickNotes packages, and the ZIP writer that packs them.
//
// packageFiles(dir) walks the build from manifest.json: every path the manifest
// names, every script, stylesheet and module an extension page or script loads,
// and the _locales/ Chrome reads because of `default_locale`. A file of the
// build that nothing reaches is an error, not a silent omission, so a stray file
// (a source SVG, a source map, build metadata, a test file) cannot end up in
// either zip or in the dist/ folder a developer loads.
//
// writeZip() is a minimal, dependency-free ZIP writer (deflate via node:zlib,
// CRC-32 via zlib.crc32). Entries keep the order they are given and carry a
// fixed timestamp, so the same build always gives the same bytes.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** Every file under `dir`, as sorted POSIX paths relative to it. */
async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort(compare);
}

/** Byte-order comparison: the same order on every platform and locale. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every string value of a JSON document, however deeply nested. */
function jsonStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(jsonStrings);
  return [];
}

// A quoted or url()-wrapped path to a file type the extension can load.
const PATH_IN_CODE =
  /["'`(]((?:\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:js|mjs|css|html|json|png|svg|webp|woff2?))["'`)]/g;
// src="…" and href="…" in an HTML page.
const PATH_IN_HTML = /\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/g;

/**
 * The files of the build that `file` (a POSIX path relative to the build root)
 * points to (`found`), and — for an HTML page — the scripts and stylesheets it
 * loads that are not in the build (`missing`). Paths quoted in code are only
 * candidates: they count when a file by that name exists.
 */
function references(file, text, exists) {
  const base = posix.dirname(file);
  const resolve = (path) => {
    if (path.startsWith('/')) return [path.slice(1)];
    if (path.startsWith('./') || path.startsWith('../')) return [posix.normalize(posix.join(base, path))];
    // A bare path: chrome.* APIs resolve it from the extension root, the DOM
    // from the page's folder.
    return [path, posix.normalize(posix.join(base, path))];
  };
  const found = new Set();
  const missing = [];
  if (file.endsWith('.html')) {
    for (const [, path] of text.matchAll(PATH_IN_HTML)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(path)) continue; // data:, chrome:, https:…
      const hit = resolve(path).find(exists);
      if (hit) found.add(hit);
      else missing.push(path);
    }
  }
  for (const [, path] of text.matchAll(PATH_IN_CODE)) {
    const hit = resolve(path).find(exists);
    if (hit) found.add(hit);
  }
  return { found, missing };
}

/**
 * The files of the extension built in `dir`, sorted, after checking that the
 * manifest's files exist and that nothing in `dir` is unused.
 */
export async function packageFiles(dir) {
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error(`${join(dir, 'manifest.json')} not found — run \`npm run build\` first.`);
  }
  const all = await listFiles(dir);
  const present = new Set(all);
  const exists = (path) => present.has(path);
  const problems = new Set();

  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const reached = new Set(['manifest.json']);
  const queue = [];
  const reach = (path) => {
    if (reached.has(path)) return;
    reached.add(path);
    queue.push(path);
  };

  for (const value of jsonStrings(manifest)) {
    if (!/\.(js|css|html|json|png|svg|webp)$/.test(value) || /^[a-z]+:\/\//.test(value)) continue;
    const path = value.replace(/^\//, '');
    if (exists(path)) reach(path);
    else problems.add(`manifest.json names ${value}, which is not in the build`);
  }
  if (manifest.default_locale) {
    const locales = all.filter((path) => /^_locales\/[^/]+\/messages\.json$/.test(path));
    if (!locales.includes(`_locales/${manifest.default_locale}/messages.json`)) {
      problems.add(`default_locale is "${manifest.default_locale}" but its messages.json is missing`);
    }
    locales.forEach(reach);
  }

  while (queue.length > 0) {
    const file = queue.shift();
    if (!/\.(js|mjs|css|html)$/.test(file)) continue;
    const { found, missing } = references(file, await readFile(join(dir, file), 'utf8'), exists);
    for (const path of missing) problems.add(`${file} loads ${path}, which is not in the build`);
    found.forEach(reach);
  }

  for (const path of all) {
    if (!reached.has(path)) problems.add(`${path} is not used by the extension`);
  }
  if (problems.size > 0) {
    throw new Error(`The build in ${dir} is not ready to package:\n  - ${[...problems].join('\n  - ')}`);
  }
  return all;
}

/** The one folder of the install zip, which people pick in "Load unpacked". */
export const INSTALL_FOLDER = 'QuickNotes';

// 2026-01-01 00:00:00 in MS-DOS format.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_DIRECTORY = 0x10;

function localHeader(name, crc, compressedSize, size, method) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(name, crc, compressedSize, size, method, offset, attributes) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by (MS-DOS attributes)
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(attributes, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

/**
 * A ZIP archive of `entries`, in order: `{ name, data }` for a file, or
 * `{ name }` with a trailing slash for a folder.
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0) } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const folder = name.endsWith('/');
    const deflated = folder ? data : deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const local = localHeader(nameBuffer, crc, body.length, data.length, method);
    locals.push(local, nameBuffer, body);
    centrals.push(
      centralHeader(nameBuffer, crc, body.length, data.length, method, offset, folder ? DOS_DIRECTORY : 0),
      nameBuffer,
    );
    offset += local.length + nameBuffer.length + body.length;
  }

  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

/**
 * The ZIP entries for the build in `dir`: its files at the archive root, or —
 * with `folder` — inside that one top-level folder, listed with every
 * sub-folder so that any unzip tool recreates the same tree.
 */
export async function packageEntries(dir, folder) {
  const files = await packageFiles(dir);
  const prefix = folder ? `${folder}/` : '';
  const entries = [];
  if (folder) {
    const folders = new Set([prefix]);
    for (const file of files) {
      for (let parent = posix.dirname(file); parent !== '.'; parent = posix.dirname(parent)) {
        folders.add(`${prefix}${parent}/`);
      }
    }
    for (const name of folders) entries.push({ name });
  }
  for (const file of files) entries.push({ name: prefix + file, data: await readFile(join(dir, file)) });
  return entries.sort((a, b) => compare(a.name, b.name));
}
