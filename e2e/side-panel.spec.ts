/**
 * The side panel: the real panel next to the demo page ("This page": listing,
 * click to scroll, delete, orphaned section, Markdown export) and the
 * "All notes" view (search, filters, export and import) with real downloads.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { PASSAGES, popupReady, selectText, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts' });

const DAY = (() => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
})();

const T = Date.UTC(2026, 8, 20, 12, 0, 0);

function anchor(exact: string, position = 0) {
  return {
    quote: { exact, prefix: '', suffix: '' },
    start: { xpath: '/html[1]/body[1]/main[1]/p[1]', offset: 0 },
    end: { xpath: '/html[1]/body[1]/main[1]/p[1]', offset: exact.length },
    position: { start: position, end: position + exact.length },
  };
}

function highlight(id: string, color: string, exact: string, position = 0) {
  return { id, color, anchor: anchor(exact, position), createdAt: T, updatedAt: T };
}

function note(id: string, color: string, html: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    color,
    html,
    position: { x: 10, y: 10 },
    size: { width: 240, height: 200 },
    minimized: false,
    createdAt: T,
    updatedAt: T,
    ...extra,
  };
}

function exportFile(pages: unknown[]): string {
  return JSON.stringify({ format: 'quicknotes', version: 1, exportedAt: new Date(T).toISOString(), pages });
}

/** Highlights three passages of the demo article and attaches a note to the first one. */
async function annotateDemo(page: Page): Promise<void> {
  for (const color of ['yellow', 'blue', 'pink'] as const) {
    const passage = PASSAGES[color];
    await selectText(page, passage.selector, passage.text);
    await page.getByRole('button', { name: `Highlight in ${color}` }).click();
    await expect(page.locator(`quicknotes-mark[data-qn-color="${color}"]`).first()).toBeAttached();
  }
  await page.locator('quicknotes-mark[data-qn-color="yellow"]').first().click();
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('[data-qn="note"]').getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Check the ');
  await page.keyboard.press('Control+B');
  await page.keyboard.type('sample size');
  await page.keyboard.press('Control+B');
  await page.keyboard.type(' later');
}

test('"This page": list, scroll to, delete, orphans and Markdown export', async ({ harness }, testInfo) => {
  const page = await harness.openDemo();
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await annotateDemo(page);
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.html ?? '').toContain('<b>sample size</b>');

  // Open the real side panel from the popup.
  await popupReady(popup);
  await popup.click('button', 'Open side panel');
  const panel = await harness.attach('/src/sidepanel/index.html');
  await panel.waitFor('document.querySelectorAll("[data-testid=item-highlight]").length === 3');
  expect(await panel.text('[data-testid="page-title"]')).toEqual(['Reading With a Pencil — The Marginalia Review']);
  // Highlights in reading order, then the note with the passage it is about.
  expect(await panel.text('[data-testid="item-highlight"]')).toEqual([
    `Yellow“${PASSAGES.yellow.text}”`,
    `Blue“${PASSAGES.blue.text}”`,
    `Pink“${PASSAGES.pink.text}”`,
  ]);
  expect(await panel.text('[data-testid="item-note"]')).toEqual([
    `On “${PASSAGES.yellow.text}”Check the sample size later`,
  ]);

  // Clicking an item scrolls the page to it.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await panel.click('[data-testid="item-highlight"] button', PASSAGES.yellow.text);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rect = document.querySelector('quicknotes-mark[data-qn-color="yellow"]')!.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }),
    )
    .toBe(true);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await panel.click('[data-testid="item-note"] button');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const box = document.querySelector('quicknotes-root')!.shadowRoot!.querySelector('[data-qn="note"]')!;
        const rect = box.getBoundingClientRect();
        return rect.top >= 0 && rect.top < window.innerHeight;
      }),
    )
    .toBe(true);

  // Deleting an item in the panel removes it from the page (two clicks).
  const blueId = await page.locator('quicknotes-mark[data-qn-color="blue"]').first().getAttribute('data-qn-id');
  const deleteBlue = `[data-item-id="${blueId}"] [data-testid="delete-item"]`;
  await panel.click(deleteBlue);
  await panel.waitFor(`document.querySelector('${deleteBlue}')?.textContent === 'Click again to delete'`);
  await panel.click(deleteBlue);
  await expect(page.locator('quicknotes-mark[data-qn-color="blue"]')).toHaveCount(0);
  await panel.waitFor('document.querySelectorAll("[data-testid=item-highlight]").length === 2');

  // An imported highlight whose text is not on the page shows up as orphaned.
  const importPath = testInfo.outputPath('orphan-import.json');
  await writeFile(
    importPath,
    exportFile([
      {
        url: harness.demoUrl,
        title: 'Reading With a Pencil — The Marginalia Review',
        updatedAt: T,
        highlights: [highlight('imported-orphan', 'green', 'A sentence the editors removed from the article.', 4000)],
        notes: [],
      },
    ]),
  );
  const manager = await harness.extensionPage('src/sidepanel/index.html');
  await manager.getByRole('tab', { name: 'All notes' }).click();
  await manager.getByTestId('import-input').setInputFiles(importPath);
  await expect(manager.getByTestId('import-result')).toHaveText('Imported 1 page(s): 1 highlight(s) and 0 note(s).');
  await manager.close();
  await page.bringToFront();
  await panel.waitFor('document.querySelector("[data-testid=orphans]") !== null', 15_000);
  expect(await panel.text('[data-testid="orphans"] [data-testid="item-highlight"]')).toEqual([
    'GreenNot found on the page“A sentence the editors removed from the article.”',
  ]);
  await expect(page.locator('[data-qn="toast"]')).toContainText('Highlights not found on this page: 1');

  // Export this page to Markdown (the file content, captured from the Blob).
  await panel.evaluate(() => {
    const captured: Array<{ name: string; text: Promise<string> }> = [];
    (window as unknown as { __exports: typeof captured }).__exports = captured;
    let lastBlob: Blob | null = null;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      lastBlob = blob;
      return create(blob);
    };
    document.addEventListener(
      'click',
      (event) => {
        const link = event.target;
        if (link instanceof HTMLAnchorElement && link.download && lastBlob) {
          captured.push({ name: link.download, text: lastBlob.text() });
        }
      },
      true,
    );
  });
  await panel.click('[data-testid="export-page-md"]');
  const exported = await panel.evaluate(async () => {
    const captured = (window as unknown as { __exports: Array<{ name: string; text: Promise<string> }> }).__exports;
    return Promise.all(captured.map(async (entry) => ({ name: entry.name, text: await entry.text })));
  });
  expect(exported).toHaveLength(1);
  expect(exported[0]!.name).toBe(`quicknotes-127-0-0-1-article-html-${DAY}.md`);
  expect(exported[0]!.text).toBe(
    [
      '# Reading With a Pencil — The Marginalia Review',
      `<${harness.demoUrl}>`,
      '## Highlights (3)',
      `> ${PASSAGES.yellow.text}`,
      `*Yellow highlight · ${DAY}*`,
      `> ${PASSAGES.pink.text}`,
      `*Pink highlight · ${DAY}*`,
      '> A sentence the editors removed from the article.',
      '*Green highlight · 2026-09-20 · not found on the page when last checked*',
      '## Notes (1)',
      `### Note 1 · Yellow · ${DAY}`,
      `> On: “${PASSAGES.yellow.text}”`,
      'Check the **sample size** later',
    ].join('\n\n') + '\n',
  );

  expect(await harness.allErrors()).toEqual([]);
});

