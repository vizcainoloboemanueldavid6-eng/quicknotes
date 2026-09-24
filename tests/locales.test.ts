import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/_locales/en/messages.json';
import es from '../src/_locales/es/messages.json';
import manifest from '../manifest.config';
import { t } from '../src/lib/i18n';

type Messages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;
const EN = en as Messages;
const ES = es as Messages;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('locales', () => {
  it('English and Spanish define the same keys', () => {
    expect(Object.keys(ES).sort()).toEqual(Object.keys(EN).sort());
  });

  it('placeholders match between languages', () => {
    for (const key of Object.keys(EN)) {
      const names = (messages: Messages) => Object.keys(messages[key]?.placeholders ?? {}).sort();
      expect(names(ES), key).toEqual(names(EN));
      for (const name of names(EN)) {
        expect(EN[key]?.message.toLowerCase(), key).toContain(`$${name}$`);
        expect(ES[key]?.message.toLowerCase(), key).toContain(`$${name}$`);
      }
    }
  });

  it('every t("…") key used in the source exists', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const code = readFileSync(file, 'utf8');
      for (const match of code.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) used.add(match[1] as string);
    }
    expect(used.size).toBeGreaterThan(30);
    const missing = [...used].filter((key) => !(key in EN));
    expect(missing).toEqual([]);
  });

  it('every __MSG_…__ used by the manifest exists', async () => {
    const resolved =
      typeof manifest === 'function' ? await manifest({ command: 'build', mode: 'production' }) : manifest;
    const text = JSON.stringify(resolved);
    const keys = [...text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((match) => match[1] as string);
    expect(keys.length).toBeGreaterThan(3);
    for (const key of keys) expect(EN, key).toHaveProperty(key);
  });

  it('respects Chrome Web Store length limits', () => {
    for (const messages of [EN, ES]) {
      expect(messages.extName?.message.length).toBeLessThanOrEqual(45);
      expect(messages.extShortName?.message.length).toBeLessThanOrEqual(12);
      expect(messages.extDescription?.message.length).toBeLessThanOrEqual(132);
    }
  });

  it('t() substitutes placeholders and falls back to the key', () => {
    expect(t('toolbarHighlight', 'Yellow')).toBe('Highlight in Yellow');
    expect(t('toastOrphans', '2')).toBe('Highlights not found on this page: 2. The side panel lists them.');
    expect(t('nonexistentKey' as never)).toBe('nonexistentKey');
  });
});
