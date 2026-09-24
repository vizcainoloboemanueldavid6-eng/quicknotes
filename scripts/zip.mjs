// Packs dist/ into quicknotes-v<version>.zip with manifest.json at the archive
// root, ready for the Chrome Web Store. No dependencies: a minimal ZIP writer
// (deflate via node:zlib, CRC-32 via zlib.crc32). Entries are sorted and
// timestamped with a fixed date, so the same build always gives the same bytes.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)])),
  );
  return files.flat();
}

// 2026-01-01 00:00:00 in MS-DOS format.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

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

function centralHeader(name, crc, compressedSize, size, method, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return header;
}

async function main() {
  const manifestPath = join(dist, 'manifest.json');
  try {
    await stat(manifestPath);
  } catch {
    console.error('dist/manifest.json not found — run `npm run build` first.');
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const outName = `quicknotes-v${manifest.version}.zip`;

  const files = (await listFiles(dist))
    .map((file) => ({ file, name: relative(dist, file).split(sep).join('/') }))
    .filter(({ name }) => !name.startsWith('.vite/'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { file, name } of files) {
    const data = await readFile(file);
    const nameBuffer = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const local = localHeader(nameBuffer, crc, body.length, data.length, method);
    locals.push(local, nameBuffer, body);
    centrals.push(centralHeader(nameBuffer, crc, body.length, data.length, method, offset), nameBuffer);
    offset += local.length + nameBuffer.length + body.length;
  }

  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);

  const zip = Buffer.concat([...locals, central, end]);
  await writeFile(join(root, outName), zip);
  console.log(`${outName}: ${files.length} files, ${(zip.length / 1024).toFixed(1)} KiB`);
}

await main();
