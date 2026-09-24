/**
 * Side panel with two views:
 *  - "This page": highlights and notes of the page in the active tab (orphaned
 *    highlights in their own section); clicking one scrolls the page to it.
 *  - "All notes": every page with notes, full-text search, color and site
 *    filters, Markdown/JSON export and JSON import.
 */
import { useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { AllNotes } from './AllNotes';
import { ThisPage } from './ThisPage';

type View = 'page' | 'all';
const VIEWS: readonly View[] = ['page', 'all'];

export function SidePanel() {
  const [view, setView] = useState<View>('page');
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});

  const onTabKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = VIEWS.indexOf(view);
    const next =
      event.key === 'Home'
        ? VIEWS[0]
        : event.key === 'End'
          ? VIEWS[VIEWS.length - 1]
          : VIEWS[(index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
    if (!next) return;
    setView(next);
    tabRefs.current[next]?.focus();
  };

  const tab = (id: View, label: string) => (
    <button
      ref={(element) => {
        tabRefs.current[id] = element;
      }}
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-controls={`panel-${id}`}
      aria-selected={view === id}
      tabIndex={view === id ? 0 : -1}
      data-testid={`tab-${id}`}
      class={`h-8 flex-1 rounded-md px-3 text-[13px] font-medium transition-colors ${
        view === id
          ? 'bg-white text-ink shadow-sm dark:bg-[#3a352f] dark:text-[#f5f1e8]'
          : 'text-ink-soft hover:text-ink dark:text-[#cfc8bb] dark:hover:text-[#f5f1e8]'
      }`}
      onClick={() => setView(id)}
    >
      {label}
    </button>
  );

  return (
    <div class="flex min-h-screen flex-col">
      <header class="sticky top-0 z-10 flex flex-col gap-3 border-b border-paper-line bg-paper/95 px-4 pb-3 pt-4 backdrop-blur dark:border-[#3a352f] dark:bg-[#1f1c19]/95">
        <div class="flex items-center gap-2">
          <img src="/icons/icon-32.png" width="22" height="22" alt="" />
          <h1 class="text-[16px] font-semibold">{t('sidePanelTitle')}</h1>
        </div>
        <div
          role="tablist"
          aria-label={t('sidePanelViews')}
          class="flex gap-1 rounded-lg bg-[#efe9dc] p-1 dark:bg-[#2a2622]"
          onKeyDown={onTabKey}
        >
          {tab('page', t('sidePanelThisPage'))}
          {tab('all', t('sidePanelAllNotes'))}
        </div>
      </header>

      <main
        id={`panel-${view}`}
        role="tabpanel"
        aria-labelledby={`tab-${view}`}
        class="flex flex-1 flex-col gap-4 px-4 py-4"
      >
        {view === 'page' ? <ThisPage /> : <AllNotes />}
      </main>
    </div>
  );
}
