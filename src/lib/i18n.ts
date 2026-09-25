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

const COLOR_IN_SENTENCE_KEYS: Readonly<Record<Color, MessageKey>> = {
  yellow: 'colorYellowInSentence',
  green: 'colorGreenInSentence',
  blue: 'colorBlueInSentence',
  pink: 'colorPinkInSentence',
};

/**
 * A color's name on its own, as a label ("Yellow", "Amarillo"): the color
 * chips, the default-color choice, the tag on a listed highlight.
 */
export function colorName(color: Color): string {
  return t(COLOR_KEYS[color]);
}

/**
 * A color's name for a `$COLOR$` placeholder inside a sentence ("Highlight in
 * yellow", "Resaltar en amarillo"). Each locale has its own mid-sentence form
 * instead of lower-casing the label in code: English and Spanish write color
 * names in lower case there, but a language that capitalizes nouns would not.
 */
export function colorNameInSentence(color: Color): string {
  return t(COLOR_IN_SENTENCE_KEYS[color]);
}

/** BCP 47 language of the UI (for `lang` attributes). */
export function uiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}
