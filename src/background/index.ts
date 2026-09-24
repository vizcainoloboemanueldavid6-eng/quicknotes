/**
 * Service worker: context menu, keyboard command, side panel, message routing,
 * on-demand injection of the content script, and the opt-in "restore on every
 * site" registration. It holds no state of its own — everything it needs is
 * re-read from storage, so it can be stopped and restarted at any time.
 */
import contentScript from '../content/index.ts?script&iife';
import { t } from '../lib/i18n';
import {
  fail,
  isBackgroundMessage,
  ok,
  type BackgroundMessage,
  type ContentMessage,
  type Reply,
} from '../lib/messages';
import { getSettings, subscribeSettings, updateSettings } from '../lib/storage';
import { HOST_PERMISSION_ORIGINS, isPausedUrl, isSupportedUrl, matchPatternsForSite } from '../lib/url';

const MENU_ID = 'quicknotes-highlight';
const AUTO_RESTORE_ID = 'quicknotes-auto-restore';
const HOST_ORIGINS = [...HOST_PERMISSION_ORIGINS];

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

async function ping(tabId: number): Promise<boolean> {
  try {
    const message: ContentMessage = { type: 'qn:ping' };
    const reply = await chrome.tabs.sendMessage<ContentMessage, Reply<unknown> | undefined>(tabId, message, {
      frameId: 0,
    });
    return reply?.ok === true;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes sure the content script runs in the tab's top frame (idempotent). */
async function ensureInjected(tabId: number): Promise<Reply> {
  if (await ping(tabId)) return ok(undefined);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
  } catch (error) {
    // Restricted pages (browser pages, the extension store, PDF viewer, …).
    return fail('inject-failed', error instanceof Error ? error.message : String(error));
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await ping(tabId)) return ok(undefined);
    await delay(50);
  }
  return fail('inject-failed', 'The content script did not answer.');
}

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

/**
 * Checks the page may be used (supported scheme, not paused), injects the
 * content script and forwards the message. `url` is known whenever the user
 * acted on the tab (activeTab grants it); if it is not, the content script
 * still enforces the pause itself.
 */
async function runOnTab(tabId: number, url: string | undefined, message: ContentMessage): Promise<Reply<unknown>> {
  if (url !== undefined) {
    if (!isSupportedUrl(url)) return fail('unsupported-page');
    const settings = await getSettings();
    const paused = isPausedUrl(url, settings.pausedSites);
    await setPausedBadge(tabId, paused);
    if (paused) return fail('paused');
  }
  const injected = await ensureInjected(tabId);
  if (!injected.ok) return injected;
  try {
    const reply = await chrome.tabs.sendMessage<ContentMessage, Reply<unknown> | undefined>(tabId, message, {
      frameId: 0,
    });
    return reply ?? fail('failed', 'no reply');
  } catch (error) {
    return fail('failed', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// "off" badge on paused sites
// ---------------------------------------------------------------------------

const PAUSED_BADGE = 'off';

/**
 * Shows "off" on the toolbar button for a tab on a paused site, and removes it
 * again once the site is resumed. Only the badge QuickNotes set is cleared.
 */
async function setPausedBadge(tabId: number, paused: boolean): Promise<void> {
  try {
    if (paused) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#8A847C' });
      await chrome.action.setBadgeText({ tabId, text: PAUSED_BADGE });
    } else if ((await chrome.action.getBadgeText({ tabId })) === PAUSED_BADGE) {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch {
    // The tab may be gone.
  }
}

/**
 * Brings the badge of every tab whose URL the extension may see (tabs the user
 * acted on, or every tab once the optional host permission is granted) in line
 * with the paused-sites list.
 */
async function refreshBadges(pausedSites: readonly string[]): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) =>
      tab.id !== undefined && tab.url
        ? setPausedBadge(tab.id, isSupportedUrl(tab.url) && isPausedUrl(tab.url, pausedSites))
        : Promise.resolve(),
    ),
  );
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function createContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: t('contextHighlight'),
        contexts: ['selection'],
        documentUrlPatterns: [...HOST_ORIGINS, 'file:///*'],
      },
      () => void chrome.runtime.lastError,
    );
  });
}

/**
 * Disables the menu item on paused sites. Tab URLs are only visible for tabs
 * the user has acted on (activeTab) or with the optional host permission, so
 * when the URL is unknown the item stays enabled and the click handler checks.
 */
async function refreshMenuState(): Promise<void> {
  let url: string | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    url = tab?.url;
  } catch {
    url = undefined;
  }
  const settings = await getSettings();
  const enabled = url === undefined || (isSupportedUrl(url) && !isPausedUrl(url, settings.pausedSites));
  chrome.contextMenus.update(MENU_ID, { enabled }, () => void chrome.runtime.lastError);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  void runOnTab(tab.id, info.pageUrl || tab.url, {
    type: 'qn:highlight-selection',
    ...(info.selectionText ? { text: info.selectionText } : {}),
  });
});

// ---------------------------------------------------------------------------
// Keyboard command
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'new-note') return;
  void (async () => {
    const target = tab?.id !== undefined ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (target?.id === undefined) return;
    await runOnTab(target.id, target.url, { type: 'qn:new-note' });
  })();
});

// ---------------------------------------------------------------------------
// Opt-in automatic restore (registered content script)
// ---------------------------------------------------------------------------

let autoRestoreQueue: Promise<unknown> = Promise.resolve();

/**
 * Registers the content script for every http(s) page when the user turned on
 * "Restore my notes automatically" AND granted the optional host permission;
 * unregisters it otherwise. Paused sites are excluded from the registration.
 * Calls are serialized (settings and permission events can arrive together).
 */
