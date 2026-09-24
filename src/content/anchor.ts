/**
 * Robust anchoring of highlights.
 *
 * A highlight is saved as:
 *   1. the exact quote plus up to CONTEXT_LENGTH characters before and after it;
 *   2. the XPath of the element containing each end, with a character offset
 *      into that element's text (fallback);
 *   3. the character position in the page text (tie-breaker only).
 *
 * Everything is computed on a *text index*: the concatenated text of every text
 * node under the root, skipping script/style/etc. QuickNotes' own highlight
 * elements only split text nodes, so they never change the indexed text — which
 * is what lets anchors survive highlights being added or removed around them.
 *
 * Resolution order:
 *   a. search the quote in the page text, whitespace-insensitively;
 *   b. if it occurs more than once, pick the occurrence whose surrounding text
 *      best matches the saved prefix/suffix (then the closest to the saved position);
 *   c. if it does not occur at all, try the XPath + offsets and accept the result
 *      only if its text is still similar to the quote (≥ 75 %);
 *   d. otherwise the highlight is orphaned.
 */
import type { Anchor, XPathPoint } from '../lib/types';

export const CONTEXT_LENGTH = 32;
export const HIGHLIGHT_TAG = 'quicknotes-mark';
export const HOST_TAG = 'quicknotes-root';
/** Minimum similarity for the XPath fallback to be trusted. */
export const XPATH_MIN_SIMILARITY = 0.75;
const MAX_CANDIDATES = 5_000;

// DOM constants as numbers so this module does not depend on globals.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;
const DOCUMENT_POSITION_FOLLOWING = 4;
const DOCUMENT_POSITION_CONTAINED_BY = 16;

/** Elements whose text is not page prose. */
const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
  'select',
  'iframe',
  'object',
  HOST_TAG,
]);

export interface TextIndex {
  root: Node;
  /** Concatenated text of every indexed text node. */
  text: string;
  /** Indexed text nodes in document order. */
  nodes: Text[];
  /** starts[i] is the offset of nodes[i] in `text`. */
  starts: number[];
  /** Start offset of each indexed node (survives splicing, unlike array positions). */
  startOf: Map<Text, number>;
  /** Lazily built whitespace-collapsed view of `text`. */
  normalized?: NormalizedText;
}

interface NormalizedText {
  text: string;
  /** map[i] = index in the raw text of the i-th normalized character. */
  map: Int32Array;
}

