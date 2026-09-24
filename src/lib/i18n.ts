import type messages from '../_locales/en/messages.json';
import type { Color } from './types';

/** Every key defined in the English (default) locale. */
export type MessageKey = keyof typeof messages;

/**
 * Translated UI string. All visible text goes through chrome.i18n so the
 * extension follows the browser language (en, es). Falls back to the key itself
 * if a message is missing, which the locale tests make impossible in practice.
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
  try {
    const message = chrome.i18n.getMessage(key, substitutions);
    if (message) return message;
  } catch {
    // chrome.i18n is unavailable (e.g. a torn-down context); use the key.
  }
  return key;
}

const COLOR_KEYS: Readonly<Record<Color, MessageKey>> = {
  yellow: 'colorYellow',
  green: 'colorGreen',
  blue: 'colorBlue',
  pink: 'colorPink',
};

export function colorName(color: Color): string {
  return t(COLOR_KEYS[color]);
}

/** BCP 47 language of the UI (for `lang` attributes). */
export function uiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}