function syncAutoRestore(): Promise<Reply<{ registered: boolean }>> {
  const run = autoRestoreQueue.then(async (): Promise<Reply<{ registered: boolean }>> => {
    const settings = await getSettings();
    const granted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_RESTORE_ID] });

    if (!settings.autoRestore || !granted) {
      if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_RESTORE_ID] });
      return ok({ registered: false });
    }

    const excludeMatches = settings.pausedSites.flatMap(matchPatternsForSite);
    const script: chrome.scripting.RegisteredContentScript = {
      id: AUTO_RESTORE_ID,
      js: [contentScript],
      matches: HOST_ORIGINS,
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
      ...(excludeMatches.length > 0 ? { excludeMatches } : {}),
    };
    const [current] = existing;
    if (current) {
      // Settings and permission events often arrive together; leave an identical
      // registration alone instead of briefly unregistering it (a page loading in
      // that gap would miss the script).
      const same = (a: readonly string[] = [], b: readonly string[] = []) =>
        a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);
      if (
        same(current.js, script.js) &&
        same(current.matches, script.matches) &&
        same(current.excludeMatches, script.excludeMatches) &&
        current.runAt === script.runAt &&
        Boolean(current.allFrames) === Boolean(script.allFrames) &&
        current.persistAcrossSessions !== false
      ) {
        return ok({ registered: true });
      }
      // updateContentScripts cannot clear excludeMatches, so re-register instead.
      await chrome.scripting.unregisterContentScripts({ ids: [AUTO_RESTORE_ID] });
    }
    await chrome.scripting.registerContentScripts([script]);
    return ok({ registered: true });
  });
  autoRestoreQueue = run.catch(() => undefined);
  return run.catch((error: unknown) => fail('failed', error instanceof Error ? error.message : String(error)));
}

chrome.permissions.onAdded.addListener(() => void syncAutoRestore());
chrome.permissions.onRemoved.addListener((removed) => {
  void (async () => {
    const lostHosts = (removed.origins ?? []).some((origin) => HOST_ORIGINS.includes(origin));
    if (lostHosts && (await getSettings()).autoRestore) await updateSettings({ autoRestore: false });
    await syncAutoRestore();
  })();
});

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

/**
 * chrome.sidePanel.open() only works inside a user gesture, so it is called
 * synchronously from the message handler, before any await.
 */
function openSidePanel(
  message: Extract<BackgroundMessage, { type: 'qn:bg:open-side-panel' }>,
  sender: chrome.runtime.MessageSender,
): Promise<Reply> {
  const windowId = message.windowId ?? sender.tab?.windowId;
  const tabId = message.tabId ?? sender.tab?.id;
  try {
    const opening =
      windowId !== undefined
        ? chrome.sidePanel.open({ windowId })
        : tabId !== undefined
          ? chrome.sidePanel.open({ tabId })
          : Promise.reject(new Error('No window or tab to open the side panel in.'));
    return opening.then(
      () => ok(undefined),
      (error: unknown) => fail('failed', error instanceof Error ? error.message : String(error)),
    );
  } catch (error) {
    return Promise.resolve(fail('failed', error instanceof Error ? error.message : String(error)));
  }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

async function handle(message: BackgroundMessage): Promise<Reply<unknown>> {
  switch (message.type) {
    case 'qn:bg:inject': {
      const url = await tabUrl(message.tabId);
      if (url !== undefined) {
        if (!isSupportedUrl(url)) return fail('unsupported-page');
        const paused = isPausedUrl(url, (await getSettings()).pausedSites);
        await setPausedBadge(message.tabId, paused);
        if (paused) return fail('paused');
      }
      return ensureInjected(message.tabId);
    }
    case 'qn:bg:get-status': {
      const url = await tabUrl(message.tabId);
      return runOnTab(message.tabId, url, { type: 'qn:get-status' });
    }
    case 'qn:bg:new-note':
      return runOnTab(message.tabId, await tabUrl(message.tabId), { type: 'qn:new-note' });
    case 'qn:bg:highlight-selection':
      return runOnTab(message.tabId, await tabUrl(message.tabId), {
        type: 'qn:highlight-selection',
        ...(message.color ? { color: message.color } : {}),
        ...(message.text ? { text: message.text } : {}),
      });
    case 'qn:bg:scroll-to':
      return runOnTab(message.tabId, await tabUrl(message.tabId), { type: 'qn:scroll-to', id: message.id });
    case 'qn:bg:sync-auto-restore':
      return syncAutoRestore();
    case 'qn:bg:open-side-panel':
      return fail('failed', 'handled synchronously');
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isBackgroundMessage(message)) return undefined;
  const reply = message.type === 'qn:bg:open-side-panel' ? openSidePanel(message, sender) : handle(message);
  reply.then(sendResponse, (error: unknown) => sendResponse(fail('failed', String(error))));
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  createContextMenu();
  void syncAutoRestore();
});

chrome.runtime.onStartup.addListener(() => void syncAutoRestore());

subscribeSettings((settings) => {
  void syncAutoRestore();
  void refreshMenuState();
  void refreshBadges(settings.pausedSites);
});

chrome.tabs.onActivated.addListener(() => void refreshMenuState());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && changeInfo.status !== 'complete') return;
  void refreshMenuState();
  const url = tab.url;
  if (url) {
    void getSettings().then((settings) =>
      setPausedBadge(tabId, isSupportedUrl(url) && isPausedUrl(url, settings.pausedSites)),
    );
  }
});
chrome.windows.onFocusChanged.addListener(() => void refreshMenuState());
