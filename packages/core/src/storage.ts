import { type StorageAdapter, VaultyError } from './types';

/**
 * Pluggable storage. Adapters only ever receive ciphertext and public key envelopes.
 * They never touch `localStorage`/`sessionStorage`/cookies.
 */

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Reject path-traversal and separator characters before they reach any backend. */
export function assertSafeName(name: string, what = 'name'): void {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new VaultyError('INVALID_ARGUMENT', `Invalid storage ${what}`);
  }
}

const storageError = (message: string, cause?: unknown): VaultyError =>
  new VaultyError('STORAGE_ERROR', message, { cause });

const isNotFound = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'NotFoundError';

/* ------------------------------------------------------------------------------------------ */
/* In-memory adapter                                                                          */
/* ------------------------------------------------------------------------------------------ */

export class MemoryStorageAdapter implements StorageAdapter {
  readonly kind = 'memory';
  readonly #data = new Map<string, Map<string, Uint8Array>>();

  async put(namespace: string, name: string, data: Uint8Array): Promise<void> {
    assertSafeName(namespace, 'namespace');
    assertSafeName(name);
    let ns = this.#data.get(namespace);
    if (!ns) this.#data.set(namespace, (ns = new Map()));
    ns.set(name, data.slice());
  }

  async get(namespace: string, name: string): Promise<Uint8Array | null> {
    assertSafeName(namespace, 'namespace');
    assertSafeName(name);
    return this.#data.get(namespace)?.get(name)?.slice() ?? null;
  }

  async delete(namespace: string, name: string): Promise<void> {
    assertSafeName(namespace, 'namespace');
    assertSafeName(name);
    const ns = this.#data.get(namespace);
    ns?.delete(name);
    if (ns && ns.size === 0) this.#data.delete(namespace);
  }

