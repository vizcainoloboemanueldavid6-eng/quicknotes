/**
 * The core flow on the hostile demo page, with automatic restore turned on the
 * way a user does it (Options → checkbox), then a reload: highlights in all four
 * colors and a formatted, moved, resized and minimized note come back in place.
 */
import { COLOR_NAMES, PASSAGES, markBoxes, noteBox, selectText, waitForQuickNotes, type ColorKey } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts' });

test('highlight in every color, edit a note, reload: everything comes back in place', async ({ harness }) => {
  // --- Opt in to automatic restore from the Options page ---------------------
  const options = await harness.extensionPage('src/options/index.html');
  await options.getByRole('checkbox', { name: /Restore my notes automatically/ }).check();
  const worker = await harness.worker();
  await expect
    .poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length))
    .toBe(1);
  await options.close();

  const page = await harness.openDemo();
  await waitForQuickNotes(page);

  // --- Four highlights from the selection toolbar ----------------------------
  const toolbar = page.locator('[data-qn="toolbar"]');
  for (const color of Object.keys(PASSAGES) as ColorKey[]) {
    const passage = PASSAGES[color];
    const selected = await selectText(page, passage.selector, passage.text);
    expect(selected).toBe(passage.text);
    await expect(toolbar).toBeVisible();
    await page.getByRole('button', { name: `Highlight in ${COLOR_NAMES[color]}` }).click();
    await expect(page.locator(`quicknotes-mark[data-qn-color="${color}"]`).first()).toBeAttached();
    expect((await page.locator(`quicknotes-mark[data-qn-color="${color}"]`).allTextContents()).join('')).toBe(
      passage.text,
    );
    await expect(toolbar).toHaveCount(0);
  }
  await expect.poll(async () => (await harness.demoRecord())?.highlights.length).toBe(4);

  // --- A note attached to the blue highlight, from the highlight menu ---------
  await page.locator('quicknotes-mark[data-qn-color="blue"]').first().click();
  await expect(page.locator('[data-qn="highlight-menu"]')).toBeVisible();
  await page.getByRole('button', { name: 'Add note' }).click();
  const note = page.locator('[data-qn="note"]');
  await expect(note).toBeVisible();
  const editor = note.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Key idea: ');
  await page.keyboard.press('Control+B');
  await page.keyboard.type('one idea per note');
  await page.keyboard.press('Control+B');
  await page.keyboard.type(' keeps the margin readable.');
  await expect
    .poll(async () => (await harness.demoRecord())?.notes[0]?.html ?? '')
    .toContain('Key idea: <b>one idea per note</b> keeps the margin readable.');
  const record = await harness.demoRecord();
  const blueId = record?.highlights.find((highlight) => highlight.color === 'blue')?.id;
  expect(record?.notes[0]?.highlightId).toBe(blueId);

  // Drag by the header.
  const before = await noteBox(page);
  const header = note.getByRole('button', { name: 'Drag to move the note' });
  const grip = await header.boundingBox();
  if (!grip) throw new Error('no move handle');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 180, grip.y + grip.height / 2 + 90, { steps: 12 });
  await page.mouse.up();
  const moved = await noteBox(page);
  expect(moved.x).toBeLessThan(before.x - 150);
  expect(moved.y).toBeGreaterThan(before.y + 60);

  // Resize from the corner grip.
  const resize = await note.getByRole('button', { name: 'Drag to resize the note' }).boundingBox();
  if (!resize) throw new Error('no resize handle');
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize.x + resize.width / 2 + 70, resize.y + resize.height / 2 + 50, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.size).toEqual({ width: 310, height: 250 });
  const placed = await noteBox(page);
  expect(placed).toMatchObject({ x: moved.x, y: moved.y, width: 310, height: 250 });

  // Minimize, then expand again: the size is kept.
  await note.getByRole('button', { name: 'Minimize note' }).click();
  await expect(note.getByRole('button', { name: 'Expand note' })).toBeVisible();
  await expect(note).toContainText('Key idea: one idea per note keeps the margin readable.');
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.minimized).toBe(true);
  expect(await noteBox(page)).toMatchObject({ x: placed.x, y: placed.y });
  await note.getByRole('button', { name: 'Expand note' }).click();
  await expect(note.getByRole('textbox', { name: 'Note text' })).toBeVisible();
  expect(await noteBox(page)).toEqual(placed);
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.minimized).toBe(false);

  // --- Reload: the registered content script restores everything -------------
  const marksBefore = await markBoxes(page);
  expect(Object.keys(marksBefore)).toHaveLength(4);
  await page.reload();
  await waitForQuickNotes(page);
  await expect(page.locator('[data-qn="note"]')).toBeVisible();
  await expect(page.locator('quicknotes-mark')).not.toHaveCount(0);
  await expect.poll(async () => Object.keys(await markBoxes(page)).length).toBe(4);
  expect(await markBoxes(page)).toEqual(marksBefore);
  expect(await noteBox(page)).toEqual(placed);
  const restoredHtml = await page
    .locator('[data-qn="note"]')
    .getByRole('textbox', { name: 'Note text' })
    .evaluate((element) => element.innerHTML);
  expect(restoredHtml).toContain('<b>one idea per note</b>');

  // Minimized state survives a reload too.
  await page.locator('[data-qn="note"]').getByRole('button', { name: 'Minimize note' }).click();
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.minimized).toBe(true);
  await page.reload();
  await waitForQuickNotes(page);
  await expect(page.locator('[data-qn="note"]').getByRole('button', { name: 'Expand note' })).toBeVisible();
  expect(await noteBox(page)).toMatchObject({ x: placed.x, y: placed.y });

  expect(await harness.allErrors()).toEqual([]);
});
