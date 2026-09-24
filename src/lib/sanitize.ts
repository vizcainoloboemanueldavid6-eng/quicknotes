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

/** Upper bound for stored note HTML; anything longer is cut down to plain text. */
export const MAX_NOTE_HTML_LENGTH = 50_000;
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

export function sanitizeHtml(html: string): string {
  if (!html) return '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const out = document.implementation.createHTMLDocument('');
  const container = out.createElement('div');
  rebuild(parsed.body, container, out);

  // An editor that only contains an empty line is an empty note.
  const result = container.innerHTML.trim();
  if (/^(?:<(?:div|p)>(?:<br>)?<\/(?:div|p)>|<br>)$/.test(result)) return '';

  if (result.length > MAX_NOTE_HTML_LENGTH) {
    // Worst case every character becomes "&amp;" (5 chars), so a fifth always fits.
    const text = (container.textContent ?? '').slice(0, MAX_NOTE_HTML_LENGTH / 5);
    return escapeText(text);
  }
  return result;
}
