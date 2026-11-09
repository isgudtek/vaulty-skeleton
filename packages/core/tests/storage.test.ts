import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IndexedDBStorageAdapter,
  MemoryStorageAdapter,
  OPFSStorageAdapter,
  assertSafeName,
  createBestStorageAdapter,
  purgeEnvironment,
} from '../src/storage';
import { type StorageAdapter, VaultyError } from '../src/types';
import { MockDir, MockSyncOnlyFile } from './helpers/opfs-mock';

let dbCounter = 0;
const freshDb = () => `vaulty-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`;

afterEach(() => vi.unstubAllGlobals());

const NS = 'a'.repeat(64);
const NS2 = 'b'.repeat(64);
const UUID = '123e4567-e89b-42d3-a456-426614174000';

const adapters: Array<[string, () => StorageAdapter]> = [
  ['MemoryStorageAdapter', () => new MemoryStorageAdapter()],
  ['IndexedDBStorageAdapter', () => new IndexedDBStorageAdapter({ dbName: freshDb() })],
  [
    'OPFSStorageAdapter',
    () => {
      const root = new MockDir();
      return new OPFSStorageAdapter({ getRoot: async () => root });
    },
  ],
];

describe.each(adapters)('%s contract', (_name, make) => {
  it('round-trips bytes and returns null for missing items', async () => {
    const a = make();
    expect(await a.get(NS, UUID)).toBeNull();
    const data = new Uint8Array([0, 1, 2, 254, 255]);
    await a.put(NS, UUID, data);
    expect(Array.from((await a.get(NS, UUID)) as Uint8Array)).toEqual([0, 1, 2, 254, 255]);
    expect(await a.get(NS, 'other')).toBeNull();
    expect(await a.get(NS2, UUID)).toBeNull();
  });

  it('isolates stored bytes from caller mutation', async () => {
    const a = make();
    const data = new Uint8Array([1, 2, 3]);
    await a.put(NS, UUID, data);
    data.fill(9);
    const first = (await a.get(NS, UUID)) as Uint8Array;
    expect(Array.from(first)).toEqual([1, 2, 3]);
    first.fill(8);
    expect(Array.from((await a.get(NS, UUID)) as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('overwrites (including with a shorter payload) and handles empty and large blobs', async () => {
    const a = make();
    await a.put(NS, UUID, new Uint8Array(1000).fill(5));
    await a.put(NS, UUID, new Uint8Array([7, 7]));
    expect(Array.from((await a.get(NS, UUID)) as Uint8Array)).toEqual([7, 7]);
    await a.put(NS, 'empty', new Uint8Array(0));
    expect(((await a.get(NS, 'empty')) as Uint8Array).length).toBe(0);
    const big = new Uint8Array(3_000_000).fill(3);
    await a.put(NS, 'big', big);
    expect(((await a.get(NS, 'big')) as Uint8Array).length).toBe(3_000_000);
  });

  it('lists names and namespaces, and reports namespace existence', async () => {
    const a = make();
    expect(await a.listNamespaces()).toEqual([]);
    expect(await a.list(NS)).toEqual([]);
    expect(await a.hasNamespace(NS)).toBe(false);
    await a.put(NS, 'one', new Uint8Array([1]));
    await a.put(NS, 'two', new Uint8Array([2]));
    await a.put(NS2, 'three', new Uint8Array([3]));
    expect((await a.list(NS)).sort()).toEqual(['one', 'two']);
    expect((await a.listNamespaces()).sort()).toEqual([NS, NS2]);
    expect(await a.hasNamespace(NS)).toBe(true);
    // A namespace id that is a string-prefix of another must not bleed into it.
    expect(await a.list(NS.slice(0, 10))).toEqual([]);
  });

  it('deletes single items (idempotent) and whole namespaces without touching others', async () => {
    const a = make();
    await a.put(NS, 'one', new Uint8Array([1]));
    await a.put(NS, 'two', new Uint8Array([2]));
    await a.put(NS2, 'three', new Uint8Array([3]));
    await a.delete(NS, 'one');
    await a.delete(NS, 'one');
    await a.delete('c'.repeat(64), 'nope');
    expect(await a.get(NS, 'one')).toBeNull();
    expect(await a.get(NS, 'two')).not.toBeNull();
    await a.deleteNamespace(NS);
    await a.deleteNamespace(NS);
    expect(await a.hasNamespace(NS)).toBe(false);
    expect(await a.get(NS, 'two')).toBeNull();
    expect(await a.get(NS2, 'three')).not.toBeNull();
  });

  it('purgeAll destroys everything and the adapter stays usable afterwards', async () => {
    const a = make();
    await a.put(NS, 'one', new Uint8Array([1]));
    await a.put(NS2, 'two', new Uint8Array([2]));
    await a.purgeAll();
    expect(await a.listNamespaces()).toEqual([]);
    expect(await a.get(NS, 'one')).toBeNull();
    await a.purgeAll(); // idempotent
    await a.put(NS, 'again', new Uint8Array([4]));
    expect(await a.list(NS)).toEqual(['again']);
  });

  it.each(['', '.', '..', '../escape', 'a/b', 'a\\b', 'with space', 'x'.repeat(129), 'nul\0'])(
    'rejects unsafe name %j (path traversal / separators)',
    async (bad) => {
      const a = make();
      await expect(a.put(bad, 'x', new Uint8Array(1))).rejects.toBeInstanceOf(VaultyError);
      await expect(a.put(NS, bad, new Uint8Array(1))).rejects.toBeInstanceOf(VaultyError);
      await expect(a.get(NS, bad)).rejects.toBeInstanceOf(VaultyError);
      await expect(a.delete(NS, bad)).rejects.toBeInstanceOf(VaultyError);
      await expect(a.list(bad)).rejects.toBeInstanceOf(VaultyError);
      await expect(a.hasNamespace(bad)).rejects.toBeInstanceOf(VaultyError);
      await expect(a.deleteNamespace(bad)).rejects.toBeInstanceOf(VaultyError);
    },
  );
});

describe('assertSafeName', () => {
  it('accepts hashes, uuids and dotted names', () => {
    for (const ok of [NS, UUID, 'keys.bin', 'index.enc', 'a_b-c.d']) expect(() => assertSafeName(ok)).not.toThrow();
  });
  it('rejects non-strings', () => {
    expect(() => assertSafeName(5 as unknown as string)).toThrowError(VaultyError);
  });
});

describe('OPFSStorageAdapter specifics', () => {
  it('stores blobs under <root>/<namespace>/<name> inside a dedicated directory', async () => {
    const root = new MockDir();
    const a = new OPFSStorageAdapter({ getRoot: async () => root, rootName: 'myvaults' });
    await a.put(NS, UUID, new Uint8Array([1]));
    expect(root.paths()).toEqual([`myvaults/${NS}/${UUID}`]);
  });

  it('purgeAll only removes its own root directory', async () => {
    const root = new MockDir();
    const a = new OPFSStorageAdapter({ getRoot: async () => root });
    await a.put(NS, 'x', new Uint8Array([1]));
    await root.getFileHandle('other-app', { create: true });
    await a.purgeAll();
    expect(root.paths()).toEqual(['other-app']);
  });

  it('falls back to the sync access handle where createWritable is missing (Safari workers)', async () => {
    const root = new MockDir(() => new MockSyncOnlyFile());
    const a = new OPFSStorageAdapter({ getRoot: async () => root });
    await a.put(NS, 'x', new Uint8Array(100).fill(9));
    await a.put(NS, 'x', new Uint8Array([1, 2, 3]));
    expect(Array.from((await a.get(NS, 'x')) as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('raises a typed error when OPFS is unavailable', async () => {
    const a = new OPFSStorageAdapter(); // Node has no navigator.storage.getDirectory
    await expect(a.put(NS, 'x', new Uint8Array(1))).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('rejects an unsafe root name', () => {
    expect(() => new OPFSStorageAdapter({ rootName: '../x' })).toThrowError(VaultyError);
  });
});

describe('IndexedDBStorageAdapter specifics', () => {
  it('uses one object store keyed by "<namespace>/<name>" in the named database', async () => {
    const dbName = freshDb();
    const a = new IndexedDBStorageAdapter({ dbName });
    await a.put(NS, UUID, new Uint8Array([1]));
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(dbName);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    expect(Array.from(db.objectStoreNames)).toEqual(['blobs']);
    const keys = await new Promise<IDBValidKey[]>((res) => {
      const r = db.transaction('blobs').objectStore('blobs').getAllKeys();
      r.onsuccess = () => res(r.result);
    });
    db.close();
    expect(keys).toEqual([`${NS}/${UUID}`]);
  });

  it('raises a typed error when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const a = new IndexedDBStorageAdapter({ dbName: freshDb() });
    await expect(a.get(NS, 'x')).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(a.purgeAll()).resolves.toBeUndefined();
  });

  it('survives its database being deleted underneath it (duress from another tab)', async () => {
    const dbName = freshDb();
    const a = new IndexedDBStorageAdapter({ dbName });
    await a.put(NS, 'x', new Uint8Array([1]));
    await new Promise<void>((res) => {
      const r = indexedDB.deleteDatabase(dbName);
      r.onsuccess = () => res();
      r.onblocked = () => res();
    });
    expect(await a.get(NS, 'x')).toBeNull();
    await a.put(NS, 'y', new Uint8Array([2]));
    expect(await a.list(NS)).toEqual(['y']);
  });
});

describe('createBestStorageAdapter', () => {
  it('prefers OPFS when it works', async () => {
    const root = new MockDir();
    const a = await createBestStorageAdapter({ getRoot: async () => root });
    expect(a.kind).toBe('opfs');
    expect(root.paths()).toEqual([]); // the probe cleaned up after itself
  });

  it('falls back to IndexedDB when OPFS probing fails', async () => {
    const a = await createBestStorageAdapter({
      getRoot: async () => {
        throw new Error('SecurityError: private mode');
      },
      dbName: freshDb(),
    });
    expect(a.kind).toBe('indexeddb');
  });

  it('falls back to IndexedDB when OPFS opens but cannot write', async () => {
    const broken = new MockDir(() => {
      const f = new MockSyncOnlyFile();
      (f as { createSyncAccessHandle?: unknown }).createSyncAccessHandle = undefined;
      return f;
    });
    const a = await createBestStorageAdapter({ getRoot: async () => broken, dbName: freshDb() });
    expect(a.kind).toBe('indexeddb');
  });

  it('skips OPFS when navigator.storage.getDirectory is absent (Node) and honours disableOpfs', async () => {
    expect((await createBestStorageAdapter({ dbName: freshDb() })).kind).toBe('indexeddb');
    const root = new MockDir();
    const a = await createBestStorageAdapter({ getRoot: async () => root, disableOpfs: true, dbName: freshDb() });
    expect(a.kind).toBe('indexeddb');
  });

  it('detects real navigator.storage.getDirectory when present', async () => {
    const root = new MockDir();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    const a = await createBestStorageAdapter();
    expect(a.kind).toBe('opfs');
  });

  it('falls back to memory when nothing else is usable', async () => {
    expect((await createBestStorageAdapter({ disableOpfs: true, disableIndexedDb: true })).kind).toBe('memory');
    vi.stubGlobal('indexedDB', undefined);
    expect((await createBestStorageAdapter()).kind).toBe('memory');
  });
});

describe('purgeEnvironment', () => {
  it('clears Cache API, localStorage, sessionStorage, all IndexedDB databases and the OPFS root', async () => {
    const del = vi.fn(async () => true);
    const ls = { clear: vi.fn() };
    const ss = { clear: vi.fn() };
    vi.stubGlobal('caches', { keys: async () => ['c1', 'c2'], delete: del });
    vi.stubGlobal('localStorage', ls);
    vi.stubGlobal('sessionStorage', ss);

    const dbA = freshDb();
    const dbB = freshDb();
    for (const n of [dbA, dbB, 'vaulty-store']) {
      await new Promise<void>((res, rej) => {
        const r = indexedDB.open(n, 1);
        r.onsuccess = () => {
          r.result.close();
          res();
        };
        r.onerror = () => rej(r.error);
      });
    }
    const root = new MockDir();
    await new OPFSStorageAdapter({ getRoot: async () => root }).put(NS, 'x', new Uint8Array(1));
    await root.getFileHandle('foreign', { create: true });

    const report = await purgeEnvironment({ getOpfsRoot: async () => root });
    expect(report).toEqual({ cacheApi: true, localStorage: true, sessionStorage: true, indexedDb: true, opfs: true });
    expect(del).toHaveBeenCalledTimes(2);
    expect(ls.clear).toHaveBeenCalledOnce();
    expect(ss.clear).toHaveBeenCalledOnce();
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain(dbA);
    expect(names).not.toContain(dbB);
    expect(names).not.toContain('vaulty-store');
    expect(root.paths()).toEqual([]);
  });

  it('is fail-open: one throwing step never blocks the others, and absent APIs are skipped', async () => {
    const ss = { clear: vi.fn() };
    vi.stubGlobal('localStorage', {
      clear: () => {
        throw new Error('SecurityError');
      },
    });
    vi.stubGlobal('sessionStorage', ss);
    vi.stubGlobal('caches', {
      keys: async () => {
        throw new Error('boom');
      },
    });
    const report = await purgeEnvironment({ getOpfsRoot: async () => Promise.reject(new Error('no opfs')) });
    expect(report.localStorage).toBe(false);
    expect(report.cacheApi).toBe(false);
    expect(report.opfs).toBe(false);
    expect(report.sessionStorage).toBe(true);
    expect(ss.clear).toHaveBeenCalled();
  });
});
