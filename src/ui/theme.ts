import { uiLanguage } from '../lib/i18n';
import { getSettings, subscribeSettings } from '../lib/storage';
import type { Theme } from '../lib/types';

function resolve(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies the theme setting to an extension page and keeps it in sync. */
export function initPage(): void {
  document.documentElement.lang = uiLanguage();
  let current: Theme = 'system';
  const apply = () => {
    document.documentElement.dataset.theme = resolve(current);
  };
  apply();
  void getSettings().then((settings) => {
    current = settings.theme;
    apply();
  });
  subscribeSettings((settings) => {
    current = settings.theme;
    apply();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}
