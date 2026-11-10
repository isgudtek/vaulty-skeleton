import { type StorageAdapter, createBestStorageAdapter } from '@vaulty/core';

let shared: Promise<StorageAdapter> | null = null;

/**
 * The app-wide storage adapter (OPFS → IndexedDB → memory, chosen by @vaulty/core's probe).
 * A module-level singleton so React StrictMode's double-invoke can never run two probes at once.
 *
 * The OPFS root and IndexedDB name are app-specific: when several showcase apps share one origin
 * (e.g. GitHub Pages), each keeps its own vaults instead of all reading the same `vaulty/` folder.
 */
export function getAdapter(): Promise<StorageAdapter> {
  shared ??= createBestStorageAdapter({ rootName: 'inkvault', dbName: 'inkvault-vault' });
  return shared;
}
