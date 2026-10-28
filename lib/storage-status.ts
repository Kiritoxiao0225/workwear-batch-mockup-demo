import { useSyncExternalStore } from 'react';

/**
 * The account's storage, as the header last read it. The header polls /api/account; the tools
 * read it from here to grey out what would store a file once the space has run out (10-28).
 */
export type StorageUsage = { bytesUsed: number; storageQuotaBytes: number };
export type StorageLevel = 'ok' | 'warn' | 'high' | 'full';

// Quotas this large are how an unlimited workspace is stored; show them as such.
export const UNLIMITED_BYTES = 2 ** 50;
// Less than one ordinary photo left counts as full: the next upload would be refused anyway.
const FULL_MARGIN_BYTES = 10 * 1024 ** 2;

export const STORAGE_PAGE = '/account/storage';

export function storageLevel(usage: StorageUsage | null): StorageLevel {
  if (!usage || usage.storageQuotaBytes >= UNLIMITED_BYTES) return 'ok';
  const ratio = usage.bytesUsed / Math.max(1, usage.storageQuotaBytes);
  if (usage.storageQuotaBytes - usage.bytesUsed < FULL_MARGIN_BYTES) return 'full';
  return ratio >= 0.95 ? 'high' : ratio >= 0.8 ? 'warn' : 'ok';
}

/** Sizes as people read them: 0.45 GB, 820 MB, 36 KB. */
export function sizeText(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : bytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB`;
}

let current: StorageUsage | null = null;
const listeners = new Set<() => void>();

export function publishStorage(usage: StorageUsage | null) {
  if (usage?.bytesUsed === current?.bytesUsed && usage?.storageQuotaBytes === current?.storageQuotaBytes) return;
  current = usage;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useStorage() {
  const usage = useSyncExternalStore(subscribe, () => current, () => null);
  return { usage, level: storageLevel(usage) };
}
