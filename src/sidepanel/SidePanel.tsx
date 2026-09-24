/**
 * Side panel — current page: every highlight and note on the page in the active
 * tab; clicking one scrolls the page to it. Orphaned highlights (not found on
 * the page) are listed with a badge.
 */
import { useEffect, useState } from 'preact/hooks';
import { PALETTE } from '../lib/colors';
import { colorName, t } from '../lib/i18n';
import { sendToBackground, type ContentMessage, type PageStatus, type Reply } from '../lib/messages';
import { htmlToText } from '../lib/richtext';
import { getPage, subscribe } from '../lib/storage';
import type { PageData } from '../lib/types';
import { isSupportedUrl, normalizeUrl } from '../lib/url';

interface Target {
  tabId: number;
  url: string;
}

/**
 * The page in the active tab. Its URL is visible when the user has acted on the
 * tab (activeTab) — otherwise the content script, if present, tells us.
 */
async function currentTarget(): Promise<Target | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return null;
  if (tab.url) return isSupportedUrl(tab.url) ? { tabId: tab.id, url: normalizeUrl(tab.url) } : null;
  try {
    const message: ContentMessage = { type: 'qn:get-status' };
    const reply = await chrome.tabs.sendMessage<ContentMessage, Reply<PageStatus> | undefined>(tab.id, message, {
      frameId: 0,
    });
    return reply?.ok ? { tabId: tab.id, url: reply.data.url } : null;
  } catch {
    return null;
  }
}

export function SidePanel() {
  const [target, setTarget] = useState<Target | null>(null);
  const [page, setPage] = useState<PageData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const refresh = async () => {
      const next = await currentTarget();
      setTarget(next);
      setPage(next ? await getPage(next.url) : null);
      setLoaded(true);
    };
    void refresh();
    const onActivated = () => void refresh();
    const onUpdated = (_id: number, info: { url?: string; status?: string }) => {
      if (info.url !== undefined || info.status === 'complete') void refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  useEffect(() => {
    if (!target) return undefined;
    return subscribe((change) => {
      if (change.type === 'page' && change.url === target.url) setPage(change.page);
    });
  }, [target]);

  const scrollTo = (id: string) => {
    if (target) void sendToBackground({ type: 'qn:bg:scroll-to', tabId: target.tabId, id });
  };

  const highlights = [...(page?.highlights ?? [])].sort((a, b) => a.anchor.position.start - b.anchor.position.start);
  const notes = page?.notes ?? [];

  return (
    <main class="flex min-h-screen flex-col gap-3 p-4">
      <header class="flex items-center gap-2">
        <img src="/icons/icon-32.png" width="24" height="24" alt="" />
        <h1 class="text-[16px] font-semibold">{t('sidePanelTitle')}</h1>
      </header>
      <h2 class="text-[13px] font-semibold uppercase tracking-wide text-ink-soft dark:text-[#cfc8bb]">
        {t('sidePanelThisPage')}
      </h2>

      {loaded && !target && <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('sidePanelNoPage')}</p>}
      {loaded && target && highlights.length + notes.length === 0 && (
        <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('sidePanelEmpty')}</p>
      )}

      {highlights.length > 0 && (
        <section aria-label={t('popupHighlights')} class="flex flex-col gap-2">
          <h3 class="text-[13px] font-semibold">
            {t('popupHighlights')} ({highlights.length})
          </h3>
          <ul class="flex flex-col gap-2">
            {highlights.map((highlight) => (
              <li key={highlight.id}>
                <button
                  type="button"
                  class="qn-card w-full p-3 text-left hover:border-primary"
                  onClick={() => scrollTo(highlight.id)}
                >
                  <span class="flex items-center gap-2 text-[12px] text-ink-soft dark:text-[#cfc8bb]">
                    <span
                      class="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: PALETTE[highlight.color].dot }}
                      aria-hidden="true"
                    />
                    {colorName(highlight.color)}
                    {highlight.orphaned && (
                      <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                        {t('sidePanelOrphaned')}
                      </span>
                    )}
                  </span>
                  <span class="mt-1 line-clamp-3 block text-[13px]">
                    “{highlight.anchor.quote.exact.replace(/\s+/g, ' ').trim()}”
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {notes.length > 0 && (
        <section aria-label={t('popupNotes')} class="flex flex-col gap-2">
          <h3 class="text-[13px] font-semibold">
            {t('popupNotes')} ({notes.length})
          </h3>
          <ul class="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  class="w-full rounded-xl border p-3 text-left text-ink shadow-paper"
                  style={{ backgroundColor: PALETTE[note.color].note, borderColor: PALETTE[note.color].edge }}
                  onClick={() => scrollTo(note.id)}
                >
                  <span class="line-clamp-4 block whitespace-pre-line text-[13px]">
                    {htmlToText(note.html) || t('noteEmpty')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
