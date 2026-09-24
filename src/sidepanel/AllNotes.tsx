/**
 * "All notes": every page that has highlights or notes, most recently edited
 * first, with full-text search (see lib/search.ts), color and site filters,
 * Markdown/JSON export of everything and JSON import.
 *
 * Import strategy — merge, never replace: pages that exist only in the file are
 * added; for a page present on both sides, highlights and notes are matched by
 * id and the copy with the newer `updatedAt` wins; nothing already stored is
 * deleted. The file is validated first and nothing is written unless all of it
 * is valid.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { colorName, t, uiLanguage } from '../lib/i18n';
import { exportFileName, pageToMarkdown, pagesToMarkdown, parseJsonImport, toJsonExport } from '../lib/markdown';
import { sendToBackground } from '../lib/messages';
import { LOCAL_FILES_SITE, listSites, searchPages, summarize, type SearchItem } from '../lib/search';
import { deletePage, getAllPages, importPages, removeHighlight, removeNote, subscribe } from '../lib/storage';
import { COLORS, type Color, type PageData } from '../lib/types';
import { isSupportedUrl, normalizeUrl } from '../lib/url';
import { downloadText } from '../ui/download';
import {
  ColorDot,
  ConfirmButton,
  DownloadIcon,
  Highlighted,
  ItemRow,
  SearchIcon,
  SectionTitle,
  TrashIcon,
  UploadIcon,
} from './components';

/** chrome.storage.local holds 10 MB; a bigger file cannot be one of our exports. */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

type ImportState =
  | { kind: 'idle' }
  | { kind: 'done'; pages: number; highlights: number; notes: number }
  | { kind: 'error'; errors: string[] };

/**
 * Brings the page up: an open tab showing it is activated (and scrolled to the
 * item when the content script can be reached); otherwise it opens in a new tab.
 */
async function openPage(url: string, itemId?: string): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch((): chrome.tabs.Tab[] => []);
  // Tab URLs are only visible for tabs the extension may access; others open anew.
  const open = tabs.find((tab) => tab.url && isSupportedUrl(tab.url) && normalizeUrl(tab.url) === url);
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true }).catch(() => undefined);
    if (itemId) await sendToBackground({ type: 'qn:bg:scroll-to', tabId: open.id, id: itemId });
    return;
  }
  await chrome.tabs.create({ url });
}

function formatDay(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleDateString(uiLanguage(), { dateStyle: 'medium' });
  } catch {
    return new Date(timestamp).toDateString();
  }
}

function siteLabel(site: string): string {
  return site === LOCAL_FILES_SITE ? t('sidePanelLocalFiles') : site;
}

