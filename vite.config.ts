import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crx } from '@crxjs/vite-plugin';
import { defineConfig, type Plugin } from 'vite';
import manifest from './manifest.config.ts';

const localesDir = fileURLToPath(new URL('./src/_locales', import.meta.url));

/**
 * The locales live in src/_locales (the spec's layout) but Chrome only reads
 * `_locales/` at the extension root. CRXJS only looks for `_locales` next to the
 * Vite root, so this plugin copies every messages.json to `<outDir>/_locales/`
 * and fails the build when one of them is not valid JSON.
 */
function locales(): Plugin {
  const files = () =>
    readdirSync(localesDir)
      .filter((lang) => statSync(join(localesDir, lang)).isDirectory())
      .map((lang) => ({ lang, path: join(localesDir, lang, 'messages.json') }));

  return {
    name: 'quicknotes:locales',
    buildStart() {
      for (const { path } of files()) this.addWatchFile(path);
    },
    generateBundle() {
      for (const { lang, path } of files()) {
        const source = readFileSync(path, 'utf8');
        try {
          JSON.parse(source);
        } catch (error) {
          this.error(`Invalid JSON in ${path}: ${String(error)}`);
        }
        this.emitFile({ type: 'asset', fileName: `_locales/${lang}/messages.json`, source });
      }
    },
  };
}

const contentEntry = fileURLToPath(new URL('./src/content/index.ts', import.meta.url)).replace(/\\/g, '/');
const CONTENT_SCRIPT_FILE = 'src/content/index.js';

/**
 * Post-build clean-up for the on-demand content script, which the background
 * imports with `?script&iife`:
 *  - CRXJS emits the entry a second time as an ES-module chunk that nothing
 *    loads (the IIFE file is what executeScript / registerContentScripts use),
 *    so that dead chunk is dropped;
 *  - CRXJS lists the IIFE file in web_accessible_resources for all http(s)
 *    pages. Neither chrome.scripting.executeScript nor registerContentScripts
 *    needs that, and it would let any website detect the extension, so the
 *    entry is removed.
 */
interface WarManifest {
  web_accessible_resources?: Array<{ resources: string[]; matches?: string[]; use_dynamic_url?: boolean }>;
}

interface CrxManifestHook {
  renderCrxManifest: (manifest: WarManifest) => WarManifest;
}

function tidyBundle(): Plugin & CrxManifestHook {
  return {
    name: 'quicknotes:tidy-bundle',
    apply: 'build',
    enforce: 'post',
    // CRXJS calls this hook on every plugin, in plugin order, after its own.
    renderCrxManifest(manifest) {
      const war = (manifest.web_accessible_resources ?? [])
        .map((entry) => ({ ...entry, resources: entry.resources.filter((file) => file !== CONTENT_SCRIPT_FILE) }))
        .filter((entry) => entry.resources.length > 0);
      if (war.length > 0) manifest.web_accessible_resources = war;
      else delete manifest.web_accessible_resources;
      return manifest;
    },
    generateBundle(_options, bundle) {
      const imported = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          for (const file of [...output.imports, ...output.dynamicImports]) imported.add(file);
        }
      }
      for (const [fileName, output] of Object.entries(bundle)) {
        const facade = output.type === 'chunk' ? output.facadeModuleId?.replace(/\\/g, '/') : undefined;
        if (facade === contentEntry && !imported.has(fileName)) delete bundle[fileName];
      }
    },
  };
}

export default defineConfig({
  plugins: [locales(), crx({ manifest }), tidyBundle()],
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
  },
  server: {
    port: 4320,
    strictPort: true,
    hmr: { port: 4321 },
  },
});
