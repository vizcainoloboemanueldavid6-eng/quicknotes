/**
 * Minimal in-memory implementation of the chrome.* APIs the library code uses:
 * storage.local / storage.sync (get/set/remove/clear + onChanged, with values
 * deep-cloned the way Chrome serializes them, and sync's 8,192-byte per-item
 * quota enforced the way Chrome enforces it), i18n.getMessage (reading the real
 * English messages.json, placeholders included; `messageGetter` builds one for
 * another locale) and runtime.id.
 */
import en from '../src/_locales/en/messages.json';

type Items = Record<string, unknown>;
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

interface Message {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

function createEvent<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => void listeners.add(listener),
    removeListener: (listener: T) => void listeners.delete(listener),
    hasListener: (listener: T) => listeners.has(listener),
    listeners,
  };
}

/** chrome.storage.sync's per-item limit: key + JSON of the value, in bytes. */
const SYNC_QUOTA_BYTES_PER_ITEM = 8192;

function createArea(name: 'local' | 'sync', onChanged: ReturnType<typeof createEvent<ChangeListener>>) {
  let data: Items = {};
  const quotaPerItem = name === 'sync' ? SYNC_QUOTA_BYTES_PER_ITEM : Infinity;
  const emit = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
    if (Object.keys(changes).length === 0) return;
    // Chrome dispatches storage events asynchronously.
    queueMicrotask(() => {
      for (const listener of onChanged.listeners) listener(structuredClone(changes), name);
    });
  };
  return {
    get: (keys?: string | string[] | Items | null): Promise<Items> => {
      if (keys === null || keys === undefined) return Promise.resolve(structuredClone(data));
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
      const result: Items = {};
      for (const key of list) {
        if (key in data) result[key] = structuredClone(data[key]);
        else if (key in defaults) result[key] = defaults[key];
      }
      return Promise.resolve(result);
    },
    set: (items: Items): Promise<void> => {
      // Like Chrome, a write with an oversized item is rejected as a whole.
      for (const [key, value] of Object.entries(items)) {
        if (new TextEncoder().encode(key + JSON.stringify(value)).length > quotaPerItem) {
          return Promise.reject(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
        }
      }
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        const cloned = structuredClone(value);
        changes[key] = { oldValue: data[key], newValue: cloned };
        data = { ...data, [key]: cloned };
      }
      emit(changes);
      return Promise.resolve();
    },
    remove: (keys: string | string[]): Promise<void> => {
      const changes: Record<string, { oldValue?: unknown }> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (key in data) {
          changes[key] = { oldValue: data[key] };
          const { [key]: _removed, ...rest } = data;
          data = rest;
        }
      }
      emit(changes);
      return Promise.resolve();
    },
    clear: (): Promise<void> => {
      const changes = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { oldValue: value }]));
      data = {};
      emit(changes);
      return Promise.resolve();
    },
    /** Test helper: raw contents. */
    dump: (): Items => structuredClone(data),
  };
}

/** chrome.i18n.getMessage over one locale's messages.json. */
export function messageGetter(messages: object) {
  const table = messages as Record<string, Message | undefined>;
  return (key: string, substitutions?: string | string[]): string => {
    const entry = table[key];
    if (!entry) return '';
    const subs = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name: string) => {
      const placeholder = entry.placeholders?.[name.toLowerCase()];
      if (!placeholder) return match;
      return placeholder.content.replace(/\$(\d)/g, (_m, index: string) => subs[Number(index) - 1] ?? '');
    });
  };
}

export const getMessage = messageGetter(en);

export function createChromeMock() {
  const onChanged = createEvent<ChangeListener>();
  return {
    runtime: { id: 'quicknotes-test' },
    i18n: { getMessage, getUILanguage: () => 'en' },
    storage: {
      local: createArea('local', onChanged),
      sync: { ...createArea('sync', onChanged), QUOTA_BYTES_PER_ITEM: SYNC_QUOTA_BYTES_PER_ITEM },
      onChanged,
    },
  };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;

/** Lets queued storage events run. */
export function flushEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
