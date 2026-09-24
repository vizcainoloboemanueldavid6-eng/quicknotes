/**
 * A sticky note on the page: draggable (header), resizable (corner handle),
 * minimizable, recolorable, with a small rich-text editor (bold, italic,
 * bulleted and numbered lists; Ctrl+B / Ctrl+I). Stored HTML always goes
 * through the whitelist sanitizer. Position is kept as a percentage of the
 * document's width and height; size in pixels.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { PALETTE } from '../lib/colors';
import { colorName, t } from '../lib/i18n';
import { htmlToText } from '../lib/richtext';
import { sanitizeHtml } from '../lib/sanitize';
import {
  COLORS,
  NOTE_MAX_SIZE,
  NOTE_MIN_SIZE,
  type Color,
  type NotePosition,
  type NoteSize,
  type StickyNote,
} from '../lib/types';
import {
  IconBold,
  IconBulletList,
  IconExpand,
  IconGrip,
  IconItalic,
  IconMinus,
  IconNumberedList,
  IconTrash,
} from './icons';

export type NotePatch = Partial<Pick<StickyNote, 'html' | 'color' | 'position' | 'size' | 'minimized'>>;

export interface DocSize {
  width: number;
  height: number;
}

export interface StickyNoteViewProps {
  note: StickyNote;
  docSize: DocSize;
  /** Text of the highlight this note is attached to, if any. */
  quote?: string;
  zIndex: number;
  autoFocus: boolean;
  flash: boolean;
  onUpdate: (id: string, patch: NotePatch) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string) => void;
  onAutoFocused: () => void;
}

const SAVE_DELAY_MS = 500;
const MINIMIZED_HEIGHT = 34;
const KEYBOARD_STEP = 10;
const KEYBOARD_STEP_LARGE = 50;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function percentToPixels(position: NotePosition, docSize: DocSize, size: NoteSize) {
  return {
    left: clamp((position.x / 100) * docSize.width, 0, docSize.width - Math.min(size.width, docSize.width)),
    top: clamp((position.y / 100) * docSize.height, 0, docSize.height - MINIMIZED_HEIGHT),
  };
}

export function pixelsToPercent(left: number, top: number, docSize: DocSize): NotePosition {
  return {
    x: round(clamp((left / docSize.width) * 100, 0, 100)),
    y: round(clamp((top / docSize.height) * 100, 0, 100)),
  };
}

function isEditorEmpty(element: HTMLElement): boolean {
  return (element.textContent ?? '').trim() === '' && !element.querySelector('li');
}

/** document.execCommand is deprecated but remains the only way to edit a contenteditable's selection with undo support. */
function exec(command: 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList' | 'insertText', value?: string) {
  document.execCommand(command, false, value);
}

function isFocused(element: HTMLElement): boolean {
  const root = element.getRootNode() as Document | ShadowRoot;
  return root.activeElement === element;
}

/** The selection as seen from inside the shadow root (Chrome exposes it on the root). */
function editorSelection(editor: HTMLElement): Selection | null {
  const root = editor.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
  return typeof root.getSelection === 'function' ? root.getSelection() : document.getSelection();
}

interface Caret {
  start: number;
  end: number;
}

