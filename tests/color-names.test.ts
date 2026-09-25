/**
 * Color names in the UI: capitalized where a name stands alone as a label
 * ("Amarillo" on a filter chip), lower case where it is part of a sentence
 * ("Resaltar en amarillo", not "Resaltar en Amarillo").
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/_locales/en/messages.json';
import es from '../src/_locales/es/messages.json';
import { colorName, colorNameInSentence, t, type MessageKey } from '../src/lib/i18n';
import { COLORS, type Color } from '../src/lib/types';
import { messageGetter } from './chromeMock';

type Messages = Record<string, { message: string; placeholders?: Record<string, unknown> }>;
const LOCALES: Record<'en' | 'es', Messages> = { en, es };
type Lang = keyof typeof LOCALES;

function useLocale(lang: Lang): void {
  mockChrome.i18n.getMessage = messageGetter(LOCALES[lang]);
}

/** Every message with a `$COLOR$` placeholder, i.e. every sentence that embeds a color name. */
const COLOR_SENTENCES = Object.keys(en)
  .filter((key) => 'color' in ((en as Messages)[key]?.placeholders ?? {}))
  .sort() as MessageKey[];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('color names', () => {
  it('knows every message that embeds a color', () => {
    expect(COLOR_SENTENCES).toEqual(['menuChangeColor', 'noteColor', 'toolbarHighlight']);
  });

  it('Spanish writes the color in lower case inside a sentence', () => {
    useLocale('es');
    const word: Record<Color, string> = { yellow: 'amarillo', green: 'verde', blue: 'azul', pink: 'rosa' };
    for (const color of COLORS) {
      expect(t('toolbarHighlight', colorNameInSentence(color))).toBe(`Resaltar en ${word[color]}`);
      expect(t('menuChangeColor', colorNameInSentence(color))).toBe(`Cambiar el color a ${word[color]}`);
      expect(t('noteColor', colorNameInSentence(color))).toBe(`Color de la nota: ${word[color]}`);
    }
  });

  it('Spanish keeps the capital where the name stands alone as a label', () => {
    useLocale('es');
    expect(COLORS.map(colorName)).toEqual(['Amarillo', 'Verde', 'Azul', 'Rosa']);
  });

  it('English follows the same rule', () => {
    useLocale('en');
    expect(t('toolbarHighlight', colorNameInSentence('yellow'))).toBe('Highlight in yellow');
    expect(t('menuChangeColor', colorNameInSentence('green'))).toBe('Change color to green');
    expect(t('noteColor', colorNameInSentence('pink'))).toBe('Note color: pink');
    expect(COLORS.map(colorName)).toEqual(['Yellow', 'Green', 'Blue', 'Pink']);
  });

  it.each(Object.keys(LOCALES) as Lang[])(
    '%s: every sentence with a color uses the lower-case name, never the label',
    (lang) => {
      useLocale(lang);
      for (const key of COLOR_SENTENCES) {
        for (const color of COLORS) {
          const label = colorName(color);
          const sentence = t(key, colorNameInSentence(color));
          expect(colorNameInSentence(color), `${lang} ${color}`).toBe(label.toLocaleLowerCase(lang));
          expect(sentence, `${lang} ${key} ${color}`).toContain(label.toLocaleLowerCase(lang));
          expect(sentence, `${lang} ${key} ${color}`).not.toContain(label);
        }
      }
    },
  );

  it('the code fills every color placeholder with the in-sentence form', () => {
    const calls: Array<{ file: string; key: string; argument: string }> = [];
    const pattern = new RegExp(String.raw`\bt\(\s*'(${COLOR_SENTENCES.join('|')})'\s*,\s*([A-Za-z_$][\w$]*)`, 'g');
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
        calls.push({ file, key: match[1] as string, argument: match[2] as string });
      }
    }
    // toolbar swatches, highlight-menu swatches, note swatches (label + tooltip)
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.filter((call) => call.argument !== 'colorNameInSentence')).toEqual([]);
  });
});
