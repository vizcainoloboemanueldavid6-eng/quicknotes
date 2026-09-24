/**
 * Whitelist HTML sanitizer for sticky-note content.
 *
 * Allowed elements: b strong i em ul ol li br p div — with no attributes at all.
 * Elements whose content is not prose (script, style, iframe, svg, …) are dropped
 * together with their content; any other element is unwrapped (its text and
 * allowed descendants are kept). Comments are dropped.
 *
 * The input is parsed with DOMParser, which produces an inert document (no
 * script execution, no resource loading), and the output is rebuilt node by node
 * from text nodes and freshly created whitelisted elements — nothing from the
 * input is ever re-used, so no attribute or unexpected node can survive.
 */
import { htmlToText } from './richtext';

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'b',
  'strong',
  'i',
  'em',
  'ul',
  'ol',
  'li',
  'br',
  'p',
  'div',
]);

const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'svg',
  'math',
  'head',
  'title',
  'textarea',
  'select',
  'input',
  'link',
  'meta',
  'base',
  'canvas',
]);

/**
 * Upper bound for stored note HTML (about 100,000 characters of text). The note
 * editor never saves past it: it refuses the typing or paste that would cross it
 * and tells the user (see stickyNote.tsx), so this cap only ever shortens
 * imported or hand-made data — and even then keeps the text and its line breaks.
 */
export const MAX_NOTE_HTML_LENGTH = 100_000;
const MAX_DEPTH = 40;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Depth-first copy with an explicit stack (hostile input can nest thousands of
 * levels deep; recursion could overflow). Children are pushed in reverse so they
 * are visited — and appended — in document order. Beyond MAX_DEPTH allowed
 * elements are unwrapped instead of copied, which keeps the text.
 */
function rebuild(source: Node, target: Element, doc: Document): void {
  const stack: Array<{ node: Node; target: Element; depth: number }> = [];
  const pushChildren = (node: Node, into: Element, depth: number) => {
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i] as Node, target: into, depth });
    }
  };
  pushChildren(source, target, 0);

  while (stack.length > 0) {
    const { node, target: into, depth } = stack.pop() as (typeof stack)[number];
    if (node.nodeType === TEXT_NODE) {
      into.appendChild(doc.createTextNode((node as Text).data));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;

    const tag = (node as Element).localName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;

    if (ALLOWED_TAGS.has(tag) && depth < MAX_DEPTH) {
      const clean = doc.createElement(tag);
      into.appendChild(clean);
      if (tag !== 'br') pushChildren(node, clean, depth + 1);
    } else {
      pushChildren(node, into, depth + 1);
    }
  }
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Sanitized HTML that is over the limit, as plain text with <br> line breaks
 * (one per paragraph or list item, list markers kept): as much of the text as
 * fits in `limit` characters, cut at a character boundary, never mid-entity.
 */
function plainTextWithin(html: string, limit: number): string {
  const out: string[] = [];
  let length = 0;
  for (const line of htmlToText(html).split('\n')) {
    const separator = out.length > 0 ? '<br>'.length : 0;
    const escaped = escapeText(line);
    if (length + separator + escaped.length <= limit) {
      out.push(escaped);
      length += separator + escaped.length;
      continue;
    }
    let room = limit - length - separator;
    let cut = '';
    for (const char of line) {
      const piece = escapeText(char);
      if (piece.length > room) break;
      cut += piece;
      room -= piece.length;
    }
    if (cut) out.push(cut);
    break;
  }
  return out.join('<br>');
}

export interface SanitizeOptions {
  /** Longest result allowed (default MAX_NOTE_HTML_LENGTH); `Infinity` measures without cutting. */
  maxLength?: number;
}

export function sanitizeHtml(html: string, { maxLength = MAX_NOTE_HTML_LENGTH }: SanitizeOptions = {}): string {
  if (!html) return '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const out = document.implementation.createHTMLDocument('');
  const container = out.createElement('div');
  rebuild(parsed.body, container, out);

  // An editor that only contains an empty line is an empty note.
  const result = container.innerHTML.trim();
  if (/^(?:<(?:div|p)>(?:<br>)?<\/(?:div|p)>|<br>)$/.test(result)) return '';

  return result.length > maxLength ? plainTextWithin(result, maxLength) : result;
}
