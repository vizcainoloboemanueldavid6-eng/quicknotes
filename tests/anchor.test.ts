import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_LENGTH,
  HIGHLIGHT_TAG,
  buildTextIndex,
  describeOffsets,
  describeRange,
  findText,
  rangeFromOffsets,
  resolveAnchor,
  resolveXPath,
  similarity,
  xpathOf,
  type TextIndex,
} from '../src/content/anchor';
import { marksFor, recolorMarks, removeAllMarks, removeMarks, wrapOffsets } from '../src/content/highlighter';
import type { Anchor } from '../src/lib/types';

function setBody(html: string): TextIndex {
  document.body.innerHTML = html;
  return buildTextIndex(document.body);
}

/** Anchor for the n-th occurrence of `text` on the current page. */
function anchorFor(text: string, occurrence = 0): Anchor {
  const index = buildTextIndex(document.body);
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = index.text.indexOf(text, at + 1);
  if (at === -1) throw new Error(`"${text}" #${occurrence} not found`);
  const range = rangeFromOffsets(index, at, at + text.length, document);
  if (!range) throw new Error('no range');
  const anchor = describeRange(range, index);
  if (!anchor) throw new Error('no anchor');
  return anchor;
}

function resolvedText(anchor: Anchor): string | null {
  const index = buildTextIndex(document.body);
  const found = resolveAnchor(anchor, index, document);
  return found ? index.text.slice(found.start, found.end) : null;
}

