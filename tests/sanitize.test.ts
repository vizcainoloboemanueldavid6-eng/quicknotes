import { describe, expect, it } from 'vitest';
import { estimatedInsertLength } from '../src/content/stickyNote';
import { ALLOWED_TAGS, MAX_NOTE_HTML_LENGTH, sanitizeHtml } from '../src/lib/sanitize';

describe('sanitizeHtml', () => {
  it('keeps every whitelisted element', () => {
    const html =
      '<div><b>b</b><strong>strong</strong><i>i</i><em>em</em></div><p>para<br>line</p><ul><li>u</li></ul><ol><li>o</li></ol>';
    expect(sanitizeHtml(html)).toBe(html);
    expect([...ALLOWED_TAGS].sort()).toEqual(['b', 'br', 'div', 'em', 'i', 'li', 'ol', 'p', 'strong', 'ul']);
  });

  it('strips every attribute, including event handlers and styles', () => {
    expect(sanitizeHtml('<b onclick="alert(1)" style="color:red" class="x" id="y">bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeHtml('<div onmouseover="steal()" data-x="1">text</div>')).toBe('<div>text</div>');
  });

  it('drops scripts, styles and embedded content together with their content', () => {
    expect(sanitizeHtml('safe<script>alert(1)</script>')).toBe('safe');
    expect(sanitizeHtml('<style>body{display:none}</style>visible')).toBe('visible');
    expect(sanitizeHtml('<iframe src="https://example.com"></iframe>after')).toBe('after');
    expect(sanitizeHtml('<svg><script>alert(1)</script><text>x</text></svg>ok')).toBe('ok');
    expect(sanitizeHtml('yes<noscript><b>no</b></noscript>')).toBe('yes');
    // Head-only elements at the start never reach the body that is copied.
    expect(sanitizeHtml('<title>t</title><meta charset="x"><link rel="stylesheet">body')).toBe('body');
    expect(sanitizeHtml('<template><b>t</b></template>shown')).toBe('shown');
  });

  it('unwraps other elements but keeps their text', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">link text</a>')).toBe('link text');
    expect(sanitizeHtml('<span style="font-weight:700">heavy</span>')).toBe('heavy');
    expect(sanitizeHtml('<h1>Title</h1><blockquote><b>quoted</b></blockquote>')).toBe('Title<b>quoted</b>');
    expect(sanitizeHtml('<img src=x onerror="alert(1)">caption')).toBe('caption');
  });

  it('removes comments and keeps text escaped', () => {
    expect(sanitizeHtml('a<!-- secret -->b')).toBe('ab');
    expect(sanitizeHtml('1 &lt; 2 &amp;&amp; 3 &gt; 2')).toBe('1 &lt; 2 &amp;&amp; 3 &gt; 2');
    expect(sanitizeHtml('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('cannot be tricked by malformed markup', () => {
    const out = sanitizeHtml('<b><i>unclosed <script>x</script><img/src=x/onerror=alert(1)>');
    expect(out).toBe('<b><i>unclosed </i></b>');
    expect(sanitizeHtml('<<script>script>alert(1)<</script>/script>')).not.toContain('<script');
  });

  it('treats an editor that only holds an empty line as empty', () => {
    expect(sanitizeHtml('')).toBe('');
    expect(sanitizeHtml('<br>')).toBe('');
    expect(sanitizeHtml('<div><br></div>')).toBe('');
    expect(sanitizeHtml('<div>x</div>')).toBe('<div>x</div>');
  });

  it('survives very deep nesting', () => {
    const deep = `${'<div>'.repeat(3000)}deep${'</div>'.repeat(3000)}`;
    const out = sanitizeHtml(deep);
    expect(out).toContain('deep');
    expect(out.startsWith('<div>')).toBe(true);
  });

  it('caps the stored size', () => {
    const huge = `<b>${'a'.repeat(MAX_NOTE_HTML_LENGTH)}</b>`;
    const out = sanitizeHtml(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_NOTE_HTML_LENGTH);
    expect(out).not.toContain('<b>');
  });

  it('over the cap, keeps as much text as fits, with its line breaks', () => {
    // 3,000 lines of ~40 characters: about 150,000 characters of HTML.
    const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1} of a long pasted note & more`);
    const html = lines.map((line) => `<div>${line.replace('&', '&amp;')}</div>`).join('');
    expect(html.length).toBeGreaterThan(MAX_NOTE_HTML_LENGTH);

    const out = sanitizeHtml(html);
    expect(out.length).toBeLessThanOrEqual(MAX_NOTE_HTML_LENGTH);
    // Nearly the whole budget is used (not a fifth of it, as before).
    expect(out.length).toBeGreaterThan(MAX_NOTE_HTML_LENGTH - 100);
    const kept = out.split('<br>');
    expect(kept[0]).toBe('Line 1 of a long pasted note &amp; more');
    expect(kept.length).toBeGreaterThan(2000);
    // Every complete line is kept in order; only the last one may be cut.
    kept.slice(0, -1).forEach((line, i) => expect(line).toBe(`Line ${i + 1} of a long pasted note &amp; more`));
    // Never cut in the middle of an entity.
    expect(out).not.toMatch(/&(?:a|am|amp|l|lt|g|gt)?$/);
  });

  it('with maxLength: Infinity, measures without cutting (what the editor saves)', () => {
    const html = `<div>${'x'.repeat(MAX_NOTE_HTML_LENGTH)}</div>`;
    expect(sanitizeHtml(html, { maxLength: Infinity })).toBe(html);
  });
});

describe('estimatedInsertLength (paste guard of the note editor)', () => {
  it('counts escapes, line breaks and runs of spaces generously', () => {
    expect(estimatedInsertLength('plain')).toBe(5);
    expect(estimatedInsertLength('a & b')).toBe('a &amp; b'.length);
    expect(estimatedInsertLength('<tag>')).toBe('&lt;tag&lt;'.length);
    expect(estimatedInsertLength('one\ntwo')).toBe(7 + '<div></div>'.length);
    expect(estimatedInsertLength('a  b')).toBeGreaterThanOrEqual('a&nbsp; b'.length);
  });
});
