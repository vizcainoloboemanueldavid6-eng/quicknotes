import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

const icons = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

/**
 * Manifest V3. There is deliberately no static `content_scripts` entry: the
 * content script is injected on demand (activeTab + scripting) or, only after
 * the user opts in from Options and grants the optional host permission, it is
 * registered at runtime with chrome.scripting.registerContentScripts.
 */
export default defineManifest({
  manifest_version: 3,
  name: '__MSG_extName__',
  short_name: '__MSG_extShortName__',
  description: '__MSG_extDescription__',
  version: pkg.version,
  default_locale: 'en',
  minimum_chrome_version: '116',
  icons,
  action: {
    default_title: '__MSG_actionTitle__',
    default_popup: 'src/popup/index.html',
    default_icon: icons,
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  permissions: ['storage', 'activeTab', 'scripting', 'contextMenus', 'sidePanel'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  commands: {
    'new-note': {
      suggested_key: { default: 'Alt+N' },
      description: '__MSG_commandNewNote__',
    },
  },
});
