// Renders public/icons/icon.svg to the PNG sizes Chrome needs (16, 32, 48, 128).
// The PNGs are committed; run `npm run icons` after editing the SVG.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const svg = await readFile(`${dir}icon.svg`);

for (const size of [16, 32, 48, 128]) {
  // Render at 8x and downsample for crisp small sizes.
  await sharp(svg, { density: (72 * size * 8) / 128 })
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(`${dir}icon-${size}.png`);
  console.log(`icon-${size}.png`);
}
