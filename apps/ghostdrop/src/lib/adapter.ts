import { type StorageAdapter, createBestStorageAdapter } from '@vaulty/core';

let shared: Promise<StorageAdapter> | null = null;

/**
 * The app-wide storage adapter (OPFS → IndexedDB → memory, chosen by @vaulty/core's probe).
 * A module-level singleton so React StrictMode's double-invoke can never run two probes at once,
 * and so the lock screen can show the detected backend before the first unlock.
 */
export function getAdapter(): Promise<StorageAdapter> {
  shared ??= createBestStorageAdapter();
  return shared;
}
