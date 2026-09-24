/**
 * One host element per page, <quicknotes-root>, appended to <html> (outside
 * <body>, so page layouts and body transforms do not affect it). Everything
 * QuickNotes draws — toolbar, menus, sticky notes, toasts — lives in its open
 * shadow root, isolated both ways:
 *
 *  - Page → UI: page selectors cannot reach into a shadow root. Inherited
 *    properties still cross the boundary, so `:host { all: initial }` cuts them
 *    off. `!important` declarations in a shadow tree's :host rules beat the
 *    page's own `!important` rules for the host, so a hostile `* { display:
 *    none !important }` loses too. The CSS uses px, never rem (see
 *    postcss.config.js), so a page's root font size cannot rescale it.
 *  - UI → page: the Tailwind build (including its preflight reset) is adopted
 *    by the shadow root only, never by the document.
 */
import contentCss from './content.css?inline';
import { HOST_TAG } from './anchor';

export interface ShadowUi {
  host: HTMLElement;
  shadow: ShadowRoot;
  /** Absolutely positioned layer at the document origin; UI is rendered into it. */
  layer: HTMLElement;
}

const HOST_CSS = `
:host {
  all: initial !important;
  display: block !important;
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  overflow: visible !important;
  z-index: 2147483647 !important;
  contain: none !important;
  transform: none !important;
  filter: none !important;
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: none !important;
  color-scheme: light !important;
}
`;

function adoptStyles(shadow: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    // Constructable stylesheets unavailable: fall back to a <style> element.
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
  }
}

export function createShadowUi(doc: Document = document): ShadowUi {
  doc.querySelectorAll(HOST_TAG).forEach((stale) => stale.remove());

  const host = doc.createElement(HOST_TAG);
  host.setAttribute('data-quicknotes', '');
  const shadow = host.attachShadow({ mode: 'open' });
  adoptStyles(shadow, `${HOST_CSS}\n${contentCss}`);

  const layer = doc.createElement('div');
  layer.className = 'qn-layer';
  layer.setAttribute('lang', chrome.i18n.getUILanguage());
  shadow.appendChild(layer);

  // Keystrokes typed into notes must not trigger the page's own shortcuts
  // (bubble-phase listeners on document/window never see them).
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut']) {
    layer.addEventListener(type, (event) => event.stopPropagation());
  }

  doc.documentElement.appendChild(host);
  return { host, shadow, layer };
}

/**
 * Size of the page's document *without* QuickNotes' own UI: while measuring,
 * the layer clips its children so notes near the bottom cannot make the
 * document taller (which would otherwise shift every percentage-based position).
 */
export function measureDocument(ui: ShadowUi, doc: Document = document): { width: number; height: number } {
  const { layer } = ui;
  const previous = layer.style.overflow;
  layer.style.overflow = 'hidden';
  const root = doc.documentElement;
  const body = doc.body as HTMLElement | null;
  const width = Math.max(root.scrollWidth, body?.scrollWidth ?? 0, root.clientWidth, 1);
  const height = Math.max(root.scrollHeight, body?.scrollHeight ?? 0, root.clientHeight, 1);
  layer.style.overflow = previous;
  return { width, height };
}