test('"All notes": search, filters, export and import', async ({ harness }, testInfo) => {
  const manager = await harness.extensionPage('src/sidepanel/index.html');
  await manager.getByRole('tab', { name: 'All notes' }).click();
  await expect(manager.getByText('No notes yet.')).toBeVisible();

  const seed = testInfo.outputPath('seed.json');
  await writeFile(
    seed,
    exportFile([
      {
        url: 'https://www.bakery-notes.example/overnight-bread',
        title: 'Overnight bread',
        updatedAt: T + 3,
        highlights: [highlight('b1', 'green', 'Let the dough rest overnight in a cool place', 10)],
        notes: [note('b2', 'pink', '<b>Try</b> eighteen hours in the fridge', { highlightId: 'b1' })],
      },
      {
        url: 'https://garden.example.org/tomatoes?utm_source=newsletter',
        title: 'Growing tomatoes on a balcony',
        updatedAt: T + 2,
        highlights: [
          highlight('t1', 'yellow', 'Water deeply twice a week rather than a little every day', 5),
          highlight('t2', 'pink', 'Pinch out the side shoots', 90),
        ],
        notes: [],
      },
      {
        url: 'https://garden.example.org/compost',
        title: 'Compost basics',
        updatedAt: T + 1,
        highlights: [],
        notes: [note('c1', 'blue', '<ul><li>Browns and greens</li><li>Turn every week</li></ul>')],
      },
    ]),
  );
  await manager.getByTestId('import-input').setInputFiles(seed);
  await expect(manager.getByTestId('import-result')).toHaveText('Imported 3 page(s): 3 highlight(s) and 2 note(s).');

  const summary = manager.getByTestId('summary');
  const results = manager.getByTestId('page-result');
  await expect(summary).toHaveText('Pages: 3 · Highlights: 3 · Notes: 2');
  await expect(results).toHaveCount(3);
  // Most recently edited first; tracking parameters were dropped from the URL.
  await expect(results.nth(0)).toHaveAttribute('data-page-url', 'https://www.bakery-notes.example/overnight-bread');
  await expect(results.nth(1)).toHaveAttribute('data-page-url', 'https://garden.example.org/tomatoes');

  // Full-text search, case- and accent-insensitive, across highlights and notes.
  const search = manager.getByTestId('search');
  await search.fill('DOUGH');
  await expect(summary).toHaveText('Pages: 1 · Highlights: 1 · Notes: 0');
  await expect(results.locator('mark')).toHaveText(['dough']);
  await search.fill('fridge');
  await expect(summary).toHaveText('Pages: 1 · Highlights: 0 · Notes: 1');
  await search.fill('turn every week');
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('Compost basics');
  await search.fill('tomatoes');
  await expect(summary).toHaveText('Pages: 1 · Highlights: 2 · Notes: 0');
  await search.fill('nothing like this anywhere');
  await expect(manager.getByText('Nothing matches your search and filters.')).toBeVisible();
  await search.fill('');

  // Color filter (several colors may be combined).
  await manager.getByTestId('filter-pink').click();
  await expect(summary).toHaveText('Pages: 2 · Highlights: 1 · Notes: 1');
  await manager.getByTestId('filter-blue').click();
  await expect(summary).toHaveText('Pages: 3 · Highlights: 1 · Notes: 2');
  await manager.getByRole('button', { name: 'Clear filters' }).click();
  await expect(summary).toHaveText('Pages: 3 · Highlights: 3 · Notes: 2');

  // Site filter ("www." is ignored).
  const site = manager.getByTestId('filter-site');
  await expect(site.locator('option')).toHaveText(['All sites', 'bakery-notes.example (1)', 'garden.example.org (2)']);
  await site.selectOption('garden.example.org');
  await expect(summary).toHaveText('Pages: 2 · Highlights: 2 · Notes: 1');
  await search.fill('shoots');
  await expect(summary).toHaveText('Pages: 1 · Highlights: 1 · Notes: 0');
  await manager.getByRole('button', { name: 'Clear filters' }).click();

  // Export everything to Markdown (a real download).
  const [markdownDownload] = await Promise.all([
    manager.waitForEvent('download'),
    manager.getByTestId('export-all-md').click(),
  ]);
  expect(markdownDownload.suggestedFilename()).toBe(`quicknotes-all-${DAY}.md`);
  const markdown = await readFile(await markdownDownload.path(), 'utf8');
  expect(
    markdown.startsWith(`# QuickNotes export\n\nExported ${DAY} · 3 pages · 3 highlights · 2 notes\n\n---\n\n`),
  ).toBe(true);
  expect(markdown).toContain('## Overnight bread\n\n<https://www.bakery-notes.example/overnight-bread>');
  expect(markdown).toContain('> Let the dough rest overnight in a cool place\n\n*Green highlight · 2026-09-20*');
  expect(markdown).toContain(
    '#### Note 1 · Pink · 2026-09-20\n\n> On: “Let the dough rest overnight in a cool place”\n\n**Try** eighteen hours in the fridge',
  );
  expect(markdown).toContain('- Browns and greens\n- Turn every week');

  // Export this one page to Markdown from its row.
  const [pageDownload] = await Promise.all([
    manager.waitForEvent('download'),
    results.nth(2).getByTestId('export-result-md').click(),
  ]);
  expect(pageDownload.suggestedFilename()).toBe(`quicknotes-garden-example-org-compost-${DAY}.md`);
  expect(await readFile(await pageDownload.path(), 'utf8')).toBe(
    '# Compost basics\n\n<https://garden.example.org/compost>\n\n## Notes (1)\n\n### Note 1 · Blue · 2026-09-20\n\n- Browns and greens\n- Turn every week\n',
  );

  // Export to JSON and import it back: merging adds nothing twice.
  const [jsonDownload] = await Promise.all([
    manager.waitForEvent('download'),
    manager.getByTestId('export-all-json').click(),
  ]);
  const backup = await jsonDownload.path();
  const parsed = JSON.parse(await readFile(backup, 'utf8')) as { format: string; version: number; pages: unknown[] };
  expect(parsed).toMatchObject({ format: 'quicknotes', version: 1 });
  expect(parsed.pages).toHaveLength(3);
  await manager.getByTestId('import-input').setInputFiles(backup);
  await expect(manager.getByTestId('import-result')).toHaveText('Imported 3 page(s): 3 highlight(s) and 2 note(s).');
  await expect(summary).toHaveText('Pages: 3 · Highlights: 3 · Notes: 2');

  // An invalid file is rejected as a whole, with the path of each problem.
  const invalid = testInfo.outputPath('invalid.json');
  await writeFile(
    invalid,
    exportFile([
      {
        url: 'https://example.net/a',
        title: 'Broken',
        updatedAt: T,
        highlights: [highlight('x1', 'purple', 'Some text')],
        notes: [],
      },
    ]),
  );
  await manager.getByTestId('import-input').setInputFiles(invalid);
  await expect(manager.getByTestId('import-result')).toContainText("This file can't be imported. Nothing was changed:");
  await expect(manager.getByTestId('import-result')).toContainText(
    'pages[0].highlights[0].color: expected one of yellow, green, blue, pink',
  );
  await expect(summary).toHaveText('Pages: 3 · Highlights: 3 · Notes: 2');

  // Deleting a whole page (two clicks).
  await results.nth(0).getByTestId('delete-page').click();
  await results.nth(0).getByTestId('delete-page').click();
  await expect(summary).toHaveText('Pages: 2 · Highlights: 2 · Notes: 1');

  expect(await harness.allErrors()).toEqual([]);
});
