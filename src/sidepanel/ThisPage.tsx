/**
 * "This page": the highlights and notes stored for the page in the active tab.
 * Clicking one asks the content script to scroll to it and flash it; orphaned
 * highlights (not found on the page last time it was checked) get their own
 * section. The page can be exported to Markdown or JSON from here.
 */
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { exportFileName, pageToMarkdown, toJsonExport } from '../lib/markdown';
import { sendToBackground, type ContentMessage, type PageStatus, type Reply } from '../lib/messages';
import { pageItems, type SearchItem } from '../lib/search';
import { getPage, getSettings, removeHighlight, removeNote, subscribe } from '../lib/storage';
import type { PageData } from '../lib/types';
import { hostOf, isPausedUrl, isSupportedUrl, normalizeUrl, siteOf } from '../lib/url';
import { downloadText } from '../ui/download';
import { DownloadIcon, ItemRow, SectionTitle } from './components';

interface Target {
  tabId: number;
  url: string;
  title: string;
}

/**
 * The page in the active tab. Its URL is visible when the user has acted on the
 * tab (activeTab) or granted the optional host permission — otherwise the
 * content script, if it runs there, tells us.
 */
async function currentTarget(): Promise<Target | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return null;
  if (tab.url) {
    return isSupportedUrl(tab.url) ? { tabId: tab.id, url: normalizeUrl(tab.url), title: tab.title ?? '' } : null;
  }
  try {
    const message: ContentMessage = { type: 'qn:get-status' };
    const reply = await chrome.tabs.sendMessage<ContentMessage, Reply<PageStatus> | undefined>(tab.id, message, {
      frameId: 0,
    });
    return reply?.ok ? { tabId: tab.id, url: reply.data.url, title: reply.data.title } : null;
  } catch {
    return null;
  }
}

export function ThisPage() {
  const [target, setTarget] = useState<Target | null>(null);
  const [page, setPage] = useState<PageData | null>(null);
  const [paused, setPaused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const next = await currentTarget();
      const [stored, settings] = await Promise.all([next ? getPage(next.url) : null, getSettings()]);
      if (!alive) return;
      setTarget(next);
      setPage(stored);
      setPaused(next ? isPausedUrl(next.url, settings.pausedSites) : false);
      setUnreachable(false);
      setLoaded(true);
    };
    void refresh();
    const onActivated = () => void refresh();
    const onUpdated = (_id: number, info: { url?: string; status?: string }) => {
      if (info.url !== undefined || info.status === 'complete') void refresh();
    };
    const onFocus = () => void refresh();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocus);
    return () => {
      alive = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocus);
    };
  }, []);

  useEffect(() => {
    if (!target) return undefined;
    return subscribe((change) => {
      if (change.type === 'page' && change.url === target.url) setPage(change.page);
      else if (change.type === 'settings') setPaused(isPausedUrl(target.url, change.settings.pausedSites));
    });
  }, [target]);

  const scrollTo = async (id: string) => {
    if (!target) return;
    const reply = await sendToBackground({ type: 'qn:bg:scroll-to', tabId: target.tabId, id });
    setUnreachable(!reply.ok && reply.error !== 'paused' && reply.error !== 'not-found');
  };

  const remove = (item: SearchItem) => {
    if (!target) return;
    void (item.kind === 'highlight' ? removeHighlight(target.url, item.id) : removeNote(target.url, item.id));
  };

  if (!loaded) return null;
  if (!target) return <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('sidePanelNoPage')}</p>;

  const items = page ? pageItems(page) : [];
  const highlights = items.filter((item) => item.kind === 'highlight' && !item.orphaned);
  const orphans = items.filter((item) => item.kind === 'highlight' && item.orphaned);
  const notes = items.filter((item) => item.kind === 'note');
  const quotes = new Map(highlights.concat(orphans).map((item) => [item.id, item.text]));
  const title = page?.title || target.title || siteOf(hostOf(target.url)) || target.url;

  const exportMarkdown = () => {
    if (page) downloadText(exportFileName('md', page), pageToMarkdown(page), 'text/markdown');
  };
  const exportJson = () => {
    if (page) downloadText(exportFileName('json', page), toJsonExport([page]), 'application/json');
  };

  return (
    <>
      <div class="flex flex-col gap-1">
        <h2 class="line-clamp-2 text-[15px] font-semibold leading-snug" data-testid="page-title">
          {title}
        </h2>
        <p class="truncate text-[12px] text-ink-faint" title={target.url}>
          {target.url}
        </p>
      </div>

      {paused && (
        <p
          role="status"
          class="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
        >
          {t('sidePanelPaused')}
        </p>
      )}
      {unreachable && (
        <p
          role="status"
          class="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
        >
          {t('sidePanelUnreachable')}
        </p>
      )}

      {items.length === 0 ? (
        <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('sidePanelEmpty')}</p>
      ) : (
        <>
          {highlights.length > 0 && (
            <section aria-labelledby="sp-highlights" class="flex flex-col gap-2">
              <SectionTitle id="sp-highlights" count={highlights.length}>
                {t('popupHighlights')}
              </SectionTitle>
              <ul class="flex flex-col gap-2">
                {highlights.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onOpen={() => void scrollTo(item.id)}
                    onDelete={() => remove(item)}
                  />
                ))}
              </ul>
            </section>
          )}

          {notes.length > 0 && (
            <section aria-labelledby="sp-notes" class="flex flex-col gap-2">
              <SectionTitle id="sp-notes" count={notes.length}>
                {t('popupNotes')}
              </SectionTitle>
              <ul class="flex flex-col gap-2">
                {notes.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    quote={
                      item.kind === 'note' && item.note.highlightId ? quotes.get(item.note.highlightId) : undefined
                    }
                    onOpen={() => void scrollTo(item.id)}
                    onDelete={() => remove(item)}
                  />
                ))}
              </ul>
            </section>
          )}

          {orphans.length > 0 && (
            <section aria-labelledby="sp-orphans" class="flex flex-col gap-2" data-testid="orphans">
              <SectionTitle id="sp-orphans" count={orphans.length}>
                {t('sidePanelOrphanedTitle')}
              </SectionTitle>
              <p class="text-[12px] text-ink-soft dark:text-[#cfc8bb]">{t('sidePanelOrphanedHelp')}</p>
              <ul class="flex flex-col gap-2">
                {orphans.map((item) => (
                  <ItemRow key={item.id} item={item} onDelete={() => remove(item)} />
                ))}
              </ul>
            </section>
          )}

          <section
            aria-labelledby="sp-export"
            class="mt-1 flex flex-col gap-2 border-t border-paper-line pt-3 dark:border-[#3a352f]"
          >
            <SectionTitle id="sp-export">{t('sidePanelExportPage')}</SectionTitle>
            <div class="flex gap-2">
              <button
                type="button"
                class="qn-btn-secondary flex-1"
                data-testid="export-page-md"
                onClick={exportMarkdown}
              >
                <DownloadIcon />
                {t('sidePanelExportMarkdown')}
              </button>
              <button type="button" class="qn-btn-secondary flex-1" data-testid="export-page-json" onClick={exportJson}>
                <DownloadIcon />
                {t('sidePanelExportJson')}
              </button>
            </div>
          </section>
        </>
      )}
    </>
  );
}
