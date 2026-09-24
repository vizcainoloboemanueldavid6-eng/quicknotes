/**
 * DOM-free conversion of sanitized note HTML (see sanitize.ts) to plain text and
 * to Markdown. Works in any context — including the service worker, which has
 * no DOMParser — because the input is restricted to a handful of attribute-less
 * tags. Anything else is ignored rather than trusted.
 */

type Token = { kind: 'open'; tag: string } | { kind: 'close'; tag: string } | { kind: 'text'; text: string };

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of html.matchAll(TAG_RE)) {
    const index = match.index;
    if (index > last) tokens.push({ kind: 'text', text: decodeEntities(html.slice(last, index)) });
    last = index + match[0].length;
    const name = match[2];
    if (!name) continue; // comment
    tokens.push({ kind: match[1] ? 'close' : 'open', tag: name.toLowerCase() });
  }
  if (last < html.length) tokens.push({ kind: 'text', text: decodeEntities(html.slice(last)) });
  return tokens;
}

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface Line {
  kind: 'para' | 'item' | 'blank';
  indent: string;
  marker: string;
  segments: Segment[];
}

interface ListContext {
  ordered: boolean;
  counter: number;
  /** Indentation for the content of this list's items. */
  indent: string;
  /** Indentation for lists nested inside the current item. */
  childIndent: string;
}

/** Splits note HTML into lines (paragraphs, list items, explicit blank lines). */
function toLines(html: string): Line[] {
  const lines: Line[] = [];
  const lists: ListContext[] = [];
  let bold = 0;
  let italic = 0;
  let current: Line | null = null;

  const contentIndent = () => lists[lists.length - 1]?.childIndent ?? '';
  const flush = (keepEmpty = false) => {
    if (current) {
      const hasText = current.segments.some((s) => s.text.trim() !== '');
      if (hasText || current.kind === 'item') lines.push(current);
      else if (keepEmpty) lines.push({ ...current, kind: 'blank', segments: [] });
    } else if (keepEmpty) {
      lines.push({ kind: 'blank', indent: '', marker: '', segments: [] });
    }
    current = null;
  };

  for (const token of tokenize(html)) {
    if (token.kind === 'text') {
      current ??= { kind: 'para', indent: contentIndent(), marker: '', segments: [] };
      current.segments.push({ text: token.text, bold: bold > 0, italic: italic > 0 });
      continue;
    }
    const { tag } = token;
    const opening = token.kind === 'open';
    switch (tag) {
      case 'b':
      case 'strong':
        bold = Math.max(0, bold + (opening ? 1 : -1));
        break;
      case 'i':
      case 'em':
        italic = Math.max(0, italic + (opening ? 1 : -1));
        break;
      case 'br':
        if (opening) flush(true);
        break;
      case 'p':
      case 'div':
        flush();
        break;
      case 'ul':
      case 'ol':
        flush();
        if (opening) {
          const indent = contentIndent();
          lists.push({ ordered: tag === 'ol', counter: 0, indent, childIndent: indent });
        } else {
          lists.pop();
        }
        break;
      case 'li': {
        flush();
        const list = lists[lists.length - 1];
        if (opening) {
          const marker = list?.ordered ? `${++list.counter}. ` : '- ';
          const indent = list?.indent ?? '';
          if (list) list.childIndent = indent + ' '.repeat(marker.length);
          current = { kind: 'item', indent, marker, segments: [] };
        }
        break;
      }
      default:
        break;
    }
  }
  flush();
  return lines;
}

/** Collapses HTML whitespace across segment boundaries and trims the line. */
function collapseSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  let lastWasSpace = true; // trims leading whitespace
  for (const segment of segments) {
    let text = '';
    for (const ch of segment.text.replace(/[ \t\n\r\f]+/g, ' ')) {
      if (ch === ' ') {
        if (!lastWasSpace) text += ' ';
        lastWasSpace = true;
      } else {
        text += ch === ' ' ? ' ' : ch;
        lastWasSpace = false;
      }
    }
    if (!text) continue;
    const previous = out[out.length - 1];
    if (previous && previous.bold === segment.bold && previous.italic === segment.italic) {
      previous.text += text;
    } else {
      out.push({ ...segment, text });
    }
  }
  const tail = out[out.length - 1];
  if (tail) {
    tail.text = tail.text.replace(/ +$/, '');
    if (!tail.text) out.pop();
  }
  return out;
}

/** Plain text: one line per paragraph / list item, list markers kept. */
export function htmlToText(html: string): string {
  return toLines(html)
    .map((line) =>
      line.kind === 'blank'
        ? ''
        : `${line.indent}${line.marker}${collapseSegments(line.segments)
            .map((s) => s.text)
            .join('')}`,
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escapes characters that would otherwise be read as Markdown syntax. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^(\s*)(#{1,6}\s)/, '$1\\$2')
    .replace(/^(\s*)([-+]\s)/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)]\s)/, '$1$2\\$3');
}

function renderInline(segments: Segment[]): string {
  return segments
    .map((segment, index) => {
      if (!segment.bold && !segment.italic) {
        return index === 0 ? escapeMarkdown(segment.text) : escapeInline(segment.text);
      }
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.text);
      const [, lead = '', core = '', trail = ''] = match ?? [];
      if (!core) return segment.text;
      const fence = segment.bold && segment.italic ? '***' : segment.bold ? '**' : '*';
      return `${lead}${fence}${escapeInline(core)}${fence}${trail}`;
    })
    .join('');
}

/** Like escapeMarkdown but without the line-start rules (for text in the middle of a line). */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]<>|])/g, '\\$1');
}

/** Markdown with **bold**, *italic*, "- " and "1. " lists (nested lists indented). */
export function htmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  let previousKind: Line['kind'] | null = null;
  for (const line of toLines(html)) {
    if (line.kind === 'blank') {
      previousKind = 'blank';
      continue;
    }
    const text = `${line.indent}${line.marker}${renderInline(collapseSegments(line.segments))}`;
    if (line.kind === 'item' && previousKind === 'item' && blocks.length > 0) {
      blocks[blocks.length - 1] += `\n${text}`;
    } else {
      blocks.push(text);
    }
    previousKind = line.kind;
  }
  return blocks.join('\n\n').trim();
}
