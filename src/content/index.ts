/**
 * Content script. Injected on demand (activeTab + scripting) or, if the user
 * opted in, registered for every http(s) page. Running it twice in the same tab
 * is harmless: the guard at the bottom keeps a single controller per page.
 *
 * Responsibilities: load the page's data, restore highlights (and report the
 * ones that cannot be found), render sticky notes, show the selection toolbar,
 * answer messages from the background/popup/side panel, follow settings changes
 * (pause, toolbar, default color) and SPA navigations.
 */
import { h, render } from 'preact';
import { t } from '../lib/i18n';
import { fail, isContentMessage, ok, type ContentMessage, type PageStatus, type Reply } from '../lib/messages';
import {
  getPage,
  getSettings,
  removeHighlight,
  removeNote,
  saveHighlight,
  saveNote,
  setOrphans,
  subscribe,
  type StoreChange,
} from '../lib/storage';
import {
  DEFAULT_SETTINGS,
  NOTE_DEFAULT_SIZE,
  type Color,
  type Highlight,
  type PageData,
  type Settings,
  type StickyNote,
} from '../lib/types';
import { isPausedUrl, normalizeUrl } from '../lib/url';
import { buildTextIndex, describeRange, findText, rangeFromOffsets, resolveAnchor } from './anchor';
import { ContentApp, type UiActions, type UiState } from './app';
import {
  ID_ATTRIBUTE,
  flashMarks,
  marksFor,
  markFromEvent,
  recolorMarks,
  removeAllMarks,
  removeMarks,
  wrapOffsets,
} from './highlighter';
import { createShadowUi, measureDocument, type ShadowUi } from './shadow';
import { type NotePatch, percentToPixels, pixelsToPercent } from './stickyNote';
import { placeNear } from './toolbar';

