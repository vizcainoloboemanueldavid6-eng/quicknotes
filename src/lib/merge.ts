import type { PageData } from './types';

/** Keeps the newer copy (by updatedAt) of every item that appears in both lists. */
export function mergeById<T extends { id: string; updatedAt: number }>(a: readonly T[], b: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of [...a, ...b]) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt > existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** Merges two records of the same page; the more recently updated title wins unless it is empty. */
export function mergePages(a: PageData, b: PageData): PageData {
  const [older, newer] = b.updatedAt >= a.updatedAt ? [a, b] : [b, a];
  return {
    url: a.url,
    title: newer.title || older.title,
    highlights: mergeById(a.highlights, b.highlights),
    notes: mergeById(a.notes, b.notes),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}
