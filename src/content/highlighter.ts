/**
 * Draws highlights in the page: every text node (or part of one) covered by a
 * highlight is wrapped in a <quicknotes-mark> element. A highlight that spans
 * several nodes gets several marks sharing the same data-qn-id.
 *
 * Marks live in the page's own DOM (they have to, to sit around the text), so
 * their look is set with inline `!important` declarations through the CSSOM,
 * which page stylesheets cannot override and page CSP does not block.
 */
import { INK, PALETTE } from '../lib/colors';
import type { Color } from '../lib/types';
import { HIGHLIGHT_TAG, type TextIndex } from './anchor';

export const ID_ATTRIBUTE = 'data-qn-id';
export const COLOR_ATTRIBUTE = 'data-qn-color';

/** Parents in which a whitespace-only text node is layout, not content. */
const STRUCTURAL_PARENTS: ReadonlySet<string> = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'ul',
  'ol',
  'dl',
  'select',
  'datalist',
  'optgroup',
  'html',
  'head',
]);

function styleMark(mark: HTMLElement, color: Color): void {
  const { style } = mark;
  style.setProperty('background-color', PALETTE[color].highlight, 'important');
  style.setProperty('color', INK, 'important');
  style.setProperty('border-radius', '2px', 'important');
  style.setProperty('box-decoration-break', 'clone', 'important');
  style.setProperty('-webkit-box-decoration-break', 'clone', 'important');
  style.setProperty('display', 'inline', 'important');
  style.setProperty('margin', '0', 'important');
  style.setProperty('padding', '0', 'important');
  style.setProperty('cursor', 'pointer', 'important');
  style.setProperty('transition', 'box-shadow 0.3s ease', 'important');
}

function createMark(doc: Document, id: string, color: Color): HTMLElement {
  const mark = doc.createElement(HIGHLIGHT_TAG);
  mark.setAttribute(ID_ATTRIBUTE, id);
  mark.setAttribute(COLOR_ATTRIBUTE, color);
  styleMark(mark, color);
  return mark;
}

function insertIntoIndex(index: TextIndex, at: number, node: Text, start: number): void {
  index.nodes.splice(at, 0, node);
  index.starts.splice(at, 0, start);
  index.startOf.set(node, start);
}

/**
 * Wraps the text between two offsets of `index.text`. The index is updated in
 * place as text nodes are split, so it stays valid for further calls (restoring
 * many highlights needs a single index). Returns the created marks.
 */
export function wrapOffsets(index: TextIndex, start: number, end: number, id: string, color: Color): HTMLElement[] {
  const marks: HTMLElement[] = [];
  if (end <= start) return marks;

  // First node whose text reaches past `start`.
  let lo = 0;
  let hi = index.nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const nodeEnd = (index.starts[mid] as number) + (index.nodes[mid] as Text).data.length;
    if (nodeEnd > start) hi = mid;
    else lo = mid + 1;
  }

  for (let i = lo; i < index.nodes.length && (index.starts[i] as number) < end; i++) {
    let node = index.nodes[i] as Text;
    const nodeStart = index.starts[i] as number;
    const length = node.data.length;
    const from = Math.max(start - nodeStart, 0);
    const to = Math.min(end - nodeStart, length);
    if (to <= from) continue;

    const parent = node.parentNode;
    if (!parent) continue;
    const segment = node.data.slice(from, to);
    if (segment.trim() === '' && parent.nodeType === 1 && STRUCTURAL_PARENTS.has((parent as Element).localName)) {
      continue;
    }

    if (to < length) {
      const tail = node.splitText(to);
      insertIntoIndex(index, i + 1, tail, nodeStart + to);
    }
    if (from > 0) {
      node = node.splitText(from);
      insertIntoIndex(index, i + 1, node, nodeStart + from);
      i++;
    }

    const mark = createMark(node.ownerDocument, id, color);
    parent.insertBefore(mark, node);
    mark.appendChild(node);
    marks.push(mark);
  }
  return marks;
}

export function marksFor(id: string, root: ParentNode = document): HTMLElement[] {
  // Quoted attribute value: only backslashes and double quotes need escaping.
  const value = id.replace(/["\\]/g, '\\$&');
  return Array.from(root.querySelectorAll<HTMLElement>(`${HIGHLIGHT_TAG}[${ID_ATTRIBUTE}="${value}"]`));
}

export function allMarks(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(HIGHLIGHT_TAG));
}

export function recolorMarks(id: string, color: Color, root: ParentNode = document): void {
  for (const mark of marksFor(id, root)) {
    mark.setAttribute(COLOR_ATTRIBUTE, color);
    styleMark(mark, color);
  }
}

/** Merges a text node with adjacent text siblings (undoing our splits). */
function mergeAdjacentText(node: Node | null): void {
  if (!node || node.nodeType !== 3) return;
  let text = node as Text;
  while (text.previousSibling && text.previousSibling.nodeType === 3) {
    const previous = text.previousSibling as Text;
    previous.appendData(text.data);
    text.remove();
    text = previous;
  }
  while (text.nextSibling && text.nextSibling.nodeType === 3) {
    const next = text.nextSibling as Text;
    text.appendData(next.data);
    next.remove();
  }
}

function unwrap(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) return;
  const first = mark.firstChild;
  const last = mark.lastChild;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  mark.remove();
  mergeAdjacentText(first);
  if (last !== first && last?.isConnected) mergeAdjacentText(last);
}

/** Removes every mark of a highlight. Any TextIndex built before is stale afterwards. */
export function removeMarks(id: string, root: ParentNode = document): void {
  for (const mark of marksFor(id, root)) unwrap(mark);
}

export function removeAllMarks(root: ParentNode = document): void {
  for (const mark of allMarks(root)) unwrap(mark);
}

/** Briefly outlines a highlight so the eye can find it after scrolling. */
export function flashMarks(id: string, root: ParentNode = document): void {
  const marks = marksFor(id, root);
  for (const mark of marks) mark.style.setProperty('box-shadow', `0 0 0 3px ${PALETTE.yellow.dot}`, 'important');
  window.setTimeout(() => {
    for (const mark of marks) mark.style.setProperty('box-shadow', 'none', 'important');
  }, 1200);
}

/** The innermost highlight element in an event's path, if any. */
export function markFromEvent(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLElement && target.localName === HIGHLIGHT_TAG) return target;
  }
  return null;
}
