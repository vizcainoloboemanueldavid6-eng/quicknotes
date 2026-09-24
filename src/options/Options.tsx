/**
 * Options: default color, selection toolbar, shortcut, opt-in automatic
 * restore (asks for the optional host permission), paused sites, theme, and
 * "delete all data" behind a typed confirmation.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { PALETTE } from '../lib/colors';
import { colorName, t, type MessageKey } from '../lib/i18n';
import { sendToBackground } from '../lib/messages';
import { clearAllData, getSettings, setSitePaused, subscribeSettings, updateSettings } from '../lib/storage';
import { COLORS, DEFAULT_SETTINGS, THEMES, type Settings, type Theme } from '../lib/types';
import { HOST_PERMISSION_ORIGINS, parseSiteEntry } from '../lib/url';

const THEME_LABEL: Record<Theme, MessageKey> = {
  system: 'optionsThemeSystem',
  light: 'optionsThemeLight',
  dark: 'optionsThemeDark',
};

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="qn-card flex flex-col gap-3 p-5">
      <h2 class="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Options() {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [shortcut, setShortcut] = useState('');
  const [siteInput, setSiteInput] = useState('');
  const [siteError, setSiteError] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    void getSettings().then(setSettings);
    void chrome.commands
      .getAll()
      .then((commands) => setShortcut(commands.find((command) => command.name === 'new-note')?.shortcut ?? ''));
    return subscribeSettings(setSettings);
  }, []);

  const save = (patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    void updateSettings(patch);
  };

  const toggleAutoRestore = async (enabled: boolean) => {
    setPermissionDenied(false);
    if (enabled) {
      // Must be requested from the click itself (user gesture).
      const granted = await chrome.permissions.request({ origins: [...HOST_PERMISSION_ORIGINS] }).catch(() => false);
      if (!granted) {
        setPermissionDenied(true);
        // A new settings object forces a re-render, which unticks the checkbox
        // the user just ticked even when nothing else changed.
        setSettings((current) => ({ ...current, autoRestore: false }));
        return;
      }
      await updateSettings({ autoRestore: true });
    } else {
      await updateSettings({ autoRestore: false });
      await chrome.permissions.remove({ origins: [...HOST_PERMISSION_ORIGINS] }).catch(() => false);
    }
    await sendToBackground({ type: 'qn:bg:sync-auto-restore' });
  };

  const addSite = (event: Event) => {
    event.preventDefault();
    const site = parseSiteEntry(siteInput);
    if (!site) {
      setSiteError(true);
      return;
    }
    setSiteError(false);
    setSiteInput('');
    void setSitePaused(site, true);
  };

  const confirmWord = t('optionsDangerWord');
  const deleteEverything = async (event: Event) => {
    event.preventDefault();
    if (confirmText.trim() !== confirmWord) return;
    await clearAllData({ includeSettings: true });
    await updateSettings({ autoRestore: false });
    await chrome.permissions.remove({ origins: [...HOST_PERMISSION_ORIGINS] }).catch(() => false);
    await sendToBackground({ type: 'qn:bg:sync-auto-restore' });
    setConfirmText('');
    setDeleted(true);
  };

  return (
    <main class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
      <header class="flex items-center gap-3">
        <img src="/icons/icon-48.png" width="36" height="36" alt="" />
        <h1 class="text-[22px] font-semibold">{t('optionsTitle')}</h1>
      </header>

      <Section title={t('optionsDefaultColor')}>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label={t('optionsDefaultColor')}>
          {COLORS.map((color) => (
            <label key={color} class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2">
              <input
                type="radio"
                name="default-color"
                checked={settings.defaultColor === color}
                onChange={() => save({ defaultColor: color })}
              />
              <span class="h-4 w-4 rounded-full border" style={{ backgroundColor: PALETTE[color].highlight }} />
              {colorName(color)}
            </label>
          ))}
        </div>
      </Section>

      <Section title={t('optionsShowToolbar')}>
        <label class="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.showToolbar}
            onChange={(event) => save({ showToolbar: event.currentTarget.checked })}
          />
          {t('optionsShowToolbar')}
        </label>
      </Section>

      <Section title={t('optionsShortcut')}>
        <div class="flex items-center gap-3">
          <kbd class="rounded border border-paper-line bg-paper px-2 py-1 font-mono text-[13px] dark:border-[#3a352f] dark:bg-[#1f1c19]">
            {shortcut || '—'}
          </kbd>
          <button
            type="button"
            class="qn-btn-secondary"
            onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
          >
            {t('optionsShortcutChange')}
          </button>
        </div>
      </Section>

      <Section title={t('optionsAutoRestore')}>
        <label class="flex items-start gap-3">
          <input
            type="checkbox"
            class="mt-1"
            checked={settings.autoRestore}
            onChange={(event) => void toggleAutoRestore(event.currentTarget.checked)}
          />
          <span>
            <span class="block font-medium">{t('optionsAutoRestore')}</span>
            <span class="block text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('optionsAutoRestoreHelp')}</span>
          </span>
        </label>
        {permissionDenied && (
          <p class="text-[13px] text-amber-800 dark:text-amber-300">{t('optionsAutoRestoreDenied')}</p>
        )}
      </Section>

      <Section title={t('optionsPausedSites')}>
        <form class="flex gap-2" onSubmit={addSite}>
          <input
            type="text"
            class="h-9 flex-1 rounded-lg border border-paper-line bg-white px-3 dark:border-[#3a352f] dark:bg-[#1f1c19]"
            placeholder={t('optionsSitePlaceholder')}
            aria-label={t('optionsPausedSites')}
            aria-invalid={siteError}
            value={siteInput}
            onInput={(event) => setSiteInput(event.currentTarget.value)}
          />
          <button type="submit" class="qn-btn-secondary">
            {t('optionsAddSite')}
          </button>
        </form>
        {siteError && <p class="text-[13px] text-red-700 dark:text-red-300">{t('optionsInvalidSite')}</p>}
        {settings.pausedSites.length === 0 ? (
          <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('optionsPausedSitesEmpty')}</p>
        ) : (
          <ul class="flex flex-col gap-1">
            {settings.pausedSites.map((site) => (
              <li key={site} class="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-primary-soft/50">
                <span class="font-mono text-[13px]">{site}</span>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-[13px] text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950"
                  onClick={() => void setSitePaused(site, false)}
                >
                  {t('optionsRemoveSite', site)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('optionsTheme')}>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label={t('optionsTheme')}>
          {THEMES.map((theme) => (
            <label key={theme} class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2">
              <input type="radio" name="theme" checked={settings.theme === theme} onChange={() => save({ theme })} />
              {t(THEME_LABEL[theme])}
            </label>
          ))}
        </div>
      </Section>

      <Section title={t('optionsDanger')}>
        <form class="flex flex-col gap-2" onSubmit={(event) => void deleteEverything(event)}>
          <p class="text-[13px] text-ink-soft dark:text-[#cfc8bb]">{t('optionsDangerHelp', confirmWord)}</p>
          <div class="flex gap-2">
            <input
              type="text"
              class="h-9 flex-1 rounded-lg border border-paper-line bg-white px-3 dark:border-[#3a352f] dark:bg-[#1f1c19]"
              aria-label={t('optionsDanger')}
              value={confirmText}
              onInput={(event) => {
                setConfirmText(event.currentTarget.value);
                setDeleted(false);
              }}
            />
            <button
              type="submit"
              class="qn-btn bg-red-600 text-white hover:bg-red-700"
              disabled={confirmText.trim() !== confirmWord}
            >
              {t('optionsDangerButton')}
            </button>
          </div>
          {deleted && (
            <p role="status" class="text-[13px] text-green-800 dark:text-green-300">
              {t('optionsDeleted')}
            </p>
          )}
        </form>
      </Section>
    </main>
  );
}
