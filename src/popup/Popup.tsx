/**
 * Popup: summary of the current page, "New note", "Open side panel" and the
 * "Pause on this site" switch. Opening the popup is a user action on the tab,
 * so it also injects the content script (unless the site is paused), which
 * restores the page's highlights and notes.
 *
 * Files on the user's computer (file://) have no site: the switch is replaced
 * by a short explanation, and when Chrome's "Allow access to file URLs" is off
 * for the extension, the popup says how to turn it on instead of failing.
 */
import { useEffect, useState } from 'preact/hooks';
import { t, type MessageKey } from '../lib/i18n';
import { sendToBackground, type PageStatus } from '../lib/messages';
import { getPage, getSettings, setUrlPaused, SettingsTooLargeError, subscribe } from '../lib/storage';
import { canPauseUrl, hostOf, isSupportedUrl, pausedEntryFor, siteOf } from '../lib/url';

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

function isFileUrl(url: string): boolean {
  return url.startsWith('file:');
}

async function fileAccessAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

export function Popup() {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The paused-sites entry that pauses this page (its site or a parent domain), if any. */
  const [pausedBy, setPausedBy] = useState<string | null>(null);
  /** The switch position while a change is being saved; the saved settings decide afterwards. */
  const [pending, setPending] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<Summary>({ highlights: 0, notes: 0, orphans: 0 });
  const [shortcut, setShortcut] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  /** false on a file:// page when Chrome does not let the extension run on local files. */
  const [fileAccess, setFileAccess] = useState(true);
  /**
   * Without file access Chrome does not even reveal a file:// tab's URL, so such a
   * page looks like any page QuickNotes cannot run on; the popup then mentions
   * the setting, in case it is a local file.
   */
  const [fileHint, setFileHint] = useState(false);
  // Known even on pages QuickNotes cannot run on, so the side panel ("All notes") opens from anywhere.
  const [windowId, setWindowId] = useState<number | null>(null);

  const supported = tab !== null && isSupportedUrl(tab.url);
  const pausable = tab !== null && canPauseUrl(tab.url);
  const paused = pausedBy !== null;
  const site = tab ? siteOf(hostOf(tab.url)) || t('sidePanelLocalFiles') : '';

  useEffect(() => {
    void chrome.windows.getCurrent().then(
      (current) => setWindowId(current.id ?? null),
      () => setWindowId(null),
    );
    void (async () => {
      const [current, settings, keys] = await Promise.all([activeTab(), getSettings(), shortcutLabel()]);
      setTab(current);
      setShortcut(keys);
      if (!current) setFileHint(!(await fileAccessAllowed()));
      if (current && isSupportedUrl(current.url)) {
        const entry = pausedEntryFor(current.url, settings.pausedSites);
        const allowed = !isFileUrl(current.url) || (await fileAccessAllowed());
        setPausedBy(entry);
        setFileAccess(allowed);
        setSummary(await readSummary(current.url));
        if (entry === null && allowed) {
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
      if (change.type === 'settings') setPausedBy(pausedEntryFor(tab.url, change.settings.pausedSites));
      else void readSummary(tab.url).then(setSummary);
    });
  }, [tab]);

  const newNote = async () => {
    if (!tab) return;
    const reply = await sendToBackground({ type: 'qn:bg:new-note', tabId: tab.id });
    if (reply.ok) window.close();
    else setError('popupError');
  };

  const openSidePanel = () => {
    const target = tab?.windowId ?? windowId;
    if (target === null) return;
    // Must run inside the click (user gesture): no await before open().
    chrome.sidePanel.open({ windowId: target }).then(
      () => window.close(),
      () => setError('popupError'),
    );
  };

  const openExtensionDetails = () => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).then(() => window.close());
  };

  const togglePause = async () => {
    if (!tab || pending !== null) return;
    const next = !paused;
    setPending(next);
    setError(null);
    try {
      const settings = await setUrlPaused(tab.url, next);
      const entry = pausedEntryFor(tab.url, settings.pausedSites);
      setPausedBy(entry);
      if (entry === null) {
        const reply = await sendToBackground({ type: 'qn:bg:inject', tabId: tab.id });
        if (!reply.ok) setError('popupError');
      }
    } catch (failure) {
      setError(failure instanceof SettingsTooLargeError ? 'settingsTooLarge' : 'settingsSaveFailed');
    } finally {
      setPending(null);
    }
  };

  const switchOn = pending ?? paused;

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
        <>
          <p class="qn-card p-3 text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('popupUnsupported')}</p>
          <button type="button" class="qn-btn-secondary w-full" disabled={windowId === null} onClick={openSidePanel}>
            {t('popupOpenSidePanel')}
          </button>
          {fileHint && (
            <div class="flex flex-col gap-2" data-testid="file-access-hint">
              <p class="text-[12px] text-ink-soft dark:text-[#cfc8bb]">{t('popupFileAccessMaybe')}</p>
              <button type="button" class="qn-btn-secondary w-full" onClick={openExtensionDetails}>
                {t('popupFileAccessButton')}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p class="truncate text-[12px] text-ink-faint" title={tab?.url} data-testid="site">
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

          {!fileAccess && (
            <div class="qn-card flex flex-col gap-2 p-3" data-testid="file-access">
              <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('popupFileAccess')}</p>
              <button type="button" class="qn-btn-secondary w-full" onClick={openExtensionDetails}>
                {t('popupFileAccessButton')}
              </button>
            </div>
          )}

          <div class="flex flex-col gap-2">
            <button
              type="button"
              class="qn-btn-primary w-full"
              disabled={!loaded || paused || !fileAccess}
              onClick={() => void newNote()}
            >
              {t('popupNewNote')}
            </button>
            <button
              type="button"
              class="qn-btn-secondary w-full"
              disabled={!tab && windowId === null}
              onClick={openSidePanel}
            >
              {t('popupOpenSidePanel')}
            </button>
          </div>

          {!loaded || pausable ? (
            <label class="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1">
              <span class="flex-1">
                <span class="block text-[14px] font-medium">{t('popupPauseSite')}</span>
                {paused && pending === null && (
                  <span class="block text-[12px] text-ink-soft dark:text-[#cfc8bb]" data-testid="paused-hint">
                    {t('popupPausedHint', pausedBy ?? site)}
                  </span>
                )}
              </span>
              <input
                type="checkbox"
                role="switch"
                class="peer sr-only"
                checked={switchOn}
                disabled={!loaded || pending !== null}
                onChange={() => void togglePause()}
              />
              <span
                aria-hidden="true"
                class="relative h-6 w-10 shrink-0 rounded-full bg-[#d6cfc1] transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-primary-dark peer-checked:after:translate-x-4 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary-dark dark:bg-[#4a443c]"
              />
            </label>
          ) : (
            fileAccess && (
              <p class="text-[12px] text-ink-soft dark:text-[#cfc8bb]" data-testid="local-file">
                {t('popupLocalFile')}
              </p>
            )
          )}

          {error && (
            <p class="text-[12px] text-red-700 dark:text-red-300" role="alert">
              {t(error)}
            </p>
          )}
          {shortcut && !paused && fileAccess && (
            <p class="text-[12px] text-ink-faint">{t('popupShortcutHint', shortcut)}</p>
          )}
        </>
      )}
    </main>
  );
}
