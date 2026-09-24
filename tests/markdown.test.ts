import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportFileName,
  formatDate,
  pageToMarkdown,
  pagesToMarkdown,
  parseJsonImport,
  toJsonExport,
} from '../src/lib/markdown';
import { mergeById } from '../src/lib/merge';
import { escapeMarkdown, htmlToMarkdown, htmlToText } from '../src/lib/richtext';
import type { PageData } from '../src/lib/types';
import { NOON, makeHighlight, makeNote, makePage } from './fixtures';

const DAY = formatDate(NOON);

function samplePage(): PageData {
  return makePage('https://example.com/article', {
    title: 'How *notes* work',
    highlights: [
      makeHighlight('h2', {
        color: 'green',
        anchor: {
          ...makeHighlight('x').anchor,
          quote: { exact: 'second\n   quote', prefix: '', suffix: '' },
          position: { start: 50, end: 60 },
        },
      }),
      makeHighlight('h1', {
        anchor: {
          ...makeHighlight('x').anchor,
          quote: { exact: 'first quote', prefix: '', suffix: '' },
          position: { start: 5, end: 16 },
        },
      }),
      makeHighlight('h3', {
        color: 'pink',
        orphaned: true,
        anchor: {
          ...makeHighlight('x').anchor,
          quote: { exact: 'lost text', prefix: '', suffix: '' },
          position: { start: 90, end: 99 },
        },
      }),
    ],
    notes: [
      makeNote('n1', { html: '<div><b>Remember</b> this</div><ul><li>one</li><li>two</li></ul>', highlightId: 'h1' }),
      makeNote('n2', { html: '', color: 'blue', createdAt: NOON + 1000 }),
    ],
  });
}

describe('htmlToMarkdown / htmlToText', () => {
  it('converts bold, italic and paragraphs', () => {
    expect(
      htmlToMarkdown('<div>Plain <b>bold</b> and <i>italic</i></div><div><strong><em>both</em></strong></div>'),
    ).toBe('Plain **bold** and *italic*\n\n***both***');
  });

  it('keeps whitespace outside emphasis markers', () => {
    expect(htmlToMarkdown('<b>bold </b>next')).toBe('**bold** next');
  });

  it('converts bulleted, numbered and nested lists', () => {
    const html = '<ul><li>apples</li><li>pears<ol><li>green</li><li>red</li></ol></li></ul><div>after</div>';
    expect(htmlToMarkdown(html)).toBe('- apples\n- pears\n  1. green\n  2. red\n\nafter');
    expect(htmlToText(html)).toBe('- apples\n- pears\n  1. green\n  2. red\nafter');
  });

  it('turns <br> into line breaks and decodes entities', () => {
    expect(htmlToText('one<br>two &amp; three&nbsp;four &lt;tag&gt;')).toBe('one\ntwo & three four <tag>');
  });

  it('escapes Markdown syntax found in note text', () => {
    expect(htmlToMarkdown('<div># not a heading</div><div>- not a list</div><div>1. not a list</div>')).toBe(
      '\\# not a heading\n\n\\- not a list\n\n1\\. not a list',
    );
    expect(htmlToMarkdown('a*b_c [link](x) &lt;tag&gt;')).toBe('a\\*b\\_c \\[link\\](x) \\<tag\\>');
    // Real tags are markup, not text: tags outside the whitelist are ignored.
    expect(htmlToMarkdown('before <span>inside</span> after')).toBe('before inside after');
    expect(escapeMarkdown('back\\slash `code`')).toBe('back\\\\slash \\`code\\`');
  });

  it('returns an empty string for empty notes', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToText('<div><br></div>')).toBe('');
  });
});

describe('Markdown export', () => {
  it('exports one page with highlights in page order and notes in creation order', () => {
    const md = pageToMarkdown(samplePage());
    expect(md).toBe(
      [
        '# How \\*notes\\* work',
        '<https://example.com/article>',
        '## Highlights (3)',
        '> first quote',
        `*Yellow highlight · ${DAY}*`,
        '> second quote',
        `*Green highlight · ${DAY}*`,
        '> lost text',
        `*Pink highlight · ${DAY} · not found on the page when last checked*`,
        '## Notes (2)',
        `### Note 1 · Yellow · ${DAY}`,
        '> On: “first quote”',
        '**Remember** this\n\n- one\n- two',
        `### Note 2 · Blue · ${DAY}`,
        '*(empty note)*',
      ].join('\n\n') + '\n',
    );
  });

  it('falls back to the URL when the page has no title', () => {
    const md = pageToMarkdown(makePage('https://example.com/x', { title: '  ', notes: [makeNote('n')] }));
    expect(md.startsWith('# https://example.com/x\n')).toBe(true);
  });

  it('exports all pages as sections, newest first', () => {
    const older = makePage('https://example.com/old', { title: 'Old', updatedAt: NOON, notes: [makeNote('a')] });
    const newer = makePage('https://example.com/new', {
      title: 'New',
      updatedAt: NOON + 1,
      highlights: [makeHighlight('h')],
    });
    const md = pagesToMarkdown([older, newer], new Date(NOON));
    expect(
      md.startsWith(`# QuickNotes export\n\nExported ${DAY} · 2 pages · 1 highlight · 1 note\n\n---\n\n## New`),
    ).toBe(true);
    expect(md.indexOf('## New')).toBeLessThan(md.indexOf('## Old'));
    expect(md).toContain('### Highlights (1)');
    expect(md).toContain('#### Note 1');
    expect(pagesToMarkdown([], new Date(NOON))).toBe(
      `# QuickNotes export\n\nExported ${DAY} · 0 pages · 0 highlights · 0 notes\n`,
    );
  });

  it('builds file names', () => {
    const now = new Date(NOON);
    expect(exportFileName('md', samplePage(), now)).toBe(`quicknotes-example-com-article-${DAY}.md`);
    expect(exportFileName('json', undefined, now)).toBe(`quicknotes-all-${DAY}.json`);
  });
});

