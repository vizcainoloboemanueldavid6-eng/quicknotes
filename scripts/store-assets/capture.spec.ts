/**
 * Captures the Chrome Web Store images into store-assets/ (`npm run store-assets`):
 *
 *  - screenshot-1-highlight-and-note.png   1280×800  the demo article with highlights, notes and the toolbar
 *  - screenshot-2-side-panel.png           1280×800  the article next to the side panel ("This page")
 *  - screenshot-3-all-notes-popup.png      1280×800  the popup over the article, "All notes" with a search
 *  - promo-small-440x280.png               440×280   small promo tile
 *  - icon-128.png                          128×128   store icon (copy of public/icons/icon-128.png)
 *
 * It drives the real extension on demo/article.html (with the page's hostile
 * CSS switched off through #calm, so the article looks like a normal site),
 * using the same harness as the end-to-end tests. Images are 1x PNGs.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { expect, test, type CdpTarget, type ExtensionHarness } from '../../e2e/harness';
import { popupReady, selectText, waitForQuickNotes } from '../../e2e/helpers';

test.use({ variant: 'hosts' });

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'store-assets');
const WIDTH = 1280;
const HEIGHT = 800;
const PANEL_WIDTH = 399;
const PAGE_WIDTH = WIDTH - PANEL_WIDTH - 1;

const T = Date.now() - 3 * 24 * 60 * 60 * 1000;

/** Other (fictional) pages, so "All notes" has something to search. */
function libraryFile(): string {
  const anchor = (exact: string, start: number) => ({
    quote: { exact, prefix: '', suffix: '' },
    start: { xpath: '/html[1]/body[1]/main[1]/p[1]', offset: 0 },
    end: { xpath: '/html[1]/body[1]/main[1]/p[1]', offset: exact.length },
    position: { start, end: start + exact.length },
  });
  const highlight = (id: string, color: string, exact: string, start: number, age: number) => ({
    id,
    color,
    anchor: anchor(exact, start),
    createdAt: T - age,
    updatedAt: T - age,
  });
  const note = (id: string, color: string, html: string, age: number, highlightId?: string) => ({
    id,
    color,
    html,
    position: { x: 62, y: 20 },
    size: { width: 240, height: 180 },
    minimized: false,
    createdAt: T - age,
    updatedAt: T - age,
    ...(highlightId ? { highlightId } : {}),
  });
  return JSON.stringify({
    format: 'quicknotes',
    version: 1,
    exportedAt: new Date(T).toISOString(),
    pages: [
      {
        url: 'https://field-guide.example/city-trees',
        title: 'How street trees cool a city block',
        updatedAt: T,
        highlights: [
          highlight('t1', 'green', 'shaded asphalt can be more than ten degrees cooler at midday', 120, 1000),
          highlight('t2', 'yellow', 'a single mature tree does the work of several air conditioners', 900, 900),
        ],
        notes: [note('t3', 'green', 'Compare with the <b>heat map</b> from last summer.', 800, 't1')],
      },
      {
        url: 'https://kitchen-notes.example/slow-bread',
        title: 'Slow bread: letting time do the kneading',
        updatedAt: T - 60_000,
        highlights: [
          highlight('b1', 'yellow', 'a long, cool rise builds flavor that no amount of kneading can', 300, 700),
        ],
        notes: [note('b2', 'pink', 'Try an <i>overnight</i> rise in the fridge.', 600, 'b1')],
      },
      {
        url: 'https://study-desk.example/spaced-review',
        title: 'Spaced review in ten minutes a day',
        updatedAt: T - 120_000,
        highlights: [
          highlight('s1', 'blue', 'the interval between reviews should grow as the memory gets stronger', 80, 500),
          highlight('s2', 'pink', 'is re-reading useful at all, or only a feeling of progress?', 640, 400),
        ],
        notes: [],
      },
    ],
  });
}

async function panelShot(harness: ExtensionHarness, popup: CdpTarget): Promise<CdpTarget> {
  await popupReady(popup);
  await popup.click('button', 'Open side panel');
  const panel = await harness.attach('/src/sidepanel/index.html');
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: PANEL_WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return panel;
}