const ORPHAN_RETRY_WINDOW_MS = 10_000;
const ORPHAN_RETRY_DEBOUNCE_MS = 400;
const ORPHAN_QUIET_MS = 1_500;
const URL_POLL_MS = 1_000;
const TOAST_MS = 5_000;
const TOOLBAR_HALF_WIDTH = 112;
const MENU_HALF_WIDTH = 140;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class QuickNotesController {
  private ui: ShadowUi | null = null;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private url = normalizeUrl(location.href);
  private page: PageData | null = null;
  private paused = false;
  /** Highlights currently drawn on the page, with their color. */
  private readonly rendered = new Map<string, Color>();
  private readonly orphans = new Set<string>();
  private orphanDeadline = 0;
  private orphanObserver: MutationObserver | null = null;
  private orphanTimer: number | undefined;
  private quietTimer: number | undefined;
  private pendingWrites = 0;
  private needsResync = false;
  private toastSeq = 0;
  private createdThisSession = 0;
  private resizeTimer: number | undefined;
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  private state: UiState = {
    toolbar: null,
    menu: null,
    notes: [],
    stacking: [],
    quotes: new Map(),
    docSize: { width: 1, height: 1 },
    defaultColor: DEFAULT_SETTINGS.defaultColor,
    focusNoteId: null,
    flashNoteId: null,
    toasts: [],
  };

  private readonly actions: UiActions = {
    highlightSelection: (color) => void this.highlightSelection(color, false),
    addNoteFromSelection: () => void this.highlightSelection(this.settings.defaultColor, true),
    recolorHighlight: (id, color) => this.recolorHighlight(id, color),
    noteForHighlight: (id) => this.noteForHighlight(id),
    deleteHighlight: (id) => this.deleteHighlight(id),
    closeMenu: () => this.setState({ menu: null }),
    updateNote: (id, patch) => this.updateNote(id, patch),
    deleteNote: (id) => this.deleteNote(id),
    activateNote: (id) => this.activateNote(id),
    noteFocused: () => {
      this.state.focusNoteId = null;
    },
    dismissToast: (id) => this.setState({ toasts: this.state.toasts.filter((toast) => toast.id !== id) }),
  };

  constructor() {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    // Listen first so a ping sent right after injection is answered.
    chrome.runtime.onMessage.addListener(this.onMessage);
    this.disposers.push(() => chrome.runtime.onMessage.removeListener(this.onMessage));
    // Marks left by a previous instance (the extension was updated or reloaded
    // while the page stayed open) would otherwise be wrapped a second time.
    removeAllMarks(document);
    this.ui = createShadowUi();
    this.bindPageEvents();
    this.disposers.push(subscribe((change) => this.onStoreChange(change)));

    try {
      const [settings, page] = await Promise.all([getSettings(), getPage(this.url)]);
      this.settings = settings;
      this.page = page;
      this.state.defaultColor = settings.defaultColor;
      this.paused = isPausedUrl(location.href, settings.pausedSites);
      if (!this.paused) this.restorePage();
    } finally {
      this.render();
      this.markReady();
    }
    const poll = window.setInterval(() => {
      if (this.isAlive()) void this.checkNavigation();
      else this.dispose();
    }, URL_POLL_MS);
    this.disposers.push(() => window.clearInterval(poll));
  }

  /**
   * False once the extension has been updated, reloaded or removed: this copy
   * of the script is orphaned and every chrome.* call would throw.
   */
  isAlive(): boolean {
    try {
      return !this.disposed && chrome.runtime?.id !== undefined;
    } catch {
      return false;
    }
  }

  /** Stops listening to the page. The UI host is left for the next instance to replace. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopOrphanWatch();
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // The extension context may already be gone.
      }
    }
    if (this.ui) render(null, this.ui.layer);
  }

  private listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
  ): void;
  private listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    capture?: boolean,
  ): void;
  private listen(target: EventTarget, type: string, handler: (event: never) => void, capture = false): void {
    const wrapped = (event: Event) => {
      if (!this.isAlive()) {
        this.dispose();
        return;
      }
      (handler as (event: Event) => void)(event);
    };
    target.addEventListener(type, wrapped, capture);
    this.disposers.push(() => target.removeEventListener(type, wrapped, capture));
  }

  private get root(): HTMLElement {
    return document.body ?? document.documentElement;
  }

  private render(): void {
    if (!this.ui || this.disposed) return;
    render(h(ContentApp, { state: { ...this.state }, actions: this.actions }), this.ui.layer);
  }

  private setState(patch: Partial<UiState>): void {
    Object.assign(this.state, patch);
    this.render();
  }

  private measure() {
    return this.ui ? measureDocument(this.ui) : { width: 1, height: 1 };
  }

  private toast(message: string): void {
    const id = ++this.toastSeq;
    this.setState({ toasts: [...this.state.toasts.filter((toast) => toast.message !== message), { id, message }] });
    window.setTimeout(() => this.actions.dismissToast(id), TOAST_MS);
  }

  /** Tracks a storage write; failures are reported to the user. */
  private persist(write: Promise<unknown>): void {
    this.pendingWrites++;
    write
      .catch(() => this.toast(t('toastSaveFailed')))
      .finally(() => {
        this.pendingWrites--;
        if (this.pendingWrites === 0 && this.needsResync) {
          this.needsResync = false;
          void getPage(this.url).then((page) => this.reconcile(page));
        }
      });
  }

  // -------------------------------------------------------------------------
  // Restore / teardown
  // -------------------------------------------------------------------------

  private restorePage(): void {
    const page = this.page;
    this.state.docSize = this.measure();
    this.state.notes = page ? [...page.notes] : [];
    this.state.stacking = this.state.notes.map((note) => note.id);
    this.refreshQuotes();
    this.drawHighlights(page?.highlights ?? []);
    this.startOrphanWatch();
  }

  /** Draws every highlight that is not on the page yet; unresolved ones become orphans. */
  private drawHighlights(highlights: readonly Highlight[]): void {
    const pending = highlights.filter((highlight) => !this.rendered.has(highlight.id));
    if (pending.length === 0) return;
    const index = buildTextIndex(this.root);
    for (const highlight of pending) {
      const found = resolveAnchor(highlight.anchor, index, document);
      if (found) {
        wrapOffsets(index, found.start, found.end, highlight.id, highlight.color);
        this.rendered.set(highlight.id, highlight.color);
        this.orphans.delete(highlight.id);
      } else {
        this.orphans.add(highlight.id);
      }
    }
  }

  /**
   * Single-page apps often render their content after the script runs. While
   * highlights are missing, retry after each burst of DOM changes; once the
   * page has been quiet for ORPHAN_QUIET_MS (or ORPHAN_RETRY_WINDOW_MS have
   * passed) record the final orphan list and tell the user about newly
   * orphaned highlights. A static page therefore reports within ~1.5 s.
   */
  private startOrphanWatch(): void {
    this.stopOrphanWatch();
    if (this.orphans.size === 0) {
      this.reportOrphans();
      return;
    }
    this.orphanDeadline = Date.now() + ORPHAN_RETRY_WINDOW_MS;
    this.orphanObserver = new MutationObserver(() => this.onPageMutation());
    this.observePage();
    this.armQuietTimer();
  }

  private observePage(): void {
    this.orphanObserver?.observe(this.root, { childList: true, subtree: true, characterData: true });
  }

  private onPageMutation(): void {
    window.clearTimeout(this.orphanTimer);
    this.orphanTimer = window.setTimeout(() => this.retryOrphans(), ORPHAN_RETRY_DEBOUNCE_MS);
    this.armQuietTimer();
  }

  private armQuietTimer(): void {
    window.clearTimeout(this.quietTimer);
    const wait = Math.max(0, Math.min(ORPHAN_QUIET_MS, this.orphanDeadline - Date.now()));
    this.quietTimer = window.setTimeout(() => this.finishOrphanWatch(), wait);
  }

  private stopOrphanWatch(): void {
    this.orphanObserver?.disconnect();
    this.orphanObserver = null;
    window.clearTimeout(this.orphanTimer);
    window.clearTimeout(this.quietTimer);
  }

  private retryOrphans(): void {
    if (this.paused) return;
    const orphaned = (this.page?.highlights ?? []).filter((highlight) => this.orphans.has(highlight.id));
    // Our own wrapping must not count as a page change.
    this.orphanObserver?.disconnect();
    this.drawHighlights(orphaned);
    if (this.orphans.size === 0 || Date.now() >= this.orphanDeadline) {
      this.finishOrphanWatch();
      return;
    }
    this.observePage();
  }

  private finishOrphanWatch(): void {
    this.stopOrphanWatch();
    if (!this.paused) this.reportOrphans();
  }

  private reportOrphans(): void {
    const page = this.page;
    if (!page) return;
    const alreadyFlagged = new Set(page.highlights.filter((h) => h.orphaned).map((h) => h.id));
    const newlyOrphaned = [...this.orphans].filter((id) => !alreadyFlagged.has(id));
    const changed = newlyOrphaned.length > 0 || [...alreadyFlagged].some((id) => !this.orphans.has(id));
    if (changed) this.persist(setOrphans(this.url, new Set(this.orphans)));
    if (newlyOrphaned.length > 0) this.toast(t('toastOrphans', String(this.orphans.size)));
  }

  private teardown(): void {
    // Blurring the active editor flushes its pending save to the current page.
    (this.ui?.shadow.activeElement as HTMLElement | null)?.blur();
    this.stopOrphanWatch();
    removeAllMarks(document);
    this.rendered.clear();
    this.orphans.clear();
    this.setState({ notes: [], stacking: [], toolbar: null, menu: null, quotes: new Map(), focusNoteId: null });
  }

  private async checkNavigation(): Promise<void> {
    const current = normalizeUrl(location.href);
    if (current === this.url) return;
    this.teardown();
    this.url = current;
    this.page = await getPage(current);
    this.paused = isPausedUrl(location.href, this.settings.pausedSites);
    if (!this.paused) this.restorePage();
    this.render();
  }

  // -------------------------------------------------------------------------
  // Storage changes from any context
  // -------------------------------------------------------------------------

  private onStoreChange(change: StoreChange): void {
    if (change.type === 'settings') {
      this.applySettings(change.settings);
      return;
    }
    if (change.url !== this.url) return;
    if (this.pendingWrites > 0) {
      // Our own writes are in flight; re-read once they have all landed.
      this.needsResync = true;
      return;
    }
    this.reconcile(change.page);
  }

  private applySettings(settings: Settings): void {
    const wasPaused = this.paused;
    this.settings = settings;
    this.paused = isPausedUrl(location.href, settings.pausedSites);
    this.state.defaultColor = settings.defaultColor;
    if (!settings.showToolbar) this.state.toolbar = null;

    if (this.paused && !wasPaused) {
      this.teardown();
    } else if (!this.paused && wasPaused) {
      void getPage(this.url).then((page) => {
        this.page = page;
        this.restorePage();
        this.render();
      });
    }
    this.render();
  }

  /** Brings the page in line with its stored record (edits made in the side panel, imports, deletes). */
  private reconcile(page: PageData | null): void {
    this.page = page;
    if (this.paused) return;
    const stored = new Map((page?.highlights ?? []).map((highlight) => [highlight.id, highlight]));

    for (const id of [...this.rendered.keys()]) {
      const highlight = stored.get(id);
      if (!highlight) {
        removeMarks(id);
        this.rendered.delete(id);
      } else if (highlight.color !== this.rendered.get(id)) {
        recolorMarks(id, highlight.color);
        this.rendered.set(id, highlight.color);
      }
    }
    for (const id of [...this.orphans]) if (!stored.has(id)) this.orphans.delete(id);
    // New highlights (imported, or made in another tab on the same page). Known
    // orphans are left alone; drawHighlights returns early when nothing is new.
    this.drawHighlights([...stored.values()].filter((highlight) => !this.orphans.has(highlight.id)));

    const notes = page ? [...page.notes] : [];
    const ids = new Set(notes.map((note) => note.id));
    const stacking = [...this.state.stacking.filter((id) => ids.has(id))];
    for (const note of notes) if (!stacking.includes(note.id)) stacking.push(note.id);
    const menu = this.state.menu && stored.has(this.state.menu.highlightId) ? this.state.menu : null;
    this.state.notes = notes;
    this.state.stacking = stacking;
    this.state.menu = menu;
    this.refreshQuotes();
    this.render();
  }

  private refreshQuotes(): void {
    this.state.quotes = new Map(
      (this.page?.highlights ?? []).map((highlight) => [
        highlight.id,
        highlight.anchor.quote.exact.replace(/\s+/g, ' ').trim(),
      ]),
    );
  }

  /** Applies a local change to the in-memory page record (storage is updated separately). */
  private editPage(mutate: (page: PageData) => void): void {
    const page = this.page ?? {
      url: this.url,
      title: document.title,
      highlights: [],
      notes: [],
      updatedAt: Date.now(),
    };
    mutate(page);
    page.updatedAt = Date.now();
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // Page events: selection toolbar, highlight menu, resize
  // -------------------------------------------------------------------------

  private isFromUi(event: Event): boolean {
    return this.ui !== null && event.composedPath().includes(this.ui.host);
  }

  /** The current page selection, if it is something QuickNotes may highlight. */
  private selectedRange(): Range | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement;
    if (!element || !this.root.contains(element)) return null;
    if (this.ui && (this.ui.host === element || this.ui.host.contains(element))) return null;
    if (element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return null;
    if (!range.toString().trim()) return null;
    return range.cloneRange();
  }

  private updateToolbar(): void {
    if (this.paused || !this.settings.showToolbar) {
      if (this.state.toolbar) this.setState({ toolbar: null });
      return;
    }
    const range = this.selectedRange();
    if (!range) {
      if (this.state.toolbar) this.setState({ toolbar: null });
      return;
    }
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? (rects[0] as DOMRect) : range.getBoundingClientRect();
    const bounds = range.getBoundingClientRect();
    // Horizontally center on the selection, vertically sit above its first line.
    const anchorRect = new DOMRect(bounds.left, rect.top, bounds.width, rect.height || bounds.height);
    this.setState({ toolbar: placeNear(anchorRect, TOOLBAR_HALF_WIDTH), menu: null });
  }

  private bindPageEvents(): void {
    this.listen(document, 'mouseup', (event) => {
      if (this.isFromUi(event)) return;
      window.setTimeout(() => this.updateToolbar(), 0);
    });
    this.listen(document, 'keyup', (event) => {
      if (this.isFromUi(event)) return;
      if (event.key === 'Escape') {
        this.setState({ toolbar: null, menu: null });
      } else if (event.shiftKey || event.key === 'Shift' || ((event.ctrlKey || event.metaKey) && event.key === 'a')) {
        this.updateToolbar();
      }
    });
    this.listen(document, 'mousedown', (event) => {
      if (this.isFromUi(event)) return;
      if (this.state.toolbar || this.state.menu) this.setState({ toolbar: null, menu: null });
    });
    this.listen(document, 'selectionchange', () => {
      if (!this.state.toolbar) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) this.setState({ toolbar: null });
    });
    this.listen(window, 'click', (event) => this.onPageClick(event), true);
    this.listen(window, 'resize', () => this.scheduleMeasure());
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.scheduleMeasure());
      observer.observe(this.root);
      this.disposers.push(() => observer.disconnect());
    }
  }

  private scheduleMeasure(): void {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      const size = this.measure();
      const { width, height } = this.state.docSize;
      if (size.width !== width || size.height !== height) this.setState({ docSize: size });
    }, 150);
  }

  private onPageClick(event: MouseEvent): void {
    if (this.paused || this.isFromUi(event)) return;
    const mark = markFromEvent(event);
    if (!mark || mark.closest('a[href]')) {
      if (this.state.menu) this.setState({ menu: null });
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    const id = mark.getAttribute(ID_ATTRIBUTE);
    if (!id) return;
    this.setState({
      toolbar: null,
      menu: {
        highlightId: id,
        color: this.rendered.get(id) ?? this.settings.defaultColor,
        hasNote: this.state.notes.some((note) => note.highlightId === id),
        position: placeNear(mark.getBoundingClientRect(), MENU_HALF_WIDTH),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Highlights
  // -------------------------------------------------------------------------

  private highlightSelection(color: Color, withNote: boolean, fallbackText?: string): Reply {
    if (this.paused) {
      this.toast(t('toastPaused'));
      return fail('paused');
    }
    const range = this.selectedRange() ?? (fallbackText ? this.uniqueTextRange(fallbackText) : null);
    if (!range) {
      this.toast(t('toastSelectText'));
      return fail('no-selection');
    }
    const index = buildTextIndex(this.root);
    const anchor = describeRange(range, index);
    if (!anchor) {
      this.toast(t('toastCannotHighlight'));
      return fail('cannot-highlight');
    }
    const rect = range.getBoundingClientRect();
    const now = Date.now();
    const highlight: Highlight = { id: crypto.randomUUID(), anchor, color, createdAt: now, updatedAt: now };

    wrapOffsets(index, anchor.position.start, anchor.position.end, highlight.id, color);
    this.rendered.set(highlight.id, color);
    window.getSelection()?.removeAllRanges();

    this.editPage((page) => page.highlights.push(highlight));
    this.persist(saveHighlight(this.url, highlight, document.title));
    this.refreshQuotes();
    this.state.toolbar = null;
    if (withNote) this.createNote({ highlightId: highlight.id, near: rect });
    else this.render();
    return ok(undefined);
  }

  /** A range for `text` when it occurs exactly once on the page. */
  private uniqueTextRange(text: string): Range | null {
    const index = buildTextIndex(this.root);
    const matches = findText(index, text);
    const only = matches.length === 1 ? matches[0] : undefined;
    return only ? rangeFromOffsets(index, only.start, only.end, document) : null;
  }

  private recolorHighlight(id: string, color: Color): void {
    const highlight = this.page?.highlights.find((item) => item.id === id);
    if (!highlight) return;
    const updated: Highlight = { ...highlight, color, updatedAt: Date.now() };
    recolorMarks(id, color);
    this.rendered.set(id, color);
    this.editPage((page) => {
      page.highlights = page.highlights.map((item) => (item.id === id ? updated : item));
    });
    this.persist(saveHighlight(this.url, updated, document.title));
    const menu = this.state.menu?.highlightId === id ? { ...this.state.menu, color } : this.state.menu;
    this.setState({ menu });
  }

  private deleteHighlight(id: string): void {
    removeMarks(id);
    this.rendered.delete(id);
    this.orphans.delete(id);
    const unlink = (note: StickyNote) => {
      if (note.highlightId !== id) return note;
      const copy = { ...note };
      delete copy.highlightId;
      return copy;
    };
    this.editPage((page) => {
      page.highlights = page.highlights.filter((item) => item.id !== id);
      page.notes = page.notes.map(unlink);
    });
    this.persist(removeHighlight(this.url, id));
    this.refreshQuotes();
    this.setState({ menu: null, notes: this.state.notes.map(unlink) });
  }

  private noteForHighlight(id: string): void {
    const existing = this.state.notes.find((note) => note.highlightId === id);
    this.state.menu = null;
    if (existing) {
      if (existing.minimized) this.updateNote(existing.id, { minimized: false });
      this.state.focusNoteId = existing.id;
      this.scrollToNote(existing.id);
      return;
    }
    const mark = marksFor(id)[0];
    this.createNote({ highlightId: id, near: mark?.getBoundingClientRect() });
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  private createNote({ highlightId, near }: { highlightId?: string; near?: DOMRect } = {}): StickyNote {
    const docSize = this.measure();
    const size = { ...NOTE_DEFAULT_SIZE };
    let left: number;
    let top: number;
    if (near && (near.width > 0 || near.height > 0)) {
      left = near.right + window.scrollX + 12;
      if (left + size.width > window.scrollX + window.innerWidth - 8) {
        left = Math.max(window.scrollX + 8, near.left + window.scrollX - size.width - 12);
      }
      top = near.top + window.scrollY;
    } else {
      const offset = (this.createdThisSession % 5) * 24;
      left = window.scrollX + (window.innerWidth - size.width) / 2 + offset;
      top = window.scrollY + window.innerHeight * 0.2 + offset;
    }
    this.createdThisSession++;

    const now = Date.now();
    const note: StickyNote = {
      id: crypto.randomUUID(),
      html: '',
      color: this.settings.defaultColor,
      position: pixelsToPercent(left, top, docSize),
      size,
      minimized: false,
      createdAt: now,
      updatedAt: now,
    };
    if (highlightId) note.highlightId = highlightId;

    this.editPage((page) => page.notes.push(note));
    this.persist(saveNote(this.url, note, document.title));
    this.setState({
      docSize,
      notes: [...this.state.notes, note],
      stacking: [...this.state.stacking, note.id],
      focusNoteId: note.id,
      toolbar: null,
      menu: null,
    });
    return note;
  }

  private updateNote(id: string, patch: NotePatch): void {
    const current = this.state.notes.find((note) => note.id === id);
    if (!current) return;
    const updated: StickyNote = { ...current, ...patch, updatedAt: Date.now() };
    this.editPage((page) => {
      page.notes = page.notes.some((note) => note.id === id)
        ? page.notes.map((note) => (note.id === id ? updated : note))
        : [...page.notes, updated];
    });
    this.persist(saveNote(this.url, updated, document.title));
    this.setState({ notes: this.state.notes.map((note) => (note.id === id ? updated : note)) });
  }

  private deleteNote(id: string): void {
    this.editPage((page) => {
      page.notes = page.notes.filter((note) => note.id !== id);
    });
    this.persist(removeNote(this.url, id));
    this.setState({
      notes: this.state.notes.filter((note) => note.id !== id),
      stacking: this.state.stacking.filter((item) => item !== id),
    });
  }

  private activateNote(id: string): void {
    const stacking = this.state.stacking;
    if (stacking[stacking.length - 1] === id) return;
    this.setState({ stacking: [...stacking.filter((item) => item !== id), id] });
  }

  private scrollToNote(id: string): boolean {
    const note = this.state.notes.find((item) => item.id === id);
    if (!note) return false;
    const docSize = this.measure();
    const { left, top } = percentToPixels(note.position, docSize, note.size);
    window.scrollTo({
      left: Math.max(0, left - window.innerWidth / 2 + note.size.width / 2),
      top: Math.max(0, top - window.innerHeight / 3),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    this.activateNote(id);
    this.setState({ docSize, flashNoteId: id });
    window.setTimeout(() => {
      if (this.state.flashNoteId === id) this.setState({ flashNoteId: null });
    }, 1300);
    return true;
  }

  private scrollToItem(id: string): Reply {
    const marks = marksFor(id);
    const first = marks[0];
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      flashMarks(id);
      return ok(undefined);
    }
    return this.scrollToNote(id) ? ok(undefined) : fail('not-found');
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private status(): PageStatus {
    return {
      url: this.url,
      title: document.title,
      paused: this.paused,
      highlights: this.page?.highlights.length ?? 0,
      notes: this.page?.notes.length ?? 0,
      orphans: [...this.orphans],
    };
  }

  private readonly onMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (reply: Reply<unknown>) => void,
  ): boolean | undefined => {
    if (sender.id !== chrome.runtime.id || !isContentMessage(message)) return undefined;
    if (message.type === 'qn:ping') {
      sendResponse(ok({ ready: true }));
      return undefined;
    }
    this.ready
      .then(() => this.handle(message))
      .then(sendResponse, (error: unknown) => sendResponse(fail('failed', String(error))));
    return true;
  };

  private handle(message: Exclude<ContentMessage, { type: 'qn:ping' }>): Reply<unknown> {
    switch (message.type) {
      case 'qn:get-status':
        return ok(this.status());
      case 'qn:new-note':
        if (this.paused) {
          this.toast(t('toastPaused'));
          return fail('paused');
        }
        this.createNote();
        return ok(undefined);
      case 'qn:highlight-selection':
        return this.highlightSelection(message.color ?? this.settings.defaultColor, false, message.text);
      case 'qn:scroll-to':
        return this.scrollToItem(message.id);
    }
  }
}

declare global {
  var __quicknotes__: QuickNotesController | undefined;
}

// Idempotent bootstrap: executeScript may run this file again in the same tab
// (and the registered script may already have run); only the first run starts,
// unless the previous instance belongs to an extension version that is gone.
if (!globalThis.__quicknotes__?.isAlive()) {
  globalThis.__quicknotes__?.dispose();
  const controller = new QuickNotesController();
  globalThis.__quicknotes__ = controller;
  void controller.start();
}