describe('JSON export and import', () => {
  it('round-trips', () => {
    const pages = [samplePage(), makePage('https://example.com/b', { notes: [makeNote('b1')] })];
    const json = toJsonExport(pages, new Date(NOON));
    const parsed = JSON.parse(json) as { format: string; version: number; exportedAt: string };
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.version).toBe(EXPORT_VERSION);
    expect(parsed.exportedAt).toBe(new Date(NOON).toISOString());

    const result = parseJsonImport(json);
    expect(result).toEqual({ ok: true, pages });
  });

  it('rejects files that are not QuickNotes exports', () => {
    expect(parseJsonImport('not json')).toEqual({ ok: false, errors: ['The file is not valid JSON.'] });
    expect(parseJsonImport('[]').ok).toBe(false);
    expect(parseJsonImport('{"format":"other","version":1,"pages":[]}')).toEqual({
      ok: false,
      errors: ['This is not a QuickNotes export (format).'],
    });
    expect(parseJsonImport('{"format":"quicknotes","version":2,"pages":[]}')).toEqual({
      ok: false,
      errors: ['Unsupported export version 2; expected 1.'],
    });
    expect(parseJsonImport('{"format":"quicknotes","version":1}')).toEqual({
      ok: false,
      errors: ['pages: expected a list'],
    });
  });

  it('reports every invalid field with its path and imports nothing', () => {
    const page = samplePage() as unknown as Record<string, unknown>;
    const bad = {
      format: 'quicknotes',
      version: 1,
      pages: [
        {
          ...page,
          url: 'javascript:alert(1)',
          highlights: [
            { ...makeHighlight('h1'), color: 'purple' },
            { ...makeHighlight('h2'), anchor: { quote: { exact: '' } } },
          ],
          notes: [{ ...makeNote('n1'), position: { x: 'left', y: 0 }, minimized: 'no' }],
        },
      ],
    };
    const result = parseJsonImport(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'pages[0].url: expected an http(s) or file URL',
        'pages[0].highlights[0].color: expected one of yellow, green, blue, pink',
        'pages[0].highlights[1].anchor.quote.exact: expected non-empty text of at most 20000 characters',
        'pages[0].highlights[1].anchor.start: expected an object with xpath and offset',
        'pages[0].notes[0].position: expected { x, y } as percentages',
        'pages[0].notes[0].minimized: expected true or false',
      ]),
    );
  });

  it('limits the number of reported errors', () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({ ...makeNote(`n${i}`), color: 'rainbow' }));
    const result = parseJsonImport(
      JSON.stringify({
        format: 'quicknotes',
        version: 1,
        pages: [makePage('https://example.com', { notes } as never)],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(21);
    expect(result.errors[20]).toBe('…and 10 more');
  });

  it('rejects duplicate ids and malformed XPaths', () => {
    const page = makePage('https://example.com/', {
      notes: [makeNote('same'), makeNote('same')],
      highlights: [
        makeHighlight('h', {
          anchor: { ...makeHighlight('h').anchor, start: { xpath: '//script', offset: 0 } },
        }),
      ],
    });
    const result = parseJsonImport(JSON.stringify({ format: 'quicknotes', version: 1, pages: [page] }));
    expect(result).toEqual({
      ok: false,
      errors: [
        'pages[0].highlights[0].anchor.start.xpath: expected an element path such as /html[1]/body[1]/p[2]',
        'pages[0]: duplicate id "same"',
      ],
    });
  });

  it('sanitizes note HTML, normalizes URLs, clamps positions and merges duplicate pages', () => {
    const file = {
      format: 'quicknotes',
      version: 1,
      pages: [
        makePage('https://Example.com/a/?utm_source=x#top', {
          notes: [
            makeNote('n1', {
              html: '<b onclick="steal()">hi</b><script>alert(1)</script>',
              position: { x: 140, y: -5 },
              size: { width: 5000, height: 10 },
            }),
          ],
        }),
        makePage('https://example.com/a', { title: 'Newer title', updatedAt: NOON + 1, notes: [makeNote('n2')] }),
      ],
    };
    const result = parseJsonImport(JSON.stringify(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toHaveLength(1);
    const [page] = result.pages;
    expect(page?.url).toBe('https://example.com/a');
    expect(page?.title).toBe('Newer title');
    expect(page?.notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(page?.notes[0]?.html).toBe('<b>hi</b>');
    expect(page?.notes[0]?.position).toEqual({ x: 100, y: 0 });
    expect(page?.notes[0]?.size).toEqual({ width: 640, height: 110 });
  });

  it('mergeById keeps the most recently updated copy', () => {
    const merged = mergeById(
      [
        { id: 'a', updatedAt: 1, v: 'old' },
        { id: 'b', updatedAt: 5, v: 'mine' },
      ],
      [
        { id: 'a', updatedAt: 2, v: 'new' },
        { id: 'b', updatedAt: 4, v: 'theirs' },
        { id: 'c', updatedAt: 1, v: 'added' },
      ],
    );
    expect(merged.map((item) => item.v)).toEqual(['new', 'mine', 'added']);
  });
});
