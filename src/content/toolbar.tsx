/**
 * Floating UI anchored to page text:
 *  - SelectionToolbar: appears above (or below) a text selection with the four
 *    highlight colors and "Add note".
 *  - HighlightMenu: appears when an existing highlight is clicked, to recolor
 *    it, attach/show a note, or delete it.
 * Both are positioned in document coordinates inside the shadow-root layer.
 */
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { PALETTE } from '../lib/colors';
import { colorNameInSentence, t } from '../lib/i18n';
import { COLORS, type Color } from '../lib/types';
import { IconNote, IconTrash } from './icons';

export interface Anchored {
  /** Horizontal center, in document pixels. */
  x: number;
  /** Top (placement "below") or bottom (placement "above") edge, in document pixels. */
  y: number;
  placement: 'above' | 'below';
}

const TOOLBAR_GAP = 8;
const TOOLBAR_HEIGHT = 40;
const EDGE_MARGIN = 8;

/** Width of the viewport without its vertical scrollbar. */
function viewportWidth(win: Window): number {
  return win.document.documentElement.clientWidth || win.innerWidth;
}

/** Keeps a horizontal center at least EDGE_MARGIN + halfWidth away from both viewport edges. */
export function clampCenter(viewportX: number, halfWidth: number, width: number): number {
  return Math.min(
    Math.max(viewportX, halfWidth + EDGE_MARGIN),
    Math.max(halfWidth + EDGE_MARGIN, width - halfWidth - EDGE_MARGIN),
  );
}

/**
 * Chooses where to show a popover for a viewport rectangle (e.g. a selection).
 * `halfWidth` is only an estimate; the popover corrects itself once it has been
 * measured (useKeepInView), since its width depends on the language.
 */
export function placeNear(rect: DOMRect, halfWidth: number, win: Window = window): Anchored {
  const roomAbove = rect.top >= TOOLBAR_HEIGHT + TOOLBAR_GAP;
  const viewportX = clampCenter(rect.left + rect.width / 2, halfWidth, viewportWidth(win));
  return {
    x: viewportX + win.scrollX,
    y: (roomAbove ? rect.top - TOOLBAR_GAP : rect.bottom + TOOLBAR_GAP) + win.scrollY,
    placement: roomAbove ? 'above' : 'below',
  };
}

/** Re-centers a rendered popover with its real width so it never crosses the window's edges. */
function useKeepInView(ref: RefObject<HTMLDivElement>, position: Anchored): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const x = clampCenter(position.x - window.scrollX, element.offsetWidth / 2, viewportWidth(window));
    element.style.left = `${x + window.scrollX}px`;
  }, [ref, position.x, position.y, position.placement]);
}

function positionStyle(position: Anchored) {
  return {
    left: `${position.x}px`,
    top: `${position.y}px`,
    // The individual `translate` property, not `transform`: the pop-in animation
    // animates `transform`, which would otherwise override the offset mid-animation.
    translate: position.placement === 'above' ? '-50% -100%' : '-50% 0',
  };
}

/** Keeps the page selection alive while a toolbar button is pressed. */
function keepSelection(event: Event) {
  event.preventDefault();
}

function Swatch({
  color,
  label,
  pressed,
  onSelect,
}: {
  color: Color;
  label: string;
  pressed?: boolean;
  onSelect: (color: Color) => void;
}) {
  return (
    <button
      type="button"
      class="grid h-7 w-7 place-items-center rounded-full transition-transform hover:scale-110 focus-visible:scale-110"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onMouseDown={keepSelection}
      onClick={() => onSelect(color)}
    >
      <span
        class="block h-5 w-5 rounded-full border"
        style={{
          backgroundColor: PALETTE[color].highlight,
          borderColor: pressed ? '#1C1917' : PALETTE[color].edge,
          borderWidth: pressed ? '2px' : '1px',
        }}
      />
    </button>
  );
}

export interface SelectionToolbarProps {
  position: Anchored;
  defaultColor: Color;
  onHighlight: (color: Color) => void;
  onAddNote: () => void;
}

export function SelectionToolbar({ position, defaultColor, onHighlight, onAddNote }: SelectionToolbarProps) {
  const ordered = [defaultColor, ...COLORS.filter((color) => color !== defaultColor)];
  const ref = useRef<HTMLDivElement>(null);
  useKeepInView(ref, position);
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('toolbarLabel')}
      data-qn="toolbar"
      class="qn-pop absolute flex items-center gap-0.5 whitespace-nowrap rounded-full border border-paper-line bg-paper py-1 pl-1.5 pr-1 shadow-soft-lg"
      style={positionStyle(position)}
      onMouseDown={keepSelection}
    >
      {ordered.map((color) => (
        <Swatch
          key={color}
          color={color}
          label={t('toolbarHighlight', colorNameInSentence(color))}
          onSelect={onHighlight}
        />
      ))}
      <span class="mx-1 h-5 w-px bg-paper-line" aria-hidden="true" />
      <button
        type="button"
        class="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-ink hover:bg-primary-soft"
        onMouseDown={keepSelection}
        onClick={onAddNote}
      >
        <IconNote />
        {t('toolbarAddNote')}
      </button>
    </div>
  );
}

export interface HighlightMenuProps {
  position: Anchored;
  color: Color;
  hasNote: boolean;
  onColor: (color: Color) => void;
  onNote: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function HighlightMenu({ position, color, hasNote, onColor, onNote, onDelete, onClose }: HighlightMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useKeepInView(ref, position);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const node = ref.current;
    node?.addEventListener('keydown', onKey);
    return () => node?.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('menuLabel')}
      data-qn="highlight-menu"
      class="qn-pop absolute flex items-center gap-0.5 whitespace-nowrap rounded-full border border-paper-line bg-paper py-1 pl-1.5 pr-1 shadow-soft-lg"
      style={positionStyle(position)}
    >
      {COLORS.map((option) => (
        <Swatch
          key={option}
          color={option}
          pressed={option === color}
          label={t('menuChangeColor', colorNameInSentence(option))}
          onSelect={onColor}
        />
      ))}
      <span class="mx-1 h-5 w-px bg-paper-line" aria-hidden="true" />
      <button
        type="button"
        class="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-ink hover:bg-primary-soft"
        onClick={onNote}
      >
        <IconNote />
        {hasNote ? t('menuShowNote') : t('menuAddNote')}
      </button>
      <button
        type="button"
        class="grid h-7 w-7 place-items-center rounded-full text-ink-soft hover:bg-red-50 hover:text-red-700"
        aria-label={t('menuDelete')}
        title={t('menuDelete')}
        onClick={onDelete}
      >
        <IconTrash />
      </button>
    </div>
  );
}