export function AllNotes() {
  const [pages, setPages] = useState<PageData[] | null>(null);
  const [query, setQuery] = useState('');
  const [colors, setColors] = useState<Color[]>([]);
  const [site, setSite] = useState('');
  const [importState, setImportState] = useState<ImportState>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () =>
      void getAllPages().then((all) => {
        if (alive) setPages(all);
      });
    load();
    const unsubscribe = subscribe((change) => {
      if (change.type !== 'page') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 120);
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const sites = useMemo(() => listSites(pages ?? []), [pages]);
  // A site filter whose last page was deleted falls back to "All sites".
  const activeSite = sites.some((entry) => entry.site === site) ? site : '';
  const results = useMemo(
    () => searchPages(pages ?? [], { query, colors, site: activeSite }),
    [pages, query, colors, activeSite],
  );
  const summary = summarize(results);
  const filtered = query.trim() !== '' || colors.length > 0 || activeSite !== '';

  const toggleColor = (color: Color) =>
    setColors((current) => (current.includes(color) ? current.filter((c) => c !== color) : [...current, color]));

  const clearFilters = () => {
    setQuery('');
    setColors([]);
    setSite('');
  };

  const removeItem = (page: PageData, item: SearchItem) =>
    void (item.kind === 'highlight' ? removeHighlight(page.url, item.id) : removeNote(page.url, item.id));

  const exportAll = (format: 'md' | 'json') => {
    const all = pages ?? [];
    if (format === 'md') downloadText(exportFileName('md'), pagesToMarkdown(all), 'text/markdown');
    else downloadText(exportFileName('json'), toJsonExport(all), 'application/json');
  };

  const onImportFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setImportState({ kind: 'error', errors: [t('sidePanelImportTooLarge')] });
      return;
    }
    const parsed = parseJsonImport(await file.text());
    if (!parsed.ok) {
      setImportState({ kind: 'error', errors: parsed.errors });
      return;
    }
    try {
      await importPages(parsed.pages, 'merge');
    } catch (error) {
      setImportState({ kind: 'error', errors: [error instanceof Error ? error.message : String(error)] });
      return;
    }
    setImportState({
      kind: 'done',
      pages: parsed.pages.length,
      highlights: parsed.pages.reduce((sum, page) => sum + page.highlights.length, 0),
      notes: parsed.pages.reduce((sum, page) => sum + page.notes.length, 0),
    });
  };

  if (pages === null) return null;

  return (
    <>
      <div class="flex flex-col gap-2">
        <label class="relative block">
          <span class="sr-only">{t('sidePanelSearch')}</span>
          <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint">
            <SearchIcon />
          </span>
          <input
            type="search"
            data-testid="search"
            class="h-9 w-full rounded-lg border border-paper-line bg-white pl-8 pr-3 text-[14px] dark:border-[#3a352f] dark:bg-[#2a2622]"
            placeholder={t('sidePanelSearchPlaceholder')}
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>

        <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('sidePanelFilterColor')}>
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              data-testid={`filter-${color}`}
              aria-pressed={colors.includes(color)}
              class={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors ${
                colors.includes(color)
                  ? 'border-ink bg-white font-semibold text-ink dark:border-[#f5f1e8] dark:bg-[#3a352f] dark:text-[#f5f1e8]'
                  : 'border-paper-line text-ink-soft hover:border-ink-faint dark:border-[#3a352f] dark:text-[#cfc8bb]'
              }`}
              onClick={() => toggleColor(color)}
            >
              <ColorDot color={color} />
              {colorName(color)}
            </button>
          ))}
        </div>

        <div class="flex items-center gap-2">
          <select
            data-testid="filter-site"
            aria-label={t('sidePanelFilterSite')}
            class="h-8 min-w-0 flex-1 rounded-lg border border-paper-line bg-white px-2 text-[13px] dark:border-[#3a352f] dark:bg-[#2a2622]"
            value={activeSite}
            onChange={(event) => setSite(event.currentTarget.value)}
          >
            <option value="">{t('sidePanelAllSites')}</option>
            {sites.map((entry) => (
              <option key={entry.site} value={entry.site}>
                {siteLabel(entry.site)} ({entry.count})
              </option>
            ))}
          </select>
          {filtered && (
            <button
              type="button"
              class="h-8 shrink-0 rounded-lg px-2 text-[13px] text-ink-soft underline-offset-2 hover:underline dark:text-[#cfc8bb]"
              onClick={clearFilters}
            >
              {t('sidePanelClearFilters')}
            </button>
          )}
        </div>

        <p class="text-[12px] tabular-nums text-ink-faint" aria-live="polite" data-testid="summary">
          {t('sidePanelSummary', [String(summary.pages), String(summary.highlights), String(summary.notes)])}
        </p>
      </div>

      {pages.length === 0 ? (
        <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('sidePanelNothingSaved')}</p>
      ) : results.length === 0 ? (
        <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('sidePanelNoResults')}</p>
      ) : (
        <div class="flex flex-col gap-5">
          {results.map(({ page, site: pageSite, items }) => {
            const title = page.title.trim() || page.url;
            const quotes = new Map(
              page.highlights.map((highlight) => [
                highlight.id,
                highlight.anchor.quote.exact.replace(/\s+/g, ' ').trim(),
              ]),
            );
            return (
              <section key={page.url} class="flex flex-col gap-2" data-testid="page-result" data-page-url={page.url}>
                <div class="flex items-start gap-1">
                  <button
                    type="button"
                    class="min-w-0 flex-1 rounded-md text-left hover:underline"
                    aria-label={t('sidePanelOpenPage', title)}
                    onClick={() => void openPage(page.url)}
                  >
                    <span class="line-clamp-2 block text-[14px] font-semibold leading-snug">
                      <Highlighted text={title} query={query} />
                    </span>
                    <span class="block truncate text-[12px] text-ink-faint">
                      {siteLabel(pageSite)} · {formatDay(page.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-primary-soft hover:text-ink dark:text-[#cfc8bb] dark:hover:bg-[#35302a]"
                    aria-label={t('sidePanelExportPageMarkdown', title)}
                    title={t('sidePanelExportPageMarkdown', title)}
                    data-testid="export-result-md"
                    onClick={() => downloadText(exportFileName('md', page), pageToMarkdown(page), 'text/markdown')}
                  >
                    <DownloadIcon />
                  </button>
                  <ConfirmButton
                    label={t('sidePanelDeletePage')}
                    confirmLabel={t('sidePanelConfirmDelete')}
                    onConfirm={() => void deletePage(page.url)}
                    idle={<TrashIcon />}
                    class="grid h-7 min-w-7 shrink-0 place-items-center rounded-md"
                    testId="delete-page"
                  />
                </div>
                <ul class="flex flex-col gap-2">
                  {items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      query={query}
                      quote={
                        item.kind === 'note' && item.note.highlightId ? quotes.get(item.note.highlightId) : undefined
                      }
                      onOpen={() => void openPage(page.url, item.id)}
                      onDelete={() => removeItem(page, item)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <section
        aria-labelledby="sp-data"
        class="mt-auto flex flex-col gap-2 border-t border-paper-line pt-3 dark:border-[#3a352f]"
      >
        <SectionTitle id="sp-data">{t('sidePanelExportAll')}</SectionTitle>
        <div class="flex gap-2">
          <button
            type="button"
            class="qn-btn-secondary flex-1"
            data-testid="export-all-md"
            disabled={pages.length === 0}
            onClick={() => exportAll('md')}
          >
            <DownloadIcon />
            {t('sidePanelExportMarkdown')}
          </button>
          <button
            type="button"
            class="qn-btn-secondary flex-1"
            data-testid="export-all-json"
            disabled={pages.length === 0}
            onClick={() => exportAll('json')}
          >
            <DownloadIcon />
            {t('sidePanelExportJson')}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          class="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="import-input"
          onChange={(event) => void onImportFile(event)}
        />
        <button
          type="button"
          class="qn-btn-secondary w-full"
          data-testid="import"
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
          {t('sidePanelImport')}
        </button>
        <p class="text-[12px] text-ink-faint">{t('sidePanelImportHelp')}</p>
        {importState.kind === 'done' && (
          <p role="status" data-testid="import-result" class="text-[13px] text-green-800 dark:text-green-300">
            {t('sidePanelImportDone', [
              String(importState.pages),
              String(importState.highlights),
              String(importState.notes),
            ])}
          </p>
        )}
        {importState.kind === 'error' && (
          <div role="alert" data-testid="import-result" class="text-[13px] text-red-700 dark:text-red-300">
            <p>{t('sidePanelImportFailed')}</p>
            <ul class="mt-1 list-disc pl-5 text-[12px]">
              {importState.errors.map((error) => (
                <li key={error} class="break-words">
                  {error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </>
  );
}