function textOffset(editor: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(editor, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Caret / selection as character offsets into the editor's text (survives DOM restructuring). */
function saveCaret(editor: HTMLElement): Caret | null {
  const selection = editorSelection(editor);
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  return {
    start: textOffset(editor, range.startContainer, range.startOffset),
    end: textOffset(editor, range.endContainer, range.endOffset),
  };
}

function pointAt(editor: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    last = node;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

/**
 * Chrome's list commands reset the caret to the start of the line when the
 * editor lives in a shadow root; the text itself is unchanged, so the caret is
 * put back at the same character offsets.
 */
function restoreCaret(editor: HTMLElement, caret: Caret): void {
  const selection = editorSelection(editor);
  const start = pointAt(editor, caret.start);
  const end = pointAt(editor, caret.end);
  if (!selection || !start || !end) return;
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
}

type Gesture =
  | { kind: 'move'; pointerId: number; startX: number; startY: number; left: number; top: number }
  | { kind: 'resize'; pointerId: number; startX: number; startY: number; width: number; height: number };

export function StickyNoteView(props: StickyNoteViewProps) {
  const { note, docSize, quote, zIndex, autoFocus, flash, onUpdate, onDelete, onActivate, onAutoFocused } = props;
  const editorRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const gesture = useRef<Gesture | null>(null);
  const deleting = useRef(false);
  const latest = useRef({ note, onUpdate });
  latest.current = { note, onUpdate };
  const [dragPosition, setDragPosition] = useState<{ left: number; top: number } | null>(null);
  const [dragSize, setDragSize] = useState<NoteSize | null>(null);
  const [empty, setEmpty] = useState(() => htmlToText(note.html) === '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const size = dragSize ?? note.size;
  const position = dragPosition ?? percentToPixels(note.position, docSize, size);
  const palette = PALETTE[note.color];

  // --- Editor content ----------------------------------------------------

  const flushSave = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const editor = editorRef.current;
    if (!editor || deleting.current) return;
    const html = sanitizeHtml(editor.innerHTML);
    const { note: current, onUpdate: update } = latest.current;
    if (html !== current.html) update(current.id, { html });
  };

  const scheduleSave = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, SAVE_DELAY_MS);
  };

  // Show stored HTML, unless the user is typing in this editor right now.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || isFocused(editor)) return;
    if (sanitizeHtml(editor.innerHTML) !== note.html) {
      editor.innerHTML = note.html;
    }
    setEmpty(isEditorEmpty(editor));
  }, [note.html, note.minimized]);

  useEffect(() => {
    if (!autoFocus || note.minimized) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    onAutoFocused();
  }, [autoFocus, note.minimized, onAutoFocused]);

  // Save pending edits if the note leaves the page for another reason than
  // being deleted (pause, SPA navigation, minimizing).
  useEffect(
    () => () => {
      if (saveTimer.current !== undefined) flushSave();
    },

    [],
  );

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const onEditorKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && !event.shiftKey && (event.key === 'b' || event.key === 'B')) {
      event.preventDefault();
      exec('bold');
      scheduleSave();
    } else if (mod && !event.altKey && !event.shiftKey && (event.key === 'i' || event.key === 'I')) {
      event.preventDefault();
      exec('italic');
      scheduleSave();
    } else if (event.key === 'Escape') {
      event.currentTarget.blur();
    }
  };

  const onPaste = (event: JSX.TargetedClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) exec('insertText', text);
  };

  const format = (command: 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList') => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!isFocused(editor)) editor.focus({ preventScroll: true });
    const caret = saveCaret(editor);
    exec(command);
    const now = saveCaret(editor);
    // Only when the caret actually moved: re-selecting would drop the pending
    // "type in bold" state that bold/italic set on a collapsed caret.
    if (caret && (!now || now.start !== caret.start || now.end !== caret.end)) restoreCaret(editor, caret);
    setEmpty(isEditorEmpty(editor));
    scheduleSave();
  };

  // --- Drag & resize ------------------------------------------------------

  const startGesture = (event: JSX.TargetedPointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0) return;
    if (kind === 'move' && (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    onActivate(note.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current =
      kind === 'move'
        ? {
            kind,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: position.left,
            top: position.top,
          }
        : {
            kind,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            width: size.width,
            height: size.height,
          };
  };

  const moveGesture = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.kind === 'move') {
      setDragPosition({
        left: clamp(current.left + dx, 0, docSize.width - size.width),
        top: clamp(current.top + dy, 0, docSize.height - MINIMIZED_HEIGHT),
      });
    } else {
      setDragSize({
        width: Math.round(clamp(current.width + dx, NOTE_MIN_SIZE.width, NOTE_MAX_SIZE.width)),
        height: Math.round(clamp(current.height + dy, NOTE_MIN_SIZE.height, NOTE_MAX_SIZE.height)),
      });
    }
  };

  const endGesture = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.kind === 'move' && dragPosition) {
      onUpdate(note.id, { position: pixelsToPercent(dragPosition.left, dragPosition.top, docSize) });
    } else if (current.kind === 'resize' && dragSize) {
      onUpdate(note.id, { size: dragSize });
    }
    setDragPosition(null);
    setDragSize(null);
  };

  const gestureHandlers = (kind: Gesture['kind']) => ({
    onPointerDown: (event: JSX.TargetedPointerEvent<HTMLElement>) => startGesture(event, kind),
    onPointerMove: moveGesture,
    onPointerUp: endGesture,
    onPointerCancel: endGesture,
  });

  const onMoveKey = (event: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    const left = clamp(position.left + move[0], 0, docSize.width - size.width);
    const top = clamp(position.top + move[1], 0, docSize.height - MINIMIZED_HEIGHT);
    onUpdate(note.id, { position: pixelsToPercent(left, top, docSize) });
  };

  const onResizeKey = (event: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const change = delta[event.key];
    if (!change) return;
    event.preventDefault();
    onUpdate(note.id, {
      size: {
        width: clamp(size.width + change[0], NOTE_MIN_SIZE.width, NOTE_MAX_SIZE.width),
        height: clamp(size.height + change[1], NOTE_MIN_SIZE.height, NOTE_MAX_SIZE.height),
      },
    });
  };

  const setColor = (color: Color) => onUpdate(note.id, { color });

  const requestDelete = () => {
    if (confirmDelete) {
      deleting.current = true;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      onDelete(note.id);
    } else {
      setConfirmDelete(true);
    }
  };

  const containerStyle = {
    left: `${position.left}px`,
    top: `${position.top}px`,
    zIndex,
    backgroundColor: palette.note,
    borderColor: palette.edge,
  };

  const snippet = htmlToText(note.html).replace(/\s+/g, ' ').trim();

  // --- Minimized ---------------------------------------------------------

  if (note.minimized) {
    return (
      <div
        role="group"
        aria-label={t('noteLabel')}
        data-qn="note"
        data-qn-note-id={note.id}
        class={`absolute flex h-[34px] max-w-[240px] touch-none select-none items-center gap-1 rounded-full border pl-3 pr-1 shadow-soft ${flash ? 'qn-flash' : ''}`}
        style={containerStyle}
        {...gestureHandlers('move')}
      >
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: palette.dot }} aria-hidden="true" />
        <span class="min-w-0 flex-1 cursor-grab truncate text-[13px] text-ink">{snippet || t('noteEmpty')}</span>
        <button
          type="button"
          class="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-black/5 hover:text-ink"
          aria-label={t('noteExpand')}
          title={t('noteExpand')}
          onClick={() => onUpdate(note.id, { minimized: false })}
        >
          <IconExpand />
        </button>
      </div>
    );
  }

  // --- Expanded ----------------------------------------------------------

  return (
    <div
      role="group"
      aria-label={t('noteLabel')}
      data-qn="note"
      data-qn-note-id={note.id}
      class={`absolute flex flex-col overflow-hidden rounded-[10px] border shadow-soft ${flash ? 'qn-flash' : ''}`}
      style={{ ...containerStyle, width: `${size.width}px`, height: `${size.height}px` }}
      onPointerDown={() => onActivate(note.id)}
    >
      <div
        class="flex h-8 shrink-0 cursor-grab touch-none select-none items-center gap-1 border-b px-1.5 active:cursor-grabbing"
        style={{ borderColor: palette.edge, backgroundColor: 'rgba(28, 25, 23, 0.035)' }}
        {...gestureHandlers('move')}
      >
        <span
          role="button"
          tabIndex={0}
          class="grid h-6 w-6 place-items-center rounded text-ink-faint hover:text-ink"
          aria-label={t('noteMove')}
          title={t('noteMove')}
          onKeyDown={onMoveKey}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
            <circle cx="3" cy="3" r="1.1" />
            <circle cx="9" cy="3" r="1.1" />
            <circle cx="3" cy="9" r="1.1" />
            <circle cx="9" cy="9" r="1.1" />
            <circle cx="3" cy="6" r="1.1" />
            <circle cx="9" cy="6" r="1.1" />
          </svg>
        </span>
        <div class="flex items-center gap-0.5">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              class="grid h-6 w-6 place-items-center rounded-full"
              aria-label={t('noteColor', colorName(color))}
              title={t('noteColor', colorName(color))}
              aria-pressed={color === note.color}
              onClick={() => setColor(color)}
            >
              <span
                class="block h-3.5 w-3.5 rounded-full border"
                style={{
                  backgroundColor: PALETTE[color].note,
                  borderColor: color === note.color ? '#1C1917' : PALETTE[color].edge,
                  borderWidth: color === note.color ? '2px' : '1px',
                }}
              />
            </button>
          ))}
        </div>
        <span class="flex-1" />
        <button
          type="button"
          class="grid h-6 w-6 place-items-center rounded text-ink-soft hover:bg-black/5 hover:text-ink"
          aria-label={t('noteMinimize')}
          title={t('noteMinimize')}
          onClick={() => {
            flushSave();
            onUpdate(note.id, { minimized: true });
          }}
        >
          <IconMinus />
        </button>
        <button
          type="button"
          class={`grid h-6 place-items-center rounded ${
            confirmDelete
              ? 'bg-red-600 px-1.5 text-[11px] font-semibold text-white'
              : 'w-6 text-ink-soft hover:bg-black/5 hover:text-red-700'
          }`}
          aria-label={confirmDelete ? t('noteConfirmDelete') : t('noteDelete')}
          title={confirmDelete ? t('noteConfirmDelete') : t('noteDelete')}
          onClick={requestDelete}
        >
          {confirmDelete ? t('noteConfirmDelete') : <IconTrash />}
        </button>
      </div>

      {quote && (
        <p class="shrink-0 truncate px-3 pt-1.5 text-[12px] italic text-ink-soft" title={quote}>
          “{quote}”
        </p>
      )}

      <div class="relative min-h-0 flex-1 overflow-auto px-3 py-2">
        <div
          ref={editorRef}
          class="qn-editor min-h-full text-[14px] leading-relaxed text-ink"
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={t('noteEditorLabel')}
          data-placeholder={t('notePlaceholder')}
          data-empty={empty ? 'true' : 'false'}
          spellcheck
          onInput={(event) => {
            setEmpty(isEditorEmpty(event.currentTarget));
            scheduleSave();
          }}
          onKeyDown={onEditorKeyDown}
          onBlur={flushSave}
          onPaste={onPaste}
          onDrop={(event) => event.preventDefault()}
        />
      </div>

      <div
        role="toolbar"
        aria-label={t('formatToolbar')}
        class="flex h-8 shrink-0 items-center gap-0.5 border-t px-1.5"
        style={{ borderColor: palette.edge }}
      >
        {(
          [
            ['bold', t('formatBold'), <IconBold key="b" />],
            ['italic', t('formatItalic'), <IconItalic key="i" />],
            ['insertUnorderedList', t('formatBulletList'), <IconBulletList key="ul" />],
            ['insertOrderedList', t('formatNumberedList'), <IconNumberedList key="ol" />],
          ] as const
        ).map(([command, label, icon]) => (
          <button
            key={command}
            type="button"
            class="grid h-6 w-6 place-items-center rounded text-ink-soft hover:bg-black/5 hover:text-ink"
            aria-label={label}
            title={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(command)}
          >
            {icon}
          </button>
        ))}
        <span class="flex-1" />
        <span
          role="button"
          tabIndex={0}
          class="grid h-6 w-6 cursor-nwse-resize touch-none place-items-center rounded text-ink-faint hover:text-ink"
          aria-label={t('noteResize')}
          title={t('noteResize')}
          onKeyDown={onResizeKey}
          {...gestureHandlers('resize')}
        >
          <IconGrip />
        </span>
      </div>
    </div>
  );
}