export function buildTextIndex(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
    acceptNode(node: Node) {
      if (node.nodeType === ELEMENT_NODE) {
        return SKIPPED_TAGS.has((node as Element).localName) ? FILTER_REJECT : FILTER_SKIP;
      }
      return FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  const startOf = new Map<Text, number>();
  const parts: string[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push(text);
    starts.push(offset);
    startOf.set(text, offset);
    parts.push(text.data);
    offset += text.data.length;
  }
  return { root, text: parts.join(''), nodes, starts, startOf };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Smallest i for which `predicate(nodes[i])` holds, assuming it is monotonic. */
function lowerBound(nodes: readonly Text[], predicate: (node: Text) => boolean): number {
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (predicate(nodes[mid] as Text)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function offsetAt(index: TextIndex, i: number): number {
  return i < index.nodes.length ? (index.starts[i] as number) : index.text.length;
}

/** Text offset of the first indexed character at or after `node` (including inside it). */
export function offsetAtOrAfter(index: TextIndex, node: Node): number {
  const i = lowerBound(
    index.nodes,
    (candidate) => candidate === node || (node.compareDocumentPosition(candidate) & DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  return offsetAt(index, i);
}

/** Text offset of the first indexed character after `node` and everything inside it. */
export function offsetAfter(index: TextIndex, node: Node): number {
  const i = lowerBound(index.nodes, (candidate) => {
    const position = node.compareDocumentPosition(candidate);
    return (position & DOCUMENT_POSITION_FOLLOWING) !== 0 && (position & DOCUMENT_POSITION_CONTAINED_BY) === 0;
  });
  return offsetAt(index, i);
}

/** Converts a DOM boundary point (as found in a Range) to a text offset. */
export function pointToOffset(index: TextIndex, container: Node, offset: number): number {
  if (container.nodeType === TEXT_NODE) {
    const start = index.startOf.get(container as Text);
    if (start !== undefined) return start + Math.min(offset, (container as Text).data.length);
    return offsetAtOrAfter(index, container);
  }
  const child = container.childNodes[offset];
  return child ? offsetAtOrAfter(index, child) : offsetAfter(index, container);
}

/** Index of the text node holding character `offset` (for starts) or ending at it (for ends). */
export function nodeIndexAt(index: TextIndex, offset: number, edge: 'start' | 'end'): number {
  const { starts, nodes } = index;
  let lo = 0;
  let hi = nodes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const start = starts[mid] as number;
    const end = start + (nodes[mid] as Text).data.length;
    const inside = edge === 'start' ? offset >= start && offset < end : offset > start && offset <= end;
    if (inside) {
      found = mid;
      // Prefer the first node for ends and the last candidate for starts
      // (empty text nodes can share an offset).
      if (edge === 'start') lo = mid + 1;
      else hi = mid - 1;
    } else if (offset < start || (edge === 'end' && offset === start)) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// XPath
// ---------------------------------------------------------------------------

/** Absolute, element-only XPath such as /html[1]/body[1]/article[1]/p[3]. */
export function xpathOf(element: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const name = node.localName;
    let position = 1;
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.localName === name) position++;
    }
    parts.push(`${name}[${position}]`);
  }
  return `/${parts.reverse().join('/')}`;
}

export function resolveXPath(xpath: string, doc: Document): Element | null {
  const parts = xpath.split('/').filter(Boolean);
  let node: Element | null = null;
  for (const part of parts) {
    const match = /^([^[\]]+)\[(\d+)\]$/.exec(part);
    if (!match) return null;
    const name = match[1] as string;
    const position = Number(match[2]);
    if (!node) {
      const rootElement = doc.documentElement;
      if (rootElement.localName !== name || position !== 1) return null;
      node = rootElement;
      continue;
    }
    let count = 0;
    let next: Element | null = null;
    for (const child of Array.from(node.children)) {
      if (child.localName === name && ++count === position) {
        next = child;
        break;
      }
    }
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Nearest element around a text node that is not one of our highlight elements. */
function containerElement(node: Node): Element | null {
  let element = node.parentElement;
  while (element && element.localName === HIGHLIGHT_TAG) element = element.parentElement;
  return element;
}

function xpathPoint(index: TextIndex, offset: number, edge: 'start' | 'end'): XPathPoint | null {
  const i = nodeIndexAt(index, offset, edge);
  if (i === -1) return null;
  const element = containerElement(index.nodes[i] as Text);
  if (!element) return null;
  return { xpath: xpathOf(element), offset: offset - offsetAtOrAfter(index, element) };
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Builds an anchor for a DOM range, or null when the range holds no text.
 * Leading and trailing whitespace is trimmed from the quote.
 */
export function describeRange(range: Range, index: TextIndex): Anchor | null {
  const { text } = index;
  let start = pointToOffset(index, range.startContainer, range.startOffset);
  let end = pointToOffset(index, range.endContainer, range.endOffset);
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  if (end <= start) return null;
  return describeOffsets(index, start, end);
}

export function describeOffsets(index: TextIndex, start: number, end: number): Anchor | null {
  const { text } = index;
  const startPoint = xpathPoint(index, start, 'start');
  const endPoint = xpathPoint(index, end, 'end');
  if (!startPoint || !endPoint) return null;
  return {
    quote: {
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: text.slice(end, end + CONTEXT_LENGTH),
    },
    start: startPoint,
    end: endPoint,
    position: { start, end },
  };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export type AnchorMethod = 'quote' | 'context' | 'xpath';

export interface Resolution {
  start: number;
  end: number;
  method: AnchorMethod;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function normalized(index: TextIndex): NormalizedText {
  if (index.normalized) return index.normalized;
  const raw = index.text;
  const map = new Int32Array(raw.length);
  const parts: string[] = [];
  let n = 0;
  let from = 0;
  for (const match of raw.matchAll(/\s+/g)) {
    for (let i = from; i < match.index; i++) map[n++] = i;
    parts.push(raw.slice(from, match.index), ' ');
    map[n++] = match.index;
    from = match.index + match[0].length;
  }
  for (let i = from; i < raw.length; i++) map[n++] = i;
  parts.push(raw.slice(from));
  index.normalized = { text: parts.join(''), map: map.subarray(0, n) };
  return index.normalized;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** 1 − (Levenshtein distance / longer length). Long strings compare their ends. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const LIMIT = 1_000;
  if (a.length > LIMIT * 2 || b.length > LIMIT * 2) {
    return (similarity(a.slice(0, LIMIT), b.slice(0, LIMIT)) + similarity(a.slice(-LIMIT), b.slice(-LIMIT))) / 2;
  }
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return 1 - (previous[b.length] as number) / Math.max(a.length, b.length);
}

function resolveByXPath(anchor: Anchor, index: TextIndex, doc: Document, needle: string): Resolution | null {
  const startElement = resolveXPath(anchor.start.xpath, doc);
  const endElement = resolveXPath(anchor.end.xpath, doc);
  if (!startElement || !endElement) return null;
  const start = offsetAtOrAfter(index, startElement) + anchor.start.offset;
  const end = offsetAtOrAfter(index, endElement) + anchor.end.offset;
  if (end <= start || start > offsetAfter(index, startElement) || end > offsetAfter(index, endElement)) {
    return null;
  }
  const found = collapseWhitespace(index.text.slice(start, end)).trim();
  return similarity(found, needle) >= XPATH_MIN_SIMILARITY ? { start, end, method: 'xpath' } : null;
}

/**
 * Finds where an anchor is on the page now. Returns text offsets into
 * `index.text`, or null when the highlight is orphaned.
 */
export function resolveAnchor(anchor: Anchor, index: TextIndex, doc: Document): Resolution | null {
  const needle = collapseWhitespace(anchor.quote.exact).trim();
  if (!needle) return null;

  const norm = normalized(index);
  const candidates: number[] = [];
  for (let at = norm.text.indexOf(needle); at !== -1; at = norm.text.indexOf(needle, at + 1)) {
    candidates.push(at);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  if (candidates.length === 0) return resolveByXPath(anchor, index, doc, needle);

  const toRaw = (at: number) => ({
    start: norm.map[at] as number,
    end: (norm.map[at + needle.length - 1] as number) + 1,
  });
  if (candidates.length === 1) return { ...toRaw(candidates[0] as number), method: 'quote' };

  const prefix = collapseWhitespace(anchor.quote.prefix).trimEnd();
  const suffix = collapseWhitespace(anchor.quote.suffix).trimStart();
  let best: { at: number; score: number; distance: number } | null = null;
  for (const at of candidates) {
    const before = norm.text.slice(Math.max(0, at - prefix.length - 1), at).trimEnd();
    const after = norm.text.slice(at + needle.length, at + needle.length + suffix.length + 1).trimStart();
    const score = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
    const distance = Math.abs((norm.map[at] as number) - anchor.position.start);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { at, score, distance };
    }
  }
  return { ...toRaw((best as { at: number }).at), method: 'context' };
}

/** A DOM Range for text offsets (used to measure and to select resolved text). */
export function rangeFromOffsets(index: TextIndex, start: number, end: number, doc: Document): Range | null {
  const first = nodeIndexAt(index, start, 'start');
  const last = nodeIndexAt(index, end, 'end');
  if (first === -1 || last === -1) return null;
  const range = doc.createRange();
  range.setStart(index.nodes[first] as Text, start - (index.starts[first] as number));
  range.setEnd(index.nodes[last] as Text, end - (index.starts[last] as number));
  return range;
}