/**
 * The Web Store wants screenshots as JPEG or 24-bit PNG without alpha: compose
 * on an RGBA canvas (the popup's shadow is translucent), then drop the alpha
 * channel in a second pass — sharp would apply removeAlpha() before composite().
 */
async function sideBySide(page: Buffer, panel: Buffer, path: string, overlays: OverlayOptions[] = []) {
  const composed = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#EDE6D6' } })
    .composite([{ input: page, left: 0, top: 0 }, { input: panel, left: PAGE_WIDTH + 1, top: 0 }, ...overlays])
    .png()
    .toBuffer();
  await sharp(composed).flatten({ background: '#EDE6D6' }).png({ compressionLevel: 9 }).toFile(path);
}

/** Rewrites a PNG as 24-bit RGB if it has an alpha channel (Playwright's own screenshots normally do not). */
async function withoutAlpha(path: string): Promise<void> {
  if (!(await sharp(path).metadata()).hasAlpha) return;
  const rgb = await sharp(path).flatten({ background: '#FFFFFF' }).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(path, rgb);
}

/** A card with a soft shadow, as the popup appears under the toolbar button. */
async function floating(image: Buffer, left: number, top: number): Promise<OverlayOptions[]> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const blur = 14;
  const block = await sharp({
    create: {
      width: width + blur * 4,
      height: height + blur * 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: { width, height, channels: 4, background: { r: 28, g: 25, b: 23, alpha: 0.32 } },
        })
          .png()
          .toBuffer(),
        left: blur * 2,
        top: blur * 2,
      },
    ])
    .png()
    .toBuffer();
  // Blur in a second pass: sharp applies composite() after blur() within one pipeline.
  const shadow = await sharp(block).blur(blur).png().toBuffer();
  const rounded = await sharp(image)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="10" ry="10"/></svg>`,
        ),
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer();
  return [
    { input: shadow, left: left - blur * 2, top: top - blur * 2 + 6 },
    { input: rounded, left, top },
  ];
}

const PROMO_HTML = (icon: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
    color: #1C1917;
    background:
      repeating-linear-gradient(0deg, transparent 0 27px, rgba(201, 148, 0, 0.13) 27px 28px),
      linear-gradient(135deg, #FFF8DC 0%, #FFF1BF 100%);
    position: relative;
  }
  .margin { position: absolute; left: 36px; top: 0; bottom: 0; width: 2px; background: rgba(219, 90, 154, 0.35); }
  .brand { position: absolute; left: 52px; top: 40px; display: flex; align-items: center; gap: 12px; }
  .brand svg { width: 52px; height: 52px; }
  h1 { margin: 0; font-size: 30px; font-weight: 750; letter-spacing: -0.4px; }
  p.tag { position: absolute; left: 52px; top: 112px; width: 212px; margin: 0; font-size: 16px; line-height: 1.5; color: #3F3A35; }
  .hl { padding: 0 3px; border-radius: 3px; }
  .y { background: #FDE68A; } .g { background: #BBF7D0; } .b { background: #BFDBFE; } .p { background: #FBCFE8; }
  .dots { position: absolute; left: 52px; bottom: 32px; display: flex; gap: 8px; }
  .dots span { width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.12); }
  .note {
    position: absolute; left: 306px; top: 54px; width: 104px; height: 114px; transform: rotate(5deg);
    background: #FFF3B0; border: 1px solid #EBD27A; border-radius: 8px;
    box-shadow: 0 2px 4px rgba(28,25,23,0.10), 0 16px 30px -10px rgba(28,25,23,0.35);
  }
  .note::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 22px; background: rgba(28,25,23,0.05); border-bottom: 1px solid #EBD27A; border-radius: 8px 8px 0 0; }
  .note i { position: absolute; left: 14px; height: 7px; border-radius: 4px; background: rgba(28,25,23,0.22); }
  .pink { left: 282px; top: 150px; width: 84px; height: 72px; transform: rotate(-7deg); background: #FCE1EE; border-color: #EDB3CF; }
  .pink::before { border-color: #EDB3CF; }
</style></head><body>
  <div class="margin"></div>
  <div class="brand">${icon}<h1>QuickNotes</h1></div>
  <p class="tag"><span class="hl y">Highlight</span> any text, pin <span class="hl p">sticky notes</span>, find them all again.</p>
  <div class="dots"><span style="background:#FDE68A"></span><span style="background:#BBF7D0"></span><span style="background:#BFDBFE"></span><span style="background:#FBCFE8"></span></div>
  <div class="note pink"><i style="top:34px;width:52px"></i><i style="top:48px;width:40px"></i></div>
  <div class="note"><i style="top:36px;width:84px"></i><i style="top:52px;width:70px"></i><i style="top:68px;width:78px"></i><i style="top:84px;width:44px"></i></div>
</body></html>`;