  async list(namespace: string): Promise<string[]> {
    assertSafeName(namespace, 'namespace');
    return [...(this.#data.get(namespace)?.keys() ?? [])];
  }

  async hasNamespace(namespace: string): Promise<boolean> {
    assertSafeName(namespace, 'namespace');
    return this.#data.has(namespace);
  }

  async listNamespaces(): Promise<string[]> {
    return [...this.#data.keys()];
  }

  async deleteNamespace(namespace: string): Promise<void> {
    assertSafeName(namespace, 'namespace');
    for (const blob of this.#data.get(namespace)?.values() ?? []) blob.fill(0);
    this.#data.delete(namespace);
  }

  async purgeAll(): Promise<void> {
    for (const ns of this.#data.values()) for (const blob of ns.values()) blob.fill(0);
    this.#data.clear();
  }
}

/* ------------------------------------------------------------------------------------------ */
/* OPFS adapter                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Structural subsets of the File System Access API (so we need no DOM lib types at runtime). */
export interface FsWritableLike {
  write(data: BufferSource): Promise<unknown>;
  close(): Promise<void>;
}
export interface FsSyncAccessHandleLike {
  truncate(size: number): void;
  write(data: BufferSource, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}
export interface FsFileHandleLike {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable?(options?: { keepExistingData?: boolean }): Promise<FsWritableLike>;
  createSyncAccessHandle?(): Promise<FsSyncAccessHandleLike>;
}
export interface FsDirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

export interface OPFSStorageOptions {
  /** Top-level OPFS directory that holds all vault namespaces. Default `"vaulty"`. */
  rootName?: string;
  /** Test injection: supplies the OPFS origin root. Defaults to `navigator.storage.getDirectory()`. */
  getRoot?: () => Promise<FsDirectoryHandleLike>;
}

async function defaultOpfsRoot(): Promise<FsDirectoryHandleLike> {
  const nav = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<unknown> } } })
    .navigator;
  if (!nav?.storage?.getDirectory) {
    throw storageError('OPFS is not available in this environment');
  }
  return (await nav.storage.getDirectory()) as FsDirectoryHandleLike;
}

async function collectKeys(dir: FsDirectoryHandleLike): Promise<string[]> {
  const out: string[] = [];
  for await (const k of dir.keys()) out.push(k);
  return out;
}

/** Encrypted blobs live at `<root>/<namespace>/<randomUUID>` inside the Origin Private File System. */
export class OPFSStorageAdapter implements StorageAdapter {
  readonly kind = 'opfs';
  readonly #rootName: string;
  readonly #getRoot: () => Promise<FsDirectoryHandleLike>;

  constructor(options: OPFSStorageOptions = {}) {
    this.#rootName = options.rootName ?? 'vaulty';
    assertSafeName(this.#rootName, 'root name');
    this.#getRoot = options.getRoot ?? defaultOpfsRoot;
  }

  async #base(create: boolean): Promise<FsDirectoryHandleLike | null> {
    try {
      const root = await this.#getRoot();
      return await root.getDirectoryHandle(this.#rootName, { create });
    } catch (e) {
      if (!create && isNotFound(e)) return null;
      throw storageError('Failed to open OPFS root directory', e);
    }
  }

  async #ns(namespace: string, create: boolean): Promise<FsDirectoryHandleLike | null> {
    assertSafeName(namespace, 'namespace');
    const base = await this.#base(create);
    if (!base) return null;
    try {
      return await base.getDirectoryHandle(namespace, { create });
    } catch (e) {
      if (!create && isNotFound(e)) return null;
      throw storageError('Failed to open vault directory', e);
    }
  }

  async put(namespace: string, name: string, data: Uint8Array): Promise<void> {
    assertSafeName(name);
    const dir = (await this.#ns(namespace, true)) as FsDirectoryHandleLike;
    try {
      const file = await dir.getFileHandle(name, { create: true });
      if (file.createWritable) {
        const w = await file.createWritable({ keepExistingData: false });
        try {
          await w.write(data as unknown as BufferSource);
        } finally {
          await w.close();
        }
      } else if (file.createSyncAccessHandle) {
        // Worker-only path (Safari main thread has no createWritable).
        const h = await file.createSyncAccessHandle();
        try {
          h.truncate(0);
          h.write(data as unknown as BufferSource, { at: 0 });
          h.flush();
        } finally {
          h.close();
        }
      } else {
        throw storageError('No supported OPFS write API available');
      }
    } catch (e) {
      if (e instanceof VaultyError) throw e;
      throw storageError('Failed to write encrypted blob to OPFS', e);
    }
  }

  async get(namespace: string, name: string): Promise<Uint8Array | null> {
    assertSafeName(name);
    const dir = await this.#ns(namespace, false);
    if (!dir) return null;
    try {
      const file = await dir.getFileHandle(name);
      return new Uint8Array(await (await file.getFile()).arrayBuffer());
    } catch (e) {
      if (isNotFound(e)) return null;
      throw storageError('Failed to read encrypted blob from OPFS', e);
    }
  }

  async delete(namespace: string, name: string): Promise<void> {
    assertSafeName(name);
    const dir = await this.#ns(namespace, false);
    if (!dir) return;
    try {
      await dir.removeEntry(name);
    } catch (e) {
      if (!isNotFound(e)) throw storageError('Failed to delete blob from OPFS', e);
    }
  }

  async list(namespace: string): Promise<string[]> {
    const dir = await this.#ns(namespace, false);
    return dir ? collectKeys(dir) : [];
  }

  async hasNamespace(namespace: string): Promise<boolean> {
    return (await this.#ns(namespace, false)) !== null;
  }

  async listNamespaces(): Promise<string[]> {
    const base = await this.#base(false);
    return base ? collectKeys(base) : [];
  }

  async deleteNamespace(namespace: string): Promise<void> {
    assertSafeName(namespace, 'namespace');
    const base = await this.#base(false);
    if (!base) return;
    try {
      await base.removeEntry(namespace, { recursive: true });
    } catch (e) {
      if (!isNotFound(e)) throw storageError('Failed to delete vault directory', e);
    }
  }

  async purgeAll(): Promise<void> {
    try {
      const root = await this.#getRoot();
      await root.removeEntry(this.#rootName, { recursive: true });
    } catch (e) {
      if (!isNotFound(e)) throw storageError('Failed to purge OPFS', e);
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* IndexedDB adapter                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface IndexedDBStorageOptions {
  /** Database name. Default `"vaulty-store"`. */
  dbName?: string;
  /** Test injection (e.g. fake-indexeddb). Defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
}

const IDB_STORE = 'blobs';

const requestToPromise = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/** Raw IndexedDB fallback. One object store; keys are `<namespace>/<name>`. */
export class IndexedDBStorageAdapter implements StorageAdapter {
  readonly kind = 'indexeddb';
  readonly #dbName: string;
  readonly #factory: IDBFactory | undefined;
  #db: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDBStorageOptions = {}) {
    this.#dbName = options.dbName ?? 'vaulty-store';
    this.#factory = options.factory;
  }

  get dbName(): string {
    return this.#dbName;
  }

  #open(): Promise<IDBDatabase> {
    if (this.#db) return this.#db;
    const factory = this.#factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) return Promise.reject(storageError('IndexedDB is not available in this environment'));
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(this.#dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Never block a duress-triggered deleteDatabase().
        db.onversionchange = () => {
          db.close();
          this.#db = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(storageError('Failed to open IndexedDB', req.error));
      req.onblocked = () => reject(storageError('IndexedDB open was blocked'));
    });
    this.#db = p;
    p.catch(() => {
      if (this.#db === p) this.#db = null;
    });
    return p;
  }

  async #run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
    const db = await this.#open();
    try {
      const tx = db.transaction(IDB_STORE, mode);
      const done = transactionDone(tx);
      const result = await fn(tx.objectStore(IDB_STORE));
      await done;
      return result;
    } catch (e) {
      if (e instanceof VaultyError) throw e;
      throw storageError('IndexedDB operation failed', e);
    }
  }

  static #key(namespace: string, name: string): string {
    return `${namespace}/${name}`;
  }

  async put(namespace: string, name: string, data: Uint8Array): Promise<void> {
    assertSafeName(namespace, 'namespace');
    assertSafeName(name);
    const copy = data.slice();
    await this.#run('readwrite', (s) => requestToPromise(s.put(copy, IndexedDBStorageAdapter.#key(namespace, name))));
  }

  async get(namespace: string, name: string): Promise<Uint8Array | null> {
    assertSafeName(namespace, 'namespace');
    assertSafeName(name);
    const v = await this.#run('readonly', (s) =>
      requestToPromise<unknown>(s.get(IndexedDBStorageAdapter.#key(namespace, name))),
    );
    if (v === undefined || v === null) return null;
    return new Uint8Array(v as ArrayBuffer | Uint8Array).slice();
  }

  async delete(namespace: string, name: string): Promise<void> {
    assertSafeName(namespace, 'namespace');
    assertSafeName(name);
    await this.#run('readwrite', (s) => requestToPromise(s.delete(IndexedDBStorageAdapter.#key(namespace, name))));
  }

  async #namespaceKeys(namespace: string): Promise<string[]> {
    const range = IDBKeyRange.bound(`${namespace}/`, `${namespace}0`, false, true); // '0' follows '/'
    const keys = await this.#run('readonly', (s) => requestToPromise(s.getAllKeys(range)));
    return keys.map((k) => String(k));
  }

  async list(namespace: string): Promise<string[]> {
    assertSafeName(namespace, 'namespace');
    return (await this.#namespaceKeys(namespace)).map((k) => k.slice(namespace.length + 1));
  }

  async hasNamespace(namespace: string): Promise<boolean> {
    assertSafeName(namespace, 'namespace');
    return (await this.#namespaceKeys(namespace)).length > 0;
  }

  async listNamespaces(): Promise<string[]> {
    const keys = await this.#run('readonly', (s) => requestToPromise(s.getAllKeys()));
    return [...new Set(keys.map((k) => String(k).split('/')[0] as string))];
  }

  async deleteNamespace(namespace: string): Promise<void> {
    assertSafeName(namespace, 'namespace');
    const range = IDBKeyRange.bound(`${namespace}/`, `${namespace}0`, false, true);
    await this.#run('readwrite', (s) => requestToPromise(s.delete(range)));
  }

  async purgeAll(): Promise<void> {
    const factory = this.#factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) return;
    if (this.#db) {
      try {
        (await this.#db).close();
      } catch {
        /* open already failed */
      }
      this.#db = null;
    }
    await deleteDatabase(factory, this.#dbName);
  }
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(storageError('Failed to delete IndexedDB database', req.error));
    req.onblocked = () => resolve(); // deletion proceeds as soon as other connections close
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Factory                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface BestAdapterOptions extends OPFSStorageOptions, IndexedDBStorageOptions {
  /** Skip OPFS probing (e.g. to force the IndexedDB fallback). */
  disableOpfs?: boolean;
  /** Skip IndexedDB (falls back to memory). */
  disableIndexedDb?: boolean;
}

/** Probe OPFS by creating and removing a scratch file. Never throws. */
async function probeOpfs(adapter: OPFSStorageAdapter): Promise<boolean> {
  const probeNs = 'probe';
  try {
    await adapter.put(probeNs, 'probe', new Uint8Array([1]));
    const back = await adapter.get(probeNs, 'probe');
    await adapter.deleteNamespace(probeNs);
    return back !== null && back.length === 1;
  } catch {
    try {
      await adapter.deleteNamespace(probeNs);
    } catch {
      /* ignore */
    }
    return false;
  }
}

async function probeIndexedDb(adapter: IndexedDBStorageAdapter): Promise<boolean> {
  try {
    await adapter.put('probe', 'probe', new Uint8Array([1]));
    const ok = (await adapter.get('probe', 'probe'))?.length === 1;
    await adapter.deleteNamespace('probe');
    return ok;
  } catch {
    return false;
  }
}

/**
 * OPFS → IndexedDB → in-memory, picking the first backend that really works here
 * (private-browsing modes often expose the API but fail on first write).
 */
export async function createBestStorageAdapter(options: BestAdapterOptions = {}): Promise<StorageAdapter> {
  if (!options.disableOpfs) {
    const hasOpfs =
      options.getRoot !== undefined ||
      typeof (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage
        ?.getDirectory === 'function';
    if (hasOpfs) {
      const opfs = new OPFSStorageAdapter(options);
      if (await probeOpfs(opfs)) return opfs;
    }
  }
  if (!options.disableIndexedDb) {
    const hasIdb = options.factory !== undefined || typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
    if (hasIdb) {
      const idb = new IndexedDBStorageAdapter(options);
      if (await probeIndexedDb(idb)) return idb;
    }
  }
  return new MemoryStorageAdapter();
}

/* ------------------------------------------------------------------------------------------ */
/* Environment purge (duress)                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface PurgeReport {
  cacheApi: boolean;
  localStorage: boolean;
  sessionStorage: boolean;
  indexedDb: boolean;
  opfs: boolean;
}

export interface PurgeEnvironmentOptions {
  /** IndexedDB names to delete even where `indexedDB.databases()` is unsupported. */
  indexedDbNames?: string[];
  indexedDbFactory?: IDBFactory;
  getOpfsRoot?: () => Promise<FsDirectoryHandleLike>;
}

/**
 * Best-effort, fail-open destruction of every browser store an app could have used:
 * Cache API, localStorage, sessionStorage, all IndexedDB databases, and the whole OPFS root.
 * Each step is isolated so one failure never prevents the others.
 */
export async function purgeEnvironment(options: PurgeEnvironmentOptions = {}): Promise<PurgeReport> {
  const g = globalThis as unknown as {
    caches?: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> };
    localStorage?: { clear(): void };
    sessionStorage?: { clear(): void };
    indexedDB?: IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  };
  const report: PurgeReport = {
    cacheApi: false,
    localStorage: false,
    sessionStorage: false,
    indexedDb: false,
    opfs: false,
  };

  const steps: Array<Promise<void>> = [
    (async () => {
      if (!g.caches) return;
      for (const k of await g.caches.keys()) await g.caches.delete(k);
      report.cacheApi = true;
    })(),
    (async () => {
      g.localStorage?.clear();
      report.localStorage = g.localStorage !== undefined;
    })(),
    (async () => {
      g.sessionStorage?.clear();
      report.sessionStorage = g.sessionStorage !== undefined;
    })(),
    (async () => {
      const factory = options.indexedDbFactory ?? g.indexedDB;
      if (!factory) return;
      const names = new Set(options.indexedDbNames ?? []);
      names.add('vaulty-store');
      const listed = await (factory as { databases?: () => Promise<Array<{ name?: string }>> }).databases?.();
      for (const d of listed ?? []) if (d.name) names.add(d.name);
      await Promise.allSettled([...names].map((n) => deleteDatabase(factory, n)));
      report.indexedDb = true;
    })(),
    (async () => {
      const root = await (options.getOpfsRoot ?? defaultOpfsRoot)(); // rejects where OPFS is absent
      for (const name of await collectKeys(root)) await root.removeEntry(name, { recursive: true });
      report.opfs = true;
    })(),
  ];
  await Promise.allSettled(steps);
  return report;
}
