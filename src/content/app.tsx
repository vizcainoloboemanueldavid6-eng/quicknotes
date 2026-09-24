/** Root of the UI rendered inside the shadow root. Pure view: all state lives in the controller (index.ts). */
import { t } from '../lib/i18n';
import type { Color, StickyNote } from '../lib/types';
import { IconClose } from './icons';
import { type DocSize, type NotePatch, StickyNoteView } from './stickyNote';
import { type Anchored, HighlightMenu, SelectionToolbar } from './toolbar';

export interface Toast {
  id: number;
  message: string;
}

export interface MenuState {
  highlightId: string;
  color: Color;
  hasNote: boolean;
  position: Anchored;
}

export interface UiState {
  toolbar: Anchored | null;
  menu: MenuState | null;
  notes: StickyNote[];
  /** Note ids from back to front. */
  stacking: string[];
  quotes: ReadonlyMap<string, string>;
  docSize: DocSize;
  defaultColor: Color;
  focusNoteId: string | null;
  flashNoteId: string | null;
  toasts: Toast[];
}

export interface UiActions {
  highlightSelection: (color: Color) => void;
  addNoteFromSelection: () => void;
  recolorHighlight: (id: string, color: Color) => void;
  noteForHighlight: (id: string) => void;
  deleteHighlight: (id: string) => void;
  closeMenu: () => void;
  updateNote: (id: string, patch: NotePatch) => void;
  deleteNote: (id: string) => void;
  activateNote: (id: string) => void;
  noteFocused: () => void;
  noteTooLong: () => void;
  dismissToast: (id: number) => void;
}

export function ContentApp({ state, actions }: { state: UiState; actions: UiActions }) {
  const { toolbar, menu, notes, stacking, quotes, docSize, defaultColor, focusNoteId, flashNoteId, toasts } = state;
  const base = 10;
  return (
    <>
      {notes.map((note) => (
        <StickyNoteView
          key={note.id}
          note={note}
          docSize={docSize}
          quote={note.highlightId ? quotes.get(note.highlightId) : undefined}
          zIndex={base + Math.max(0, stacking.indexOf(note.id))}
          autoFocus={focusNoteId === note.id}
          flash={flashNoteId === note.id}
          onUpdate={actions.updateNote}
          onDelete={actions.deleteNote}
          onActivate={actions.activateNote}
          onAutoFocused={actions.noteFocused}
          onTooLong={actions.noteTooLong}
        />
      ))}

      {toolbar && (
        <div class="absolute left-0 top-0" style={{ zIndex: base + notes.length + 20 }}>
          <SelectionToolbar
            position={toolbar}
            defaultColor={defaultColor}
            onHighlight={actions.highlightSelection}
            onAddNote={actions.addNoteFromSelection}
          />
        </div>
      )}

      {menu && (
        <div class="absolute left-0 top-0" style={{ zIndex: base + notes.length + 20 }}>
          <HighlightMenu
            key={menu.highlightId}
            position={menu.position}
            color={menu.color}
            hasNote={menu.hasNote}
            onColor={(color) => actions.recolorHighlight(menu.highlightId, color)}
            onNote={() => actions.noteForHighlight(menu.highlightId)}
            onDelete={() => actions.deleteHighlight(menu.highlightId)}
            onClose={actions.closeMenu}
          />
        </div>
      )}

      {/* The live region is always present so screen readers announce new toasts. */}
      <div
        class="fixed bottom-4 right-4 flex max-w-[340px] flex-col gap-2"
        style={{ zIndex: base + notes.length + 30 }}
        role="status"
        aria-live="polite"
      >
        {toasts.length > 0 && (
          <>
            {toasts.map((toast) => (
              <div
                key={toast.id}
                data-qn="toast"
                class="qn-pop flex items-start gap-2 rounded-lg border border-paper-line bg-paper py-2.5 pl-3.5 pr-1.5 text-[13px] text-ink shadow-soft-lg"
              >
                <span class="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <span class="flex-1">{toast.message}</span>
                <button
                  type="button"
                  class="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-black/5 hover:text-ink"
                  aria-label={t('dismiss')}
                  title={t('dismiss')}
                  onClick={() => actions.dismissToast(toast.id)}
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
