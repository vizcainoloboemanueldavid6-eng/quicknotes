/**
 * Shadow DOM isolation on the demo article, whose global CSS restyles every
 * element with !important rules, hides [role=toolbar]/[role=group]/
 * [contenteditable], and pins overlays at the maximum z-index.
 */
import { PASSAGES, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts' });

const INK = 'rgb(28, 25, 23)';

test('page CSS does not reach the injected UI, and the UI CSS does not reach the page', async ({ harness }) => {
  const page = await harness.openDemo();
  const pageStylesBefore = await page.evaluate(() => ({
    sheets: document.styleSheets.length,
    adopted: document.adoptedStyleSheets.length,
  }));

  // The popup injects the content script into the tab.
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popup.close();

  // The page's own CSS is active.
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('intro')!).color)).toBe('rgb(204, 0, 0)');

  // --- Selection toolbar -------------------------------------------------------
  await selectText(page, PASSAGES.yellow.selector, PASSAGES.yellow.text);
  const toolbar = page.locator('[data-qn="toolbar"]');
  await expect(toolbar).toBeVisible();
  const toolbarStyles = await page.evaluate(() => {
    const shadow = document.querySelector('quicknotes-root')!.shadowRoot!;
    const bar = shadow.querySelector<HTMLElement>('[data-qn="toolbar"]')!;
    const addNote = [...bar.querySelectorAll('button')].find((button) => button.textContent?.includes('Add note'))!;
    const icon = addNote.querySelector('svg')!;
    const style = getComputedStyle(addNote);
    const barStyle = getComputedStyle(bar);
    const rect = bar.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      barDisplay: barStyle.display,
      barBoxSizing: barStyle.boxSizing,
      barBorderStyle: barStyle.borderTopStyle,
      buttonFont: style.fontFamily,
      buttonColor: style.color,
      buttonBackground: style.backgroundColor,
      buttonFontSize: style.fontSize,
      buttonLetterSpacing: style.letterSpacing,
      buttonTransform: style.textTransform,
      buttonMinWidth: style.minWidth,
      iconWidth: getComputedStyle(icon).width,
      hitIsHost: hit === document.querySelector('quicknotes-root'),
    };
  });
  expect(toolbarStyles).toEqual({
    barDisplay: 'flex',
    barBoxSizing: 'border-box',
    barBorderStyle: 'solid',
    buttonFont: expect.not.stringContaining('Times') as unknown as string,
    buttonColor: INK,
    buttonBackground: 'rgba(0, 0, 0, 0)',
    buttonFontSize: '13px',
    buttonLetterSpacing: 'normal',
    buttonTransform: 'none',
    buttonMinWidth: 'auto',
    iconWidth: '16px',
    hitIsHost: true,
  });

  // --- A note, created from the toolbar ----------------------------------------
  await page.getByRole('button', { name: 'Add note' }).click();
  const note = page.locator('[data-qn="note"]');
  await expect(note).toBeVisible();
  await page.keyboard.type('Styled by QuickNotes, not by the page.');

  const noteStyles = await page.evaluate(() => {
    const shadow = document.querySelector('quicknotes-root')!.shadowRoot!;
    const box = shadow.querySelector<HTMLElement>('[data-qn="note"]')!;
    const editor = shadow.querySelector<HTMLElement>('.qn-editor')!;
    const format = shadow.querySelector<HTMLElement>('[data-qn="note"] [role="toolbar"]')!;
    const e = getComputedStyle(editor);
    const b = getComputedStyle(box);
    const mark = document.querySelector('quicknotes-mark')!;
    const m = getComputedStyle(mark);
    return {
      noteDisplay: b.display,
      noteBorderStyle: b.borderTopStyle,
      noteBoxSizing: b.boxSizing,
      noteBackground: b.backgroundColor,
      noteShadow: b.boxShadow,
      editorDisplay: e.display,
      editorBackground: e.backgroundColor,
      editorColor: e.color,
      editorFont: e.fontFamily,
      editorFontSize: e.fontSize,
      editorLetterSpacing: e.letterSpacing,
      editorTextIndent: e.textIndent,
      formatDisplay: getComputedStyle(format).display,
      markBackground: m.backgroundColor,
      markColor: m.color,
    };
  });
  expect(noteStyles).toEqual({
    noteDisplay: 'flex',
    noteBorderStyle: 'solid',
    noteBoxSizing: 'border-box',
    noteBackground: 'rgb(255, 243, 176)',
    // The soft dark "paper" shadow (a near-white one would be invisible on light pages).
    noteShadow: expect.stringContaining('rgba(28, 25, 23, 0.22)') as unknown as string,
    editorDisplay: 'block',
    editorBackground: 'rgba(0, 0, 0, 0)',
    editorColor: INK,
    editorFont: expect.not.stringContaining('Times') as unknown as string,
    editorFontSize: '14px',
    editorLetterSpacing: 'normal',
    editorTextIndent: '0px',
    formatDisplay: 'flex',
    markBackground: 'rgb(253, 230, 138)',
    markColor: INK,
  });

  // --- Stacking: the note stays above the page's max-z-index fixed header -------
  const onTop = await page.evaluate(() => {
    const host = document.querySelector('quicknotes-root')!;
    const box = host.shadowRoot!.querySelector<HTMLElement>('[data-qn="note"]')!;
    const top = box.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top - 10, behavior: 'instant' });
    const rect = box.getBoundingClientRect();
    const header = document.querySelector('.site-header')!.getBoundingClientRect();
    const x = rect.left + 60;
    const y = rect.top + 20;
    return {
      overlapsHeader: y < header.bottom,
      hitIsHost: document.elementFromPoint(x, y) === host,
      headerStillThere: document.elementFromPoint(header.right - 5, header.top + 5)?.closest('.site-header') !== null,
    };
  });
  expect(onTop).toEqual({ overlapsHeader: true, hitIsHost: true, headerStillThere: true });

  // --- Nothing leaks into the page ------------------------------------------------
  const pageAfter = await page.evaluate(() => ({
    sheets: document.styleSheets.length,
    adopted: document.adoptedStyleSheets.length,
    h1BoxSizing: getComputedStyle(document.querySelector('h1')!).boxSizing,
    buttonBackground: getComputedStyle(document.getElementById('toggle-hostile')!).backgroundColor,
    paragraphFont: getComputedStyle(document.getElementById('intro')!).fontFamily,
    hostChildren: document.querySelector('quicknotes-root')!.children.length,
  }));
  expect(pageAfter).toEqual({
    ...pageStylesBefore,
    h1BoxSizing: 'content-box',
    buttonBackground: 'rgb(0, 0, 0)',
    paragraphFont: expect.stringContaining('Times') as unknown as string,
    hostChildren: 0,
  });

  expect(await harness.allErrors()).toEqual([]);
});