test('store images', async ({ harness }, testInfo) => {
  test.setTimeout(180_000);
  await mkdir(OUT, { recursive: true });

  // Other pages for "All notes".
  const manager = await harness.extensionPage('src/sidepanel/index.html');
  await manager.getByRole('tab', { name: 'All notes' }).click();
  const library = testInfo.outputPath('library.json');
  await writeFile(library, libraryFile());
  await manager.getByTestId('import-input').setInputFiles(library);
  await expect(manager.getByTestId('import-result')).toContainText('Imported 3 page(s)');
  await manager.close();

  // --- The demo article: highlights and notes -----------------------------------
  const page = await harness.openDemo('#calm');
  let popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popup.close();

  const highlight = async (selector: string, text: string, color: string) => {
    await selectText(page, selector, text);
    await page.getByRole('button', { name: `Highlight in ${color}` }).click();
  };
  await highlight('#intro', 'Readers who keep a pencil in hand tend to remember more', 'yellow');
  await highlight('#intro', 'They are having a conversation with it', 'green');
  await highlight('#margin-1', 'The margin is the only part of a page that belongs to the reader', 'blue');
  await highlight('#margin-2', 'That judgement is what turns reading into learning', 'pink');
  await highlight('#forgetting-2', 'one idea per note, written in your own words', 'yellow');
  await highlight('#color-list', 'Green for evidence, data and examples', 'green');

  // A note on the blue passage, written with the formatting toolbar.
  await page.locator('quicknotes-mark[data-qn-color="blue"]').first().click();
  await page.getByRole('button', { name: 'Add note' }).click();
  const firstNote = page.locator('[data-qn="note"]').first();
  await expect(firstNote.getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Why the margin works:');
  await page.keyboard.press('Enter');
  await firstNote.getByRole('button', { name: 'Bulleted list' }).click();
  await page.keyboard.type('forces a ');
  await page.keyboard.press('Control+B');
  await page.keyboard.type('decision');
  await page.keyboard.press('Control+B');
  await page.keyboard.press('Enter');
  await page.keyboard.type('stays next to the text');
  await page.keyboard.press('Escape');

  // A second, green note next to the intro.
  await page.locator('quicknotes-mark[data-qn-color="green"]').first().click();
  await page.getByRole('button', { name: 'Add note' }).click();
  const secondNote = page.locator('[data-qn="note"]').nth(1);
  await expect(secondNote.getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Quote this in the book club summary.');
  await secondNote.getByRole('button', { name: 'Note color: green' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await harness.demoRecord())?.notes.length).toBe(2);

  // Tidy the notes into the right-hand column, one under the other.
  const place = async (index: number, left: number, top: number) => {
    const note = page.locator('[data-qn="note"]').nth(index);
    const handle = note.getByRole('button', { name: 'Drag to move the note' });
    const box = await handle.boundingBox();
    const noteBox = await note.boundingBox();
    if (!box || !noteBox) throw new Error('note not visible');
    const grabX = box.x + box.width / 2;
    const grabY = box.y + box.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX + (left - noteBox.x), grabY + (top - noteBox.y), { steps: 12 });
    await page.mouse.up();
  };
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // Below the "Try it" card: the list note open, the green one minimized.
  // The green note was created last, so it sits on top: move it first.
  const cardBottom = await page.evaluate(() => document.querySelector('aside .card')!.getBoundingClientRect().bottom);
  await place(1, 866, Math.round(cardBottom) + 230);
  await place(0, 866, Math.round(cardBottom) + 16);
  await page.locator('[data-qn="note"]').nth(1).getByRole('button', { name: 'Minimize note' }).click();
  await expect.poll(async () => (await harness.demoRecord())?.notes.filter((note) => note.minimized).length).toBe(1);
  await page.mouse.click(20, 400);

  // Screenshot 1: the selection toolbar over a new selection.
  await selectText(page, '#margin-1', 'Printing leaves it empty on purpose');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('[data-qn="toolbar"]')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'screenshot-1-highlight-and-note.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  // --- Screenshot 2: the side panel, "This page" -----------------------------------
  await page.setViewportSize({ width: PAGE_WIDTH, height: HEIGHT });
  const scrollToList = () =>
    page.evaluate(() => {
      const heading = document.getElementById('forgetting')!;
      window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - 72, behavior: 'instant' });
    });
  await scrollToList();
  await page.waitForTimeout(400);
  popup = await harness.openPopup(page);
  const panel = await panelShot(harness, popup);
  await panel.waitFor('document.querySelectorAll("[data-testid=item-highlight]").length === 6');
  await page.waitForTimeout(500);
  await sideBySide(await page.screenshot(), await panel.screenshot(), join(OUT, 'screenshot-2-side-panel.png'));

  // --- Screenshot 3: popup + "All notes" with a search -----------------------------
  await panel.click('[data-testid="tab-all"]');
  await panel.fill('[data-testid="search"]', 'reading');
  await panel.waitFor('document.querySelectorAll("[data-testid=page-result]").length >= 2');
  await page.evaluate(() => {
    const heading = document.getElementById('habits')!;
    window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - 330, behavior: 'instant' });
  });
  popup = await harness.openPopup(page);
  await popupReady(popup);
  expect(await popup.text('[data-testid="count-notes"]')).toEqual(['2']);
  await page.waitForTimeout(400);
  const popupImage = await popup.screenshot();
  await sideBySide(
    await page.screenshot(),
    await panel.screenshot(),
    join(OUT, 'screenshot-3-all-notes-popup.png'),
    await floating(popupImage, PAGE_WIDTH - 340, 14),
  );
  await popup.close();

  // --- Promo tile and store icon ----------------------------------------------------
  const promo = await harness.context.newPage();
  await promo.setViewportSize({ width: 440, height: 280 });
  const icon = (await readFile(join(ROOT, 'public/icons/icon.svg'), 'utf8')).replace(/<title>.*?<\/title>/, '');
  await promo.setContent(PROMO_HTML(icon));
  await promo.screenshot({ path: join(OUT, 'promo-small-440x280.png') });
  await copyFile(join(ROOT, 'public/icons/icon-128.png'), join(OUT, 'icon-128.png'));

  for (const [file, width, height] of [
    ['screenshot-1-highlight-and-note.png', WIDTH, HEIGHT],
    ['screenshot-2-side-panel.png', WIDTH, HEIGHT],
    ['screenshot-3-all-notes-popup.png', WIDTH, HEIGHT],
    ['promo-small-440x280.png', 440, 280],
    ['icon-128.png', 128, 128],
  ] as const) {
    // The icon keeps its transparency; screenshots and the promo tile must not have any.
    if (file !== 'icon-128.png') await withoutAlpha(join(OUT, file));
    const meta = await sharp(join(OUT, file)).metadata();
    expect({ file, width: meta.width, height: meta.height }).toEqual({ file, width, height });
    if (file !== 'icon-128.png') expect({ file, channels: meta.channels }).toEqual({ file, channels: 3 });
  }

  expect(await harness.allErrors()).toEqual([]);
});
