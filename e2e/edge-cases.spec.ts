/**
 * Pages and inputs that broke earlier builds: SVG text and editors inside a
 * highlighted range, a page that stops mouseup from bubbling, text at the very
 * edge of the window, Chrome's built-in Ctrl+U, and very long notes.
 */
import type { Page } from '@playwright/test';
import { selectText, waitForQuickNotes } from './helpers';
import { expect, test, type ExtensionHarness } from './harness';

test.use({ variant: 'hosts' });

const EDGE_CASES = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Edge cases</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  p, div { margin: 8px 0; }
  #right { text-align: right; }
</style></head>
<body>
  <p id="edge">Edgeword starts this paragraph at the very left edge of the window.</p>
  <p id="right">This paragraph ends at the right edge with a lastword</p>
  <p id="before">Text before the chart caption.</p>
  <svg width="400" height="60"><text id="label" x="10" y="30" font-size="20">Chart label inside SVG</text></svg>
  <div id="editor" contenteditable="true">editable page content</div>
  <p id="after">Text after the chart caption.</p>
  <p id="stop" onmouseup="event.stopPropagation()">This paragraph stops mouseup propagation for its own reasons.</p>
</body></html>`;

async function openEdgeCases(harness: ExtensionHarness): Promise<Page> {
  const url = new URL('edge-cases.html', harness.demoUrl).href;
  const page = await harness.context.newPage();
  await page.route(url, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: EDGE_CASES }),
  );
  await page.goto(url);
  await page.bringToFront();
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popup.close();
  return page;
}

/** Drags from the first character of `from` to just after `toText` inside `to`. */
async function dragAcross(page: Page, from: string, to: string, toText: string): Promise<void> {
  const points = await page.evaluate(
    ({ from, to, toText }) => {
      const charRect = (element: Element, offset: number) => {
        const node = element.firstChild as Text;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        return range.getBoundingClientRect();
      };
      const start = charRect(document.querySelector(from)!, 0);
      const endElement = document.querySelector(to)!;
      const end = charRect(endElement, (endElement.textContent ?? '').indexOf(toText) + toText.length - 1);
      return {
        start: { x: start.left + 1, y: start.top + start.height / 2 },
        end: { x: end.right - 1, y: end.top + end.height / 2 },
      };
    },
    { from, to, toText },
  );
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  await page.mouse.up();
}

test('highlights leave SVG text and page editors alone; the toolbar survives hostile pages', async ({ harness }) => {
  const page = await openEdgeCases(harness);
  const toolbar = page.locator('[data-qn="toolbar"]');

  // --- A selection across a chart and an editor -----------------------------------
  const labelWidth = () =>
    page.evaluate(() => (document.getElementById('label') as unknown as SVGGraphicsElement).getBBox().width);
  const widthBefore = await labelWidth();
  expect(widthBefore).toBeGreaterThan(50);
  await dragAcross(page, '#before', '#after', 'Text after');
  await expect(toolbar).toBeVisible();
  await page.getByRole('button', { name: 'Highlight in Yellow' }).click();
  // (Whitespace between the blocks is wrapped too, harmlessly: it renders nothing.)
  await expect
    .poll(async () => (await page.locator('quicknotes-mark').allTextContents()).filter((text) => text.trim()))
    .toEqual(['Text before the chart caption.', 'Text after']);
  expect(await page.evaluate(() => document.getElementById('label')!.innerHTML)).toBe('Chart label inside SVG');
  expect(await labelWidth()).toBe(widthBefore);
  expect(await page.evaluate(() => document.getElementById('editor')!.innerHTML)).toBe('editable page content');

  // --- A page that stops mouseup from bubbling still gets the toolbar --------------
  await page.mouse.click(5, 5);
  await expect(toolbar).toHaveCount(0);
  await selectText(page, '#stop', 'stops mouseup propagation');
  await expect(toolbar).toBeVisible();

  // --- The toolbar stays 8 px inside the window at both edges ----------------------
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  for (const [selector, word] of [
    ['#edge', 'Edgeword'],
    ['#right', 'lastword'],
  ] as const) {
    await page.mouse.click(5, 5);
    await selectText(page, selector, word);
    await expect(toolbar).toBeVisible();
    await page.waitForTimeout(300); // the pop-in animation scales the box
    const box = await toolbar.boundingBox();
    if (!box) throw new Error('toolbar has no box');
    expect(box.x, `${word}: left edge`).toBeGreaterThanOrEqual(7.5);
    expect(box.x + box.width, `${word}: right edge`).toBeLessThanOrEqual(viewportWidth - 7.5);
  }

  expect(await harness.allErrors()).toEqual([]);
});

test('Ctrl+U shows no underline that would be lost; long notes are never cut short', async ({ harness }) => {
  const page = await openEdgeCases(harness);
  await selectText(page, '#edge', 'Edgeword');
  await page.getByRole('button', { name: 'Add note' }).click();
  const note = page.locator('[data-qn="note"]');
  const editor = note.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toBeFocused();
  const pageUrl = page.url();
  const storedHtml = async () => {
    const all = await harness.storage();
    const record = all[`page:${pageUrl}`] as { notes: Array<{ html: string }> } | undefined;
    return record?.notes[0]?.html ?? '';
  };

  // --- Ctrl+U -----------------------------------------------------------------------
  await page.keyboard.type('plain ');
  await page.keyboard.press('Control+U');
  await page.keyboard.type('text');
  expect(await editor.evaluate((element) => element.innerHTML)).not.toContain('<u>');
  await page.keyboard.press('Escape');
  await expect.poll(storedHtml).toBe('plain text');

  // --- A long paste (2,200 lines, ~66,000 characters) is kept in full ---------------
  const paste = (text: string) =>
    editor.evaluate((element, text) => {
      element.focus();
      const selection = (element.getRootNode() as ShadowRoot & { getSelection(): Selection }).getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  const lines = Array.from({ length: 2200 }, (_, i) => `Line ${i + 1} of a long pasted note`).join('\n');
  await paste(`\n${lines}`);
  await page.keyboard.press('Escape');
  await expect.poll(storedHtml, { timeout: 20_000 }).toContain('Line 2200 of a long pasted note');
  const saved = await storedHtml();
  expect(saved.length).toBeGreaterThan(lines.length);
  expect(saved).toContain('Line 1 of a long pasted note');

  // --- A paste that would pass the limit is refused, and nothing is lost ------------
  await paste('x'.repeat(40_000));
  await expect(page.locator('[data-qn="toast"]')).toContainText('This note is at its maximum length.');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  expect(await storedHtml()).toBe(saved);
  await page.reload();
  const again = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await again.close();
  await expect(page.locator('[data-qn="note"]').getByRole('textbox', { name: 'Note text' })).toContainText(
    'Line 2200 of a long pasted note',
  );

  expect(await harness.allErrors()).toEqual([]);
});
