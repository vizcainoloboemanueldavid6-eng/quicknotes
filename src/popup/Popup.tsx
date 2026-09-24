/**
 * Popup: summary of the current page, "New note", "Open side panel" and the
 * "Pause on this site" switch. Opening the popup is a user action on the tab,
 * so it also injects the content script (unless the site is paused), which
 * restores the page's highlights and notes.
 */
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { sendToBackground, type PageStatus } from '../lib/messages';
import { getPage, getSettings, setSitePaused, subscribe } from '../lib/storage';
import { hostOf, isPausedUrl, isSupportedUrl, siteOf } from '../lib/url';

interface TabInfo {
  id: number;
  windowId: number;
  url: string;
}

interface Summary {
  highlights: number;
  notes: number;
  orphans: number;
}

async function activeTab(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return null;
  return { id: tab.id, windowId: tab.windowId, url: tab.url };
}

async function readSummary(url: string): Promise<Summary> {
  const page = await getPage(url);
  return {
    highlights: page?.highlights.length ?? 0,
    notes: page?.notes.length ?? 0,
    orphans: page?.highlights.filter((highlight) => highlight.orphaned).length ?? 0,
  };
}

async function shortcutLabel(): Promise<string> {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === 'new-note')?.shortcut ?? '';
  } catch {
    return '';
  }
}

export function Popup() {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<Summary>({ highlights: 0, notes: 0, orphans: 0 });
  const [shortcut, setShortcut] = useState('');
  const [error, setError] = useState(false);

  const supported = tab !== null && isSupportedUrl(tab.url);
  const site = tab ? siteOf(hostOf(tab.url)) : '';

  useEffect(() => {
    void (async () => {
      const [current, settings, keys] = await Promise.all([activeTab(), getSettings(), shortcutLabel()]);
      setTab(current);
      setShortcut(keys);
      if (current && isSupportedUrl(current.url)) {
        const isPaused = isPausedUrl(current.url, settings.pausedSites);
        setPaused(isPaused);
        setSummary(await readSummary(current.url));
        if (!isPaused) {
          const reply = await sendToBackground<PageStatus>({ type: 'qn:bg:get-status', tabId: current.id });
          if (reply.ok) {
            setSummary({
              highlights: reply.data.highlights,
              notes: reply.data.notes,
              orphans: reply.data.orphans.length,
            });
          }
        }
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!tab) return undefined;
    return subscribe((change) => {
      if (change.type === 'settings') setPaused(isPausedUrl(tab.url, change.settings.pausedSites));
      else void readSummary(tab.url).then(setSummary);
    });
  }, [tab]);

  const newNote = async () => {
    if (!tab) return;
    const reply = await sendToBackground({ type: 'qn:bg:new-note', tabId: tab.id });
    if (reply.ok) window.close();
    else setError(true);
  };

  const openSidePanel = () => {
    if (!tab) return;
    // Must run inside the click (user gesture): no await before open().
    chrome.sidePanel.open({ windowId: tab.windowId }).then(
      () => window.close(),
      () => setError(true),
    );
  };

  const togglePause = async () => {
    if (!tab) return;
    const next = !paused;
    setPaused(next);
    await setSitePaused(tab.url, next);
    if (!next) {
      const reply = await sendToBackground({ type: 'qn:bg:inject', tabId: tab.id });
      if (!reply.ok) setError(true);
    }
  };

  return (
    <main class="flex flex-col gap-3 p-4">
      <header class="flex items-center gap-2">
        <img src="/icons/icon-32.png" width="24" height="24" alt="" />
        <h1 class="flex-1 text-[16px] font-semibold">{t('extShortName')}</h1>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-[13px] text-ink-soft hover:bg-primary-soft hover:text-ink dark:text-[#cfc8bb] dark:hover:bg-[#35302a]"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          {t('popupOptions')}
        </button>
      </header>

      {loaded && !supported ? (
        <p class="qn-card p-3 text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('popupUnsupported')}</p>
      ) : (
        <>
          <p class="truncate text-[12px] text-ink-faint" title={tab?.url}>
            {site}
          </p>
          <dl class="grid grid-cols-2 gap-2">
            <div class="qn-card px-3 py-2">
              <dt class="text-[12px] text-ink-soft dark:text-[#cfc8bb]">{t('popupHighlights')}</dt>
              <dd class="text-[22px] font-semibold tabular-nums" data-testid="count-highlights">
                {summary.highlights}
              </dd>
            </div>
            <div class="qn-card px-3 py-2">
              <dt class="text-[12px] text-ink-soft dark:text-[#cfc8bb]">{t('popupNotes')}</dt>
              <dd class="text-[22px] font-semibold tabular-nums" data-testid="count-notes">
                {summary.notes}
              </dd>
            </div>
          </dl>
          {summary.orphans > 0 && (
            <p class="text-[12px] text-amber-800 dark:text-amber-300">{t('popupNotFound', String(summary.orphans))}</p>
          )}

          <div class="flex flex-col gap-2">
            <button
              type="button"
              class="qn-btn-primary w-full"
              disabled={!loaded || paused}
              onClick={() => void newNote()}
            >
              {t('popupNewNote')}
            </button>
            <button type="button" class="qn-btn-secondary w-full" disabled={!tab} onClick={openSidePanel}>
              {t('popupOpenSidePanel')}
            </button>
          </div>

          <label class="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1">
            <span class="flex-1">
              <span class="block text-[14px] font-medium">{t('popupPauseSite')}</span>
              {paused && (
                <span class="block text-[12px] text-ink-soft dark:text-[#cfc8bb]">{t('popupPausedHint', site)}</span>
              )}
            </span>
            <input
              type="checkbox"
              role="switch"
              class="peer sr-only"
              checked={paused}
              disabled={!loaded}
              onChange={() => void togglePause()}
            />
            <span
              aria-hidden="true"
              class="relative h-6 w-10 shrink-0 rounded-full bg-[#d6cfc1] transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-primary-dark peer-checked:after:translate-x-4 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary-dark dark:bg-[#4a443c]"
            />
          </label>

          {error && <p class="text-[12px] text-red-700 dark:text-red-300">{t('popupError')}</p>}
          {shortcut && !paused && <p class="text-[12px] text-ink-faint">{t('popupShortcutHint', shortcut)}</p>}
        </>
      )}
    </main>
  );
}