function contextOf(anchor: Anchor): { before: string; after: string } | null {
  const index = buildTextIndex(document.body);
  const found = resolveAnchor(anchor, index, document);
  if (!found) return null;
  return {
    before: index.text.slice(Math.max(0, found.start - 12), found.start),
    after: index.text.slice(found.end, found.end + 12),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('text index', () => {
  it('concatenates page text and skips non-prose elements', () => {
    const index = setBody(
      '<p>Visible <b>bold</b> text.</p><script>var hidden = 1;</script><style>p{}</style>' +
        '<textarea>draft</textarea><quicknotes-root>ui text</quicknotes-root><p>End</p>',
    );
    expect(index.text).toBe('Visible bold text.End');
    expect(index.nodes).toHaveLength(4);
    expect(index.starts).toEqual([0, 8, 12, 18]);
  });

  it('leaves out SVG and MathML text, which an HTML mark would make disappear', () => {
    const index = setBody(
      '<p>Before the chart.</p><svg width="400" height="60"><text x="10" y="30">Chart label</text>' +
        '<foreignObject><p>inside svg</p></foreignObject></svg>' +
        '<math><mi>x</mi><mo>=</mo><mn>2</mn></math><p>After the chart.</p>',
    );
    expect(index.text).toBe('Before the chart.After the chart.');
  });

  it('leaves out editable regions of the page, but not contenteditable="false" ones', () => {
    const index = setBody(
      '<p>Read me.</p><div contenteditable="true">draft <b>text</b></div><div contenteditable>more</div>' +
        '<div contenteditable="plaintext-only">plain</div><div contenteditable="false">fixed</div><p>End.</p>',
    );
    expect(index.text).toBe('Read me.fixedEnd.');
  });

  it('a highlight across a chart and an editor wraps neither of them', () => {
    const html =
      '<p id="before">Text before the chart caption.</p>' +
      '<svg width="400" height="60"><text id="label" x="10" y="30">Chart label inside SVG</text></svg>' +
      '<div id="editor" contenteditable="true">editable page content</div>' +
      '<p id="after">Text after the chart caption.</p>';
    const index = setBody(html);
    const range = document.createRange();
    const before = document.getElementById('before')?.firstChild as Text;
    const after = document.getElementById('after')?.firstChild as Text;
    range.setStart(before, 0);
    range.setEnd(after, 'Text after'.length);
    const anchor = describeRange(range, index);
    expect(anchor?.quote.exact).toBe('Text before the chart caption.Text after');
    if (!anchor) return;
    const marks = wrapOffsets(index, anchor.position.start, anchor.position.end, 'h', 'yellow');
    expect(marks.map((mark) => mark.textContent)).toEqual(['Text before the chart caption.', 'Text after']);
    expect(document.getElementById('label')?.innerHTML).toBe('Chart label inside SVG');
    expect(document.getElementById('editor')?.innerHTML).toBe('editable page content');
  });

  it('a selection that ends inside an editor stops before it', () => {
    const index = setBody('<p id="p">Plain text here.</p><div id="ce" contenteditable="true">typed words</div>');
    const range = document.createRange();
    range.setStart(document.getElementById('p')?.firstChild as Text, 6);
    range.setEnd(document.getElementById('ce')?.firstChild as Text, 5);
    expect(describeRange(range, index)?.quote.exact).toBe('text here.');
  });
});

describe('describeRange', () => {
  it('stores the quote with up to 32 characters of context and XPath fallbacks', () => {
    setBody(
      '<article><h1>Title</h1><p>The first paragraph sets the scene for everything that follows.</p>' +
        '<p>Second paragraph: the quick brown fox jumps over the lazy dog, as usual.</p></article>',
    );
    const anchor = anchorFor('quick brown fox');
    expect(anchor.quote.exact).toBe('quick brown fox');
    expect(anchor.quote.prefix).toHaveLength(CONTEXT_LENGTH);
    expect(anchor.quote.prefix.endsWith('Second paragraph: the ')).toBe(true);
    expect(anchor.quote.suffix).toBe(' jumps over the lazy dog, as usu');
    expect(anchor.start).toEqual({ xpath: '/html[1]/body[1]/article[1]/p[2]', offset: 22 });
    expect(anchor.end).toEqual({ xpath: '/html[1]/body[1]/article[1]/p[2]', offset: 37 });
    expect(anchor.position.end - anchor.position.start).toBe(15);
  });

  it('trims surrounding whitespace and rejects empty selections', () => {
    const index = setBody('<p>one</p>\n   <p>two</p>');
    const blank = rangeFromOffsets(index, 3, 7, document);
    expect(blank && describeRange(blank, index)).toBeNull();

    const range = document.createRange();
    const [first, second] = Array.from(document.querySelectorAll('p'));
    range.setStart(first as Element, 0);
    range.setEnd(second as Element, 1);
    const anchor = describeRange(range, index);
    expect(anchor?.quote.exact).toBe('one\n   two');
  });

  it('handles element boundary points', () => {
    const index = setBody('<p id="a">Alpha <em>beta</em> gamma</p><p>Delta</p>');
    const p = document.getElementById('a') as HTMLElement;
    const range = document.createRange();
    range.setStart(p, 1); // before <em>
    range.setEnd(p, p.childNodes.length); // end of the paragraph
    expect(describeRange(range, index)?.quote.exact).toBe('beta gamma');
  });

  it('spans several elements', () => {
    setBody('<p>Alpha <b>beta</b> gamma</p><ul><li>one</li><li>two</li></ul>');
    const anchor = anchorFor('pha beta gam');
    expect(anchor.start.xpath).toBe('/html[1]/body[1]/p[1]');
    expect(resolvedText(anchor)).toBe('pha beta gam');

    const crossing = anchorFor('gammaone');
    expect(crossing.start.xpath).toBe('/html[1]/body[1]/p[1]');
    expect(crossing.end.xpath).toBe('/html[1]/body[1]/ul[1]/li[1]');
  });
});

describe('resolveAnchor', () => {
  it('finds the quote after the text around it changed', () => {
    setBody('<p>Intro.</p><p>Our study shows that sleep improves memory in adults.</p>');
    const anchor = anchorFor('sleep improves memory');

    setBody(
      '<header>Breaking: new banner</header><p>Intro, rewritten.</p>' +
        '<p>A 2026 follow-up confirms that <em>sleep improves memory</em> in most adults and teens.</p>',
    );
    const index = buildTextIndex(document.body);
    const found = resolveAnchor(anchor, index, document);
    expect(found?.method).toBe('quote');
    expect(found && index.text.slice(found.start, found.end)).toBe('sleep improves memory');
  });

  it('disambiguates a repeated quote with its context', () => {
    setBody(
      '<p>In the first chapter the answer is 42, said the robot.</p>' +
        '<p>Later the teacher claimed the answer is 42 without proof.</p>' +
        '<p>Finally the answer is 42 appears in the appendix.</p>',
    );
    const second = anchorFor('the answer is 42', 1);
    expect(second.quote.prefix).toContain('Later the teacher claimed');

    // A new occurrence is inserted before all of them and the order changes.
    setBody(
      '<p>Spoiler: the answer is 42.</p>' +
        '<p>Finally the answer is 42 appears in the appendix.</p>' +
        '<p>In the first chapter the answer is 42, said the robot.</p>' +
        '<p>Later the teacher claimed the answer is 42 without proof.</p>',
    );
    const index = buildTextIndex(document.body);
    const found = resolveAnchor(second, index, document);
    expect(found?.method).toBe('context');
    expect(contextOf(second)).toEqual({ before: 'her claimed ', after: ' without pro' });
  });

  it('uses the original position to break ties between identical contexts', () => {
    const repeated = '<p>same same same</p>'.repeat(3);
    setBody(repeated);
    const third = anchorFor('same same same', 2);
    const index = buildTextIndex(document.body);
    const found = resolveAnchor(third, index, document);
    expect(found?.start).toBe(third.position.start);
  });

  it('ignores whitespace differences', () => {
    setBody('<p>Line one\n      continues here.</p>');
    const anchor = anchorFor('one\n      continues');
    setBody('<p>Line one continues here.</p>');
    expect(resolvedText(anchor)).toBe('one continues');
  });

  it('falls back to the XPath when the quote was slightly edited', () => {
    setBody('<main><p>Header</p><p>The committee will recieve the final report on Monday.</p></main>');
    const anchor = anchorFor('will recieve the final report');
    setBody('<main><p>Header</p><p>The committee will receive the final report on Monday.</p></main>');
    const index = buildTextIndex(document.body);
    const found = resolveAnchor(anchor, index, document);
    expect(found?.method).toBe('xpath');
    expect(found && index.text.slice(found.start, found.end)).toBe('will receive the final report');
  });

  it('detects orphans: the quoted text is gone', () => {
    setBody('<p>Keep this.</p><p>This sentence will be deleted by the author.</p>');
    const anchor = anchorFor('will be deleted');
    setBody('<p>Keep this.</p><p>Completely different words now.</p>');
    expect(resolvedText(anchor)).toBeNull();
  });

  it('detects orphans: the structure is gone too', () => {
    setBody('<section><div><p>Deep text to highlight here</p></div></section>');
    const anchor = anchorFor('text to highlight');
    setBody('<p>Nothing left</p>');
    expect(resolvedText(anchor)).toBeNull();
  });

  it('never returns an empty match', () => {
    setBody('<p>abc</p>');
    const anchor = anchorFor('abc');
    const blank: Anchor = { ...anchor, quote: { ...anchor.quote, exact: '   ' } };
    expect(resolveAnchor(blank, buildTextIndex(document.body), document)).toBeNull();
  });
});

describe('findText', () => {
  it('finds every occurrence, whitespace-insensitively', () => {
    const index = setBody('<p>Hello   big\n world.</p><p>Hello big world again.</p>');
    const found = findText(index, 'Hello big world');
    expect(found).toHaveLength(2);
    expect(found.map(({ start, end }) => index.text.slice(start, end))).toEqual([
      'Hello   big\n world',
      'Hello big world',
    ]);
    expect(findText(index, '   ')).toEqual([]);
    expect(findText(index, 'absent')).toEqual([]);
  });
});

describe('XPath helpers', () => {
  it('builds and resolves element paths', () => {
    setBody('<div></div><div><p>a</p><span></span><p id="target">b</p></div>');
    const target = document.getElementById('target') as HTMLElement;
    const xpath = xpathOf(target);
    expect(xpath).toBe('/html[1]/body[1]/div[2]/p[2]');
    expect(resolveXPath(xpath, document)).toBe(target);
    expect(resolveXPath('/html[1]/body[1]/div[3]', document)).toBeNull();
    expect(resolveXPath('/svg[1]/body[1]', document)).toBeNull();
    expect(resolveXPath('not an xpath', document)).toBeNull();
  });

  it('similarity is 1 for equal strings and low for unrelated ones', () => {
    expect(similarity('receive', 'receive')).toBe(1);
    expect(similarity('recieve', 'receive')).toBeGreaterThan(0.7);
    expect(similarity('apples', 'zebra crossing')).toBeLessThan(0.3);
    expect(similarity('', 'x')).toBe(0);
  });
});

describe('highlight elements', () => {
  it('wraps a range across several text nodes without changing the page text', () => {
    const index = setBody('<p>Alpha <b>beta</b> gamma</p>');
    const before = index.text;
    const anchor = anchorFor('pha beta gam');
    const marks = wrapOffsets(index, anchor.position.start, anchor.position.end, 'h1', 'green');
    expect(marks).toHaveLength(3);
    expect(marks.map((mark) => mark.textContent).join('')).toBe('pha beta gam');
    expect(marks.every((mark) => mark.localName === HIGHLIGHT_TAG)).toBe(true);
    expect(marks[0]?.getAttribute('data-qn-color')).toBe('green');
    expect(marks[0]?.style.getPropertyValue('background-color')).not.toBe('');
    expect(marks[0]?.style.getPropertyPriority('background-color')).toBe('important');
    expect(buildTextIndex(document.body).text).toBe(before);
  });

  it('keeps the index usable for further highlights, including overlapping ones', () => {
    const index = setBody('<p>0123456789abcdefghij</p>');
    wrapOffsets(index, 2, 6, 'a', 'yellow');
    wrapOffsets(index, 10, 14, 'b', 'blue');
    wrapOffsets(index, 4, 12, 'c', 'pink');
    const text = (id: string) =>
      marksFor(id)
        .map((mark) => mark.textContent)
        .join('');
    expect(text('a')).toBe('2345');
    expect(text('b')).toBe('abcd');
    expect(text('c')).toBe('456789ab');
    expect(buildTextIndex(document.body).text).toBe('0123456789abcdefghij');
  });

  it('does not wrap layout whitespace inside lists and tables', () => {
    const index = setBody('<ul>\n  <li>first</li>\n  <li>second</li>\n</ul>');
    const start = index.text.indexOf('first');
    const end = index.text.indexOf('second') + 'second'.length;
    const marks = wrapOffsets(index, start, end, 'h', 'yellow');
    expect(marks.map((mark) => mark.parentElement?.localName)).toEqual(['li', 'li']);
  });

  it('anchors made next to existing highlights ignore the highlight elements', () => {
    const index = setBody('<article><p>One two three four five six.</p></article>');
    const first = anchorFor('two three');
    wrapOffsets(index, first.position.start, first.position.end, 'first', 'yellow');

    const second = anchorFor('five');
    expect(second.start.xpath).toBe('/html[1]/body[1]/article[1]/p[1]');
    expect(second.start.offset).toBe('One two three four '.length);

    // On a clean copy of the page (no marks) with the quote edited ("five" →
    // "fiv"), the saved anchor still resolves through its XPath fallback:
    // "fiv" is 75 % similar to "five", exactly the threshold.
    const clean = setBody('<article><p>One two three four fiv six.</p></article>');
    const found = resolveAnchor(second, clean, document);
    expect(found?.method).toBe('xpath');
    expect(found && clean.text.slice(found.start, found.end).trim()).toBe('fiv');
    // A fresh anchor on the clean page describes the same element and offset.
    expect(describeOffsets(clean, 19, 22)?.start).toEqual(second.start);
  });

  it('removing a highlight restores the original DOM', () => {
    const original = '<p>Alpha <b>beta</b> gamma <i>delta</i></p>';
    const index = setBody(original);
    const anchor = anchorFor('ha beta gamma de');
    wrapOffsets(index, anchor.position.start, anchor.position.end, 'h1', 'yellow');
    expect(document.body.innerHTML).not.toBe(original);
    removeMarks('h1');
    expect(document.body.innerHTML).toBe(original);
    const p = document.querySelector('p') as HTMLElement;
    expect(p.childNodes).toHaveLength(4); // text nodes were merged back
  });

  it('finds, recolors and removes marks whatever their id contains', () => {
    const index = setBody('<p>one two three</p>');
    const odd = 'line\nbreak "quoted" \\ ]';
    wrapOffsets(index, 0, 3, odd, 'yellow');
    wrapOffsets(index, 8, 13, 'plain', 'blue');
    expect(marksFor(odd).map((mark) => mark.textContent)).toEqual(['one']);
    recolorMarks(odd, 'pink');
    expect(marksFor(odd)[0]?.getAttribute('data-qn-color')).toBe('pink');
    removeMarks(odd);
    expect(marksFor(odd)).toHaveLength(0);
    expect(marksFor('plain')).toHaveLength(1);
  });

  it('removes only the requested highlight, or all of them', () => {
    const index = setBody('<p>one two three</p>');
    wrapOffsets(index, 0, 3, 'x', 'yellow');
    wrapOffsets(index, 8, 13, 'y', 'blue');
    removeMarks('x');
    expect(marksFor('x')).toHaveLength(0);
    expect(marksFor('y')).toHaveLength(1);
    removeAllMarks();
    expect(document.body.innerHTML).toBe('<p>one two three</p>');
  });

  it('restoring after a reload puts the highlight on the same text', () => {
    const html = '<article><h2>Notes</h2><p>Highlights are stored with context so they reappear.</p></article>';
    setBody(html);
    const anchor = anchorFor('stored with context');

    // "Reload": fresh DOM, then restore.
    const index = setBody(html);
    const found = resolveAnchor(anchor, index, document);
    expect(found).not.toBeNull();
    if (!found) return;
    const marks = wrapOffsets(index, found.start, found.end, 'h1', 'yellow');
    expect(marks.map((mark) => mark.textContent).join('')).toBe('stored with context');
  });
});
