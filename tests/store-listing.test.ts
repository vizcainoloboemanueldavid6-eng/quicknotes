// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import en from '../src/_locales/en/messages.json';

const ROOT = process.cwd();
const listing = readFileSync(join(ROOT, 'store-assets', 'description.md'), 'utf8');

/** The first ```text block after a "## Heading", and the "N / M characters" line above it. */
function section(heading: string): { text: string; stated: number | null; limit: number | null } {
  const start = listing.indexOf(`## ${heading}`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = listing.slice(start);
  const block = /```text\n([\s\S]*?)\n```/.exec(rest);
  const counts = /(\d+) \/ (\d+) characters/.exec(rest.slice(0, block?.index ?? 0));
  return {
    text: block?.[1] ?? '',
    stated: counts ? Number(counts[1]) : null,
    limit: counts ? Number(counts[2]) : null,
  };
}

describe('Chrome Web Store listing (store-assets/description.md)', () => {
  it('title: at most 45 characters, as stated, and equal to the manifest name', () => {
    const title = section('Title');
    expect(title.text).toBe(en.extName.message);
    expect(title.limit).toBe(45);
    expect(title.text.length).toBe(title.stated);
    expect(title.text.length).toBeLessThanOrEqual(45);
  });

  it('summary: at most 132 characters, as stated, and equal to the manifest description', () => {
    const summary = section('Summary (short description)');
    expect(summary.text).toBe(en.extDescription.message);
    expect(summary.limit).toBe(132);
    expect(summary.text.length).toBe(summary.stated);
    expect(summary.text.length).toBeLessThanOrEqual(132);
  });

  it('long description fits the 16,000-character limit and names no permission it does not use', () => {
    const description = section('Description (long)').text;
    expect(description.length).toBeGreaterThan(500);
    expect(description.length).toBeLessThanOrEqual(16_000);
    expect(description).not.toMatch(/\b(tabs|history|downloads|cookies|webRequest)\b permission/i);
  });

  it.each([
    ['icon-128.png', 128, 128],
    ['screenshot-1-highlight-and-note.png', 1280, 800],
    ['screenshot-2-side-panel.png', 1280, 800],
    ['screenshot-3-all-notes-popup.png', 1280, 800],
    ['promo-small-440x280.png', 440, 280],
  ])('%s is %ix%i', async (file, width, height) => {
    const path = join(ROOT, 'store-assets', file);
    expect(existsSync(path), `${file} missing — run npm run store-assets`).toBe(true);
    const meta = await sharp(path).metadata();
    expect({ width: meta.width, height: meta.height, format: meta.format }).toEqual({ width, height, format: 'png' });
    if (file !== 'icon-128.png') {
      // The dashboard takes screenshots and promo tiles as JPEG or 24-bit PNG with no alpha.
      expect({ channels: meta.channels, hasAlpha: meta.hasAlpha }).toEqual({ channels: 3, hasAlpha: false });
    }
  });
});
