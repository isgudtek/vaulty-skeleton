import 'fake-indexeddb/auto';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, concatBytes, equalBytes } from '../src/bytes';
import { sha256 } from '../src/crypto';
import {
  ARCHIVE_MAGIC,
  INDEX_FILE,
  KEYS_FILE,
  RECORD_MIME,
  VaultClient,
  type VaultClientOptions,
  readArchiveHeader,
} from '../src/vault';
import { IndexedDBStorageAdapter, MemoryStorageAdapter, OPFSStorageAdapter } from '../src/storage';
import { VaultyError } from '../src/types';
import { MockDir } from './helpers/opfs-mock';

const FAST = 1_000;
const PATTERN_A = [0, 1, 2, 3, 4, 9];
const PATTERN_B = [24, 23, 22, 21, 20, 15];
const PATTERN_C = [6, 7, 8, 12, 16, 18];
const DURESS = [10, 11, 12, 13, 14, 19];
const NEW_PATTERN = [20, 21, 22, 23, 24, 19];

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeClient(adapter = new MemoryStorageAdapter(), extra: Partial<VaultClientOptions> = {}) {
  const client = new VaultClient({ adapter, kdfIterations: FAST, ...extra });
  return { client, adapter };
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  let err: unknown = null;
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err, `expected VaultyError(${code})`).toBeInstanceOf(VaultyError);
  expect((err as VaultyError).code).toBe(code);
}

/** Dump every byte stored by an adapter for plaintext-leak scanning. */
async function dumpAdapter(adapter: MemoryStorageAdapter): Promise<Array<{ ns: string; name: string; data: Uint8Array }>> {
  const out: Array<{ ns: string; name: string; data: Uint8Array }> = [];
  for (const ns of await adapter.listNamespaces()) {
    for (const name of await adapter.list(ns)) {
      out.push({ ns, name, data: (await adapter.get(ns, name)) as Uint8Array });
    }
  }
  return out;
}

const contains = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle));

/** Stub every browser store a duress wipe must destroy; returns spies. */
function stubBrowserStores() {
  const stores = {
    localStorage: { clear: vi.fn(), setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() },
    sessionStorage: { clear: vi.fn(), setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() },
    cacheDelete: vi.fn(async () => true),
  };
  vi.stubGlobal('localStorage', stores.localStorage);
  vi.stubGlobal('sessionStorage', stores.sessionStorage);
  vi.stubGlobal('caches', { keys: async () => ['app-shell', 'media'], delete: stores.cacheDelete });
  return stores;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('plausible deniability routing', () => {
  it('creates a vault silently on first use and re-opens it with the same pattern', async () => {
    const { client } = makeClient();
    const first = await client.unlock(PATTERN_A);
    expect(first.status).toBe('unlocked');
    if (first.status !== 'unlocked') throw new Error('unreachable');
    expect(first.created).toBe(true);
    expect(first.recoveryPhrase?.split(' ')).toHaveLength(9);
    expect(first.namespaceId).toMatch(/^[0-9a-f]{64}$/);
    expect(client.isUnlocked).toBe(true);

    await client.putFile(enc.encode('persisted'), { name: 'p.txt' });
    client.lock();
    expect(client.isUnlocked).toBe(false);

    const again = await client.unlock(PATTERN_A);
    if (again.status !== 'unlocked') throw new Error('unreachable');
    expect(again.created).toBe(false);
    expect(again.recoveryPhrase).toBeUndefined();
    expect(again.namespaceId).toBe(first.namespaceId);
    expect(client.listEntries().map((e) => e.name)).toEqual(['p.txt']);
  });

  it('isolates vaults: unknown Pattern B silently initialises Vault B without leaking Vault A', async () => {
    const { client, adapter } = makeClient();
    await client.unlock(PATTERN_A);
    const secret = await client.putFile(enc.encode('vault A secret'), { name: 'a-only.txt', tags: ['a'] });
    const rec = await client.putRecord({ diary: 'dear A' }, { name: 'a-diary' });
    client.lock();

    // Pattern B has never been used: must NOT throw "invalid pattern", must open an empty vault.
    const b = await client.unlock(PATTERN_B);
    expect(b.status).toBe('unlocked');
    if (b.status !== 'unlocked') throw new Error('unreachable');
    expect(b.created).toBe(true);
    expect(client.listEntries()).toEqual([]);
    await expectCode(client.getFile(secret.id), 'NOT_FOUND');
    await expectCode(client.getRecord(rec.id), 'NOT_FOUND');

    const bFile = await client.putFile(enc.encode('vault B secret'), { name: 'b-only.txt' });
    client.lock();

    // A still intact and does not see B.
    await client.unlock(PATTERN_A);
    expect(client.listEntries().map((e) => e.name).sort()).toEqual(['a-diary', 'a-only.txt']);
    expect(dec.decode((await client.getFile(secret.id)).data)).toBe('vault A secret');
    await expectCode(client.getFile(bFile.id), 'NOT_FOUND');
    client.lock();

    await client.unlock(PATTERN_B);
    expect(client.listEntries().map((e) => e.name)).toEqual(['b-only.txt']);
    expect(await adapter.listNamespaces()).toHaveLength(2);
  });

  it('a blob copied from vault A into vault B storage is useless (not indexed, different key)', async () => {
    const { client, adapter } = makeClient();
    const a = await client.unlock(PATTERN_A);
    const f = await client.putFile(enc.encode('A data'), { name: 'a.bin' });
    client.lock();
    const b = await client.unlock(PATTERN_B);
    if (a.status !== 'unlocked' || b.status !== 'unlocked') throw new Error('unreachable');
    const stolen = (await adapter.get(a.namespaceId, f.id)) as Uint8Array;
    await adapter.put(b.namespaceId, f.id, stolen);
    await expectCode(client.getFile(f.id), 'NOT_FOUND');
  });

  it('binds ciphertext to its item id: swapping two blobs inside one vault is detected', async () => {
    const { client, adapter } = makeClient();
    const r = await client.unlock(PATTERN_A);
    if (r.status !== 'unlocked') throw new Error('unreachable');
    const f1 = await client.putFile(enc.encode('one'), { name: '1' });
    const f2 = await client.putFile(enc.encode('two'), { name: '2' });
    const b1 = (await adapter.get(r.namespaceId, f1.id)) as Uint8Array;
    const b2 = (await adapter.get(r.namespaceId, f2.id)) as Uint8Array;
    await adapter.put(r.namespaceId, f1.id, b2);
    await adapter.put(r.namespaceId, f2.id, b1);
    await expectCode(client.getFile(f1.id), 'CRYPTO_FAILURE');
    await expectCode(client.getFile(f2.id), 'CRYPTO_FAILURE');
  });

  it('silently replaces a namespace whose key file is corrupt (no "invalid pattern" signal)', async () => {
    const { client, adapter } = makeClient();
    const r = await client.unlock(PATTERN_A);
    if (r.status !== 'unlocked') throw new Error('unreachable');
    await client.putFile(enc.encode('x'), { name: 'x' });
    client.lock();
    const keys = (await adapter.get(r.namespaceId, KEYS_FILE)) as Uint8Array;
    keys[40] = (keys[40] as number) ^ 0xff;
    await adapter.put(r.namespaceId, KEYS_FILE, keys);
    const again = await client.unlock(PATTERN_A);
    expect(again.status).toBe('unlocked');
    expect(client.listEntries()).toEqual([]);
  });

  it('silently replaces a namespace whose index fails authentication', async () => {
    const { client, adapter } = makeClient();
    const r = await client.unlock(PATTERN_A);
    if (r.status !== 'unlocked') throw new Error('unreachable');
    client.lock();
    const idx = (await adapter.get(r.namespaceId, INDEX_FILE)) as Uint8Array;
    idx[idx.length - 1] = (idx[idx.length - 1] as number) ^ 1;
    await adapter.put(r.namespaceId, INDEX_FILE, idx);
    const again = await client.unlock(PATTERN_A);
    if (again.status !== 'unlocked') throw new Error('unreachable');
    expect(again.created).toBe(true);
  });

  it('rejects structurally invalid patterns before touching storage', async () => {
    const { client, adapter } = makeClient();
    await expectCode(client.unlock([1, 2, 3]), 'INVALID_PATTERN');
    await expectCode(client.unlock([1, 1, 2, 3, 4, 5]), 'INVALID_PATTERN');
    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('serialises concurrent unlocks safely', async () => {
    const { client, adapter } = makeClient();
    const results = await Promise.all([client.unlock(PATTERN_A), client.unlock(PATTERN_B), client.unlock(PATTERN_A)]);
    expect(results.every((r) => r.status === 'unlocked')).toBe(true);
    expect(client.isUnlocked).toBe(true);
    expect(await adapter.listNamespaces()).toHaveLength(2);
  });
});

describe('zero-leak storage layout', () => {
  it('stores only ciphertext and constant/UUID object names, never touching localStorage/sessionStorage', async () => {
    const stores = stubBrowserStores();
    const { client, adapter } = makeClient();
    await client.unlock(PATTERN_A);
    const marker = 'TOP-SECRET-MARKER-9f3a';
    await client.putFile(enc.encode(`payload ${marker}`), { name: `${marker}.txt`, tags: [marker], mimeType: 'text/plain' });
    await client.putRecord({ note: marker }, { name: marker });
    client.lock();
    await client.unlock(PATTERN_B); // a second (decoy) vault
    client.lock();

    const dump = await dumpAdapter(adapter);
    expect(dump.length).toBeGreaterThan(4);
    for (const { ns, name, data } of dump) {
      expect(ns).toMatch(/^[0-9a-f]{64}$/);
      expect(name).toMatch(
        /^(keys\.bin|index\.enc|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
      );
      expect(contains(data, marker)).toBe(false);
      expect(contains(data, 'text/plain')).toBe(false);
      expect(contains(data, 'duress')).toBe(false);
    }
    // Vault A and the decoy B have identical structure (keys.bin + index.enc [+ blobs]).
    const names = (ns: string) => dump.filter((d) => d.ns === ns).map((d) => d.name);
    const nss = [...new Set(dump.map((d) => d.ns))];
    expect(nss).toHaveLength(2);
    for (const ns of nss) {
      expect(names(ns)).toContain(KEYS_FILE);
      expect(names(ns)).toContain(INDEX_FILE);
    }
    expect(stores.localStorage.setItem).not.toHaveBeenCalled();
    expect(stores.localStorage.getItem).not.toHaveBeenCalled();
    expect(stores.sessionStorage.setItem).not.toHaveBeenCalled();
    expect(stores.sessionStorage.getItem).not.toHaveBeenCalled();
  });

  it('keys.bin has a fixed size so vault kinds are indistinguishable', async () => {
    const { client, adapter } = makeClient();
    const a = await client.unlock(PATTERN_A);
    await client.configureDuress(DURESS);
    client.lock();
    const dump = await dumpAdapter(adapter);
    const sizes = new Set(dump.filter((d) => d.name === KEYS_FILE).map((d) => d.data.length));
    expect(sizes.size).toBe(1);
    expect([...sizes][0]).toBe(1 + 82 + 82);
    expect(a.status).toBe('unlocked');
  });
});

describe('encrypted file and structured record CRUD', () => {
  let now = 1_700_000_000_000;
  const tick = () => (now += 1000);
  beforeEach(() => {
    now = 1_700_000_000_000;
  });

  it('puts, gets, overwrites and deletes files with correct metadata', async () => {
    const { client, adapter } = makeClient(new MemoryStorageAdapter(), { now: tick });
    const r = await client.unlock(PATTERN_A);
    if (r.status !== 'unlocked') throw new Error('unreachable');

    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
    const entry = await client.putFile(bytes, { name: 'photo.png', mimeType: 'image/png', tags: ['holiday', 'raw'] });
    expect(entry).toMatchObject({ name: 'photo.png', mimeType: 'image/png', size: 70_000, tags: ['holiday', 'raw'] });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.createdAt).toBe(entry.updatedAt);

    const got = await client.getFile(entry.id);
    expect(equalBytes(got.data, bytes)).toBe(true);
    expect(got.entry).toEqual(entry);

    // Stored blob is named by the UUID and is NOT the plaintext.
    const stored = (await adapter.get(r.namespaceId, entry.id)) as Uint8Array;
    expect(stored.length).toBe(bytes.length + 12 + 16);
    expect(equalBytes(stored.subarray(12, 12 + 64), bytes.subarray(0, 64))).toBe(false);

    // Overwrite same id: createdAt preserved, updatedAt bumped, ciphertext re-randomised.
    const updated = await client.putFile(enc.encode('small now'), { name: 'photo.txt', mimeType: 'text/plain', id: entry.id });
    expect(updated.id).toBe(entry.id);
    expect(updated.createdAt).toBe(entry.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(entry.updatedAt);
    expect(updated.size).toBe(9);
    expect(dec.decode((await client.getFile(entry.id)).data)).toBe('small now');
    expect(client.listEntries()).toHaveLength(1);

    expect(await client.deleteFile(entry.id)).toBe(true);
    expect(await client.deleteFile(entry.id)).toBe(false);
    expect(await adapter.get(r.namespaceId, entry.id)).toBeNull();
    expect(client.listEntries()).toEqual([]);
    await expectCode(client.getFile(entry.id), 'NOT_FOUND');
  });

  it('persists the encrypted index across lock/unlock and new client instances', async () => {
    const adapter = new MemoryStorageAdapter();
    const { client } = makeClient(adapter);
    await client.unlock(PATTERN_A);
    const f = await client.putFile(enc.encode('hello'), { name: 'hello.txt', tags: ['t'] });
    client.dispose();

    const { client: fresh } = makeClient(adapter);
    const r = await fresh.unlock(PATTERN_A);
    if (r.status !== 'unlocked') throw new Error('unreachable');
    expect(r.created).toBe(false);
    expect(fresh.listEntries()).toEqual([f]);
    expect(dec.decode((await fresh.getFile(f.id)).data)).toBe('hello');
  });

  it('filters listEntries by tag, mime type and name', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    await client.putFile(enc.encode('1'), { name: 'Alpha.txt', mimeType: 'text/plain', tags: ['x'] });
    await client.putFile(enc.encode('2'), { name: 'beta.png', mimeType: 'image/png', tags: ['x', 'y'] });
    await client.putFile(enc.encode('3'), { name: 'gamma.png', mimeType: 'image/png' });
    expect(client.listEntries()).toHaveLength(3);
    expect(client.listEntries({ tag: 'x' }).map((e) => e.name).sort()).toEqual(['Alpha.txt', 'beta.png']);
    expect(client.listEntries({ tag: 'y' })).toHaveLength(1);
    expect(client.listEntries({ mimeType: 'image/png' })).toHaveLength(2);
    expect(client.listEntries({ nameContains: 'ALPHA' }).map((e) => e.name)).toEqual(['Alpha.txt']);
    expect(client.listEntries({ tag: 'x', mimeType: 'image/png' }).map((e) => e.name)).toEqual(['beta.png']);
  });

  it('returns defensive copies of metadata', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    const e = await client.putFile(enc.encode('1'), { name: 'a', tags: ['t'] });
    e.tags.push('mutated');
    e.name = 'mutated';
    client.listEntries()[0]!.tags.push('also-mutated');
    expect(client.listEntries()[0]).toMatchObject({ name: 'a', tags: ['t'] });
  });

  it('stores and retrieves typed JSON records', async () => {
    interface Contact {
      name: string;
      phones: string[];
      address: { city: string };
    }
    const { client } = makeClient(new MemoryStorageAdapter(), { now: tick });
    await client.unlock(PATTERN_A);
    const data: Contact = { name: 'Ada', phones: ['+1 555 0100'], address: { city: 'London' } };
    const rec = await client.putRecord<Contact>(data, { name: 'ada', tags: ['contact'] });
    expect(rec.data).toEqual(data);
    expect(rec).toMatchObject({ name: 'ada', tags: ['contact'] });

    const back = await client.getRecord<Contact>(rec.id);
    expect(back).toEqual(rec);
    expect(back.data.address.city).toBe('London');

    // Records are listed with the dedicated MIME type and can be updated in place.
    expect(client.listEntries({ mimeType: RECORD_MIME })).toHaveLength(1);
    const updated = await client.putRecord<Contact>({ ...data, name: 'Ada L.' }, { id: rec.id, name: 'ada', tags: ['contact'] });
    expect(updated.createdAt).toBe(rec.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(rec.updatedAt);
    expect((await client.getRecord<Contact>(rec.id)).data.name).toBe('Ada L.');
    expect(client.listEntries()).toHaveLength(1);

    expect(await client.deleteFile(rec.id)).toBe(true);
    await expectCode(client.getRecord(rec.id), 'NOT_FOUND');
  });

  it('round-trips awkward JSON values and rejects non-serialisable ones', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    for (const v of [null, 0, 'é☃😀', [1, [2, { a: null }]], { 'quoted"key': '\n\t\\' }]) {
      const r = await client.putRecord(v);
      expect((await client.getRecord<unknown>(r.id)).data).toEqual(v);
    }
    await expectCode(client.putRecord(undefined), 'INVALID_ARGUMENT');
    await expectCode(client.putRecord(() => 1), 'INVALID_ARGUMENT');
  });

  it('refuses to read a plain file as a record', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    const f = await client.putFile(enc.encode('{"a":1}'), { name: 'x.json', mimeType: 'application/json' });
    await expectCode(client.getRecord(f.id), 'INVALID_ARGUMENT');
  });

  it('validates arguments', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    const d = enc.encode('x');
    await expectCode(client.putFile(d, { name: '' }), 'INVALID_ARGUMENT');
    await expectCode(client.putFile(d, { name: 'a', id: '../../etc/passwd' }), 'INVALID_ARGUMENT');
    await expectCode(client.putFile(d, { name: 'a', id: 'ABCDEF00-0000-0000-0000-000000000000' }), 'INVALID_ARGUMENT');
    await expectCode(client.putFile(d, { name: 'a', tags: [1 as unknown as string] }), 'INVALID_ARGUMENT');
    await expectCode(client.putFile('str' as unknown as Uint8Array, { name: 'a' }), 'INVALID_ARGUMENT');
  });

  it('detects a tampered blob', async () => {
    const { client, adapter } = makeClient();
    const r = await client.unlock(PATTERN_A);
    if (r.status !== 'unlocked') throw new Error('unreachable');
    const f = await client.putFile(enc.encode('integrity'), { name: 'i' });
    const blob = (await adapter.get(r.namespaceId, f.id)) as Uint8Array;
    blob[15] = (blob[15] as number) ^ 1;
    await adapter.put(r.namespaceId, f.id, blob);
    await expectCode(client.getFile(f.id), 'CRYPTO_FAILURE');
    await adapter.delete(r.namespaceId, f.id);
    await expectCode(client.getFile(f.id), 'NOT_FOUND');
  });

  it('serialises concurrent writes without losing index updates', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    await Promise.all(Array.from({ length: 12 }, (_, i) => client.putRecord({ i }, { name: `r${i}` })));
    expect(client.listEntries()).toHaveLength(12);
    client.lock();
    await client.unlock(PATTERN_A);
    expect(client.listEntries()).toHaveLength(12);
  });
});

describe('locking & key hygiene', () => {
  it('rejects every data operation while locked', async () => {
    const { client } = makeClient();
    const d = enc.encode('x');
    await expectCode(client.putFile(d, { name: 'a' }), 'VAULT_LOCKED');
    await expectCode(client.getFile('x'), 'VAULT_LOCKED');
    await expectCode(client.deleteFile('x'), 'VAULT_LOCKED');
    await expectCode(client.putRecord({}), 'VAULT_LOCKED');
    await expectCode(client.getRecord('x'), 'VAULT_LOCKED');
    await expectCode(() => client.listEntries(), 'VAULT_LOCKED');
    await expectCode(client.exportArchive(), 'VAULT_LOCKED');
    await expectCode(client.configureDuress(DURESS), 'VAULT_LOCKED');
  });

  it('lock() notifies subscribers and drops decrypted state', async () => {
    const onLock = vi.fn();
    const { client } = makeClient(new MemoryStorageAdapter(), { onLock });
    const states: boolean[] = [];
    const unsubscribe = client.subscribe((s) => states.push(s.unlocked));
    await client.unlock(PATTERN_A);
    await client.putFile(enc.encode('x'), { name: 'x' });
    client.lock();
    expect(states).toEqual([true, false]);
    expect(onLock).toHaveBeenCalledWith('manual');
    expect(client.state).toMatchObject({ unlocked: false, namespaceId: null, lastLockReason: 'manual' });
    await expectCode(() => client.listEntries(), 'VAULT_LOCKED');
    unsubscribe();
    await client.unlock(PATTERN_A);
    expect(states).toEqual([true, false]);
  });

  it('auto-locks after the idle timeout and re-arms on activity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client } = makeClient(new MemoryStorageAdapter(), { idleTimeoutMs: 1000 });
    await client.unlock(PATTERN_A);
    await vi.advanceTimersByTimeAsync(800);
    client.touch();
    await vi.advanceTimersByTimeAsync(800);
    expect(client.isUnlocked).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(client.isUnlocked).toBe(false);
    expect(client.state.lastLockReason).toBe('idle');
  });

  it('locks when the document becomes hidden and on pagehide', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      visibilityState: 'visible',
      addEventListener: (t: string, l: () => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l),
      removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
    };
    const fire = (t: string) => listeners.get(t)?.forEach((l) => l());
    const { client } = makeClient(new MemoryStorageAdapter(), { guard: { documentRef: target, windowRef: target } });

    await client.unlock(PATTERN_A);
    fire('visibilitychange'); // still visible: nothing happens
    expect(client.isUnlocked).toBe(true);
    target.visibilityState = 'hidden';
    fire('visibilitychange');
    expect(client.isUnlocked).toBe(false);
    expect(client.state.lastLockReason).toBe('hidden');
    expect(listeners.get('visibilitychange')?.size ?? 0).toBe(0); // listeners removed on lock

    target.visibilityState = 'visible';
    await client.unlock(PATTERN_A);
    fire('pagehide');
    expect(client.isUnlocked).toBe(false);
    expect(client.state.lastLockReason).toBe('pagehide');
  });
});

describe('portable .vault archives', () => {
  async function seededClient() {
    const { client, adapter } = makeClient();
    const r = await client.unlock(PATTERN_A);
    if (r.status !== 'unlocked' || !r.recoveryPhrase) throw new Error('unreachable');
    const bin = new Uint8Array(5000);
    crypto.getRandomValues(bin.subarray(0, 5000));
    const file = await client.putFile(bin, { name: 'doc.bin', mimeType: 'application/octet-stream', tags: ['k'] });
    const rec = await client.putRecord({ secret: 'ARCHIVE-SECRET-77' }, { name: 'rec', tags: ['r'] });
    return { client, adapter, phrase: r.recoveryPhrase, ns: r.namespaceId, bin, file, rec };
  }

  it('round-trips through export → import into a brand-new store using the pattern', async () => {
    const { client, ns, bin, file, rec } = await seededClient();
    const progress: Array<[string, number]> = [];
    const archive = await client.exportArchive((s, p) => progress.push([s, p]));

    // Format assertions.
    expect(dec.decode(archive.subarray(0, 4))).toBe(ARCHIVE_MAGIC);
    expect(archive[4]).toBe(1); // version
    expect(archive[5]).toBe(0); // flags
    expect(bytesToHex(archive.subarray(6, 38))).toBe(ns);
    const body = archive.subarray(0, archive.length - 32);
    expect(equalBytes(archive.subarray(archive.length - 32), await sha256(body))).toBe(true);
    expect(contains(archive, 'ARCHIVE-SECRET-77')).toBe(false);
    expect(contains(archive, 'doc.bin')).toBe(false);

    // Progress is monotonic and finishes at 100.
    expect(progress[0]).toEqual(['preparing', 0]);
    expect(progress.at(-1)).toEqual(['done', 100]);
    const pcts = progress.map(([, p]) => p);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);

    const header = await readArchiveHeader(archive);
    expect(header).toMatchObject({ magic: 'VLT1', version: 1, namespaceId: ns, blobCount: 2 });
    expect(header.patternEnvelope.kdfIterations).toBe(FAST);

    const { client: restored } = makeClient();
    const importProgress: Array<[string, number]> = [];
    const res = await restored.importArchive(archive, PATTERN_A, (s, p) => importProgress.push([s, p]));
    expect(res).toEqual({ status: 'imported', namespaceId: ns, entryCount: 2 });
    expect(importProgress.at(-1)).toEqual(['done', 100]);
    expect(restored.isUnlocked).toBe(true);
    expect(equalBytes((await restored.getFile(file.id)).data, bin)).toBe(true);
    expect(await restored.getRecord(rec.id)).toEqual(rec);
    expect(restored.listEntries()).toHaveLength(2);

    // And it persisted: a cold client with the same storage can unlock with the pattern.
    restored.lock();
    const again = await restored.unlock(PATTERN_A);
    if (again.status !== 'unlocked') throw new Error('unreachable');
    expect(again.created).toBe(false);
    expect(restored.listEntries()).toHaveLength(2);
  });

  it('recovers the whole vault from the 9-word phrase alone, re-keyed to a new pattern', async () => {
    const { client, phrase, bin, file, rec } = await seededClient();
    const archive = await client.exportArchive();

    const { client: fresh, adapter } = makeClient();
    const res = await fresh.importArchive(archive, phrase, undefined, { newPattern: NEW_PATTERN });
    expect(res.entryCount).toBe(2);
    expect(fresh.isUnlocked).toBe(true);
    expect(equalBytes((await fresh.getFile(file.id)).data, bin)).toBe(true);
    expect(await fresh.getRecord(rec.id)).toEqual(rec);
    // Re-keyed: namespace is derived from the new pattern, so AAD-bound blobs were re-encrypted.
    expect(res.namespaceId).not.toBe(client.namespaceId);
    expect(await adapter.listNamespaces()).toEqual([res.namespaceId]);

    fresh.lock();
    const viaNew = await fresh.unlock(NEW_PATTERN);
    if (viaNew.status !== 'unlocked') throw new Error('unreachable');
    expect(viaNew.created).toBe(false);
    expect(fresh.listEntries()).toHaveLength(2);
    expect(equalBytes((await fresh.getFile(file.id)).data, bin)).toBe(true);
    fresh.lock();

    // The OLD pattern no longer opens anything in this store (deniably yields an empty vault).
    const viaOld = await fresh.unlock(PATTERN_A);
    if (viaOld.status !== 'unlocked') throw new Error('unreachable');
    expect(viaOld.created).toBe(true);
    expect(fresh.listEntries()).toEqual([]);
    fresh.lock();

    // The same recovery phrase still works on a later export of the recovered vault.
    await fresh.unlock(NEW_PATTERN);
    const second = await fresh.exportArchive();
    const { client: third } = makeClient();
    await third.importArchive(second, phrase, undefined, { newPattern: PATTERN_C });
    expect(equalBytes((await third.getFile(file.id)).data, bin)).toBe(true);
  });

  it('recovers with the phrase without re-keying (original pattern retained)', async () => {
    const { client, phrase, ns, file, bin } = await seededClient();
    const archive = await client.exportArchive();
    const { client: fresh } = makeClient();
    const res = await fresh.importArchive(archive, `  ${phrase.toUpperCase()}  `);
    expect(res.namespaceId).toBe(ns);
    expect(equalBytes((await fresh.getFile(file.id)).data, bin)).toBe(true);
    fresh.lock();
    const again = await fresh.unlock(PATTERN_A);
    if (again.status !== 'unlocked') throw new Error('unreachable');
    expect(again.created).toBe(false);
  });

  it('also accepts ArrayBuffer and Blob bundles, and can re-key via pattern import', async () => {
    const { client, file, bin } = await seededClient();
    const archive = await client.exportArchive();
    const ab = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;

    const { client: c1 } = makeClient();
    await c1.importArchive(ab, PATTERN_A);
    expect(equalBytes((await c1.getFile(file.id)).data, bin)).toBe(true);

    const { client: c2 } = makeClient();
    await c2.importArchive(new Blob([archive.slice()]), PATTERN_A, undefined, { newPattern: PATTERN_B });
    expect(equalBytes((await c2.getFile(file.id)).data, bin)).toBe(true);
  });

  it('overwrites an existing vault in the target namespace on import', async () => {
    const { client, file } = await seededClient();
    const archive = await client.exportArchive();
    const { client: target } = makeClient();
    await target.unlock(PATTERN_A);
    const junk = await target.putFile(enc.encode('junk'), { name: 'junk' });
    await target.importArchive(archive, PATTERN_A);
    expect(target.listEntries().map((e) => e.id).sort()).toEqual([file.id, (await target.listEntries({ mimeType: RECORD_MIME })[0])!.id].sort());
    await expectCode(target.getFile(junk.id), 'NOT_FOUND');
  });

  it('rejects the wrong pattern, wrong phrase and malformed phrase', async () => {
    const { client, phrase } = await seededClient();
    const archive = await client.exportArchive();
    const { client: fresh, adapter } = makeClient();
    await expectCode(fresh.importArchive(archive, PATTERN_B), 'CRYPTO_FAILURE');
    await expectCode(fresh.importArchive(archive, 'abandon '.repeat(8) + 'zoo'), 'CRYPTO_FAILURE');
    await expectCode(fresh.importArchive(archive, phrase.split(' ').slice(1).join(' ')), 'INVALID_RECOVERY_PHRASE');
    await expectCode(fresh.importArchive(archive, [1, 2]), 'INVALID_PATTERN');
    expect(await adapter.listNamespaces()).toEqual([]); // nothing written on failure
    expect(fresh.isUnlocked).toBe(false);
  });

  it('rejects corrupt, truncated and foreign files without writing anything', async () => {
    const { client } = await seededClient();
    const archive = await client.exportArchive();
    const { client: fresh, adapter } = makeClient();

    const flipped = archive.slice();
    flipped[100] = (flipped[100] as number) ^ 1;
    await expectCode(fresh.importArchive(flipped, PATTERN_A), 'ARCHIVE_INVALID');
    await expectCode(fresh.importArchive(archive.subarray(0, archive.length - 5), PATTERN_A), 'ARCHIVE_INVALID');
    await expectCode(fresh.importArchive(new Uint8Array(10), PATTERN_A), 'ARCHIVE_INVALID');
    await expectCode(fresh.importArchive(enc.encode('NOPE' + 'x'.repeat(64)), PATTERN_A), 'ARCHIVE_INVALID');
    await expectCode(fresh.importArchive('nope' as unknown as Uint8Array, PATTERN_A), 'INVALID_ARGUMENT');

    // Re-sealed with a valid checksum but a tampered ciphertext byte → authentication failure.
    const body = archive.slice(0, archive.length - 32);
    body[body.length - 20] = (body[body.length - 20] as number) ^ 1;
    const resealed = concatBytes(body, await sha256(body));
    await expectCode(fresh.importArchive(resealed, PATTERN_A), 'ARCHIVE_INVALID');

    // Unsupported version, re-sealed.
    const v2 = archive.slice(0, archive.length - 32);
    v2[4] = 2;
    await expectCode(fresh.importArchive(concatBytes(v2, await sha256(v2)), PATTERN_A), 'ARCHIVE_INVALID');

    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('exports an empty vault and restores it', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    const archive = await client.exportArchive();
    expect((await readArchiveHeader(archive)).blobCount).toBe(0);
    const { client: fresh } = makeClient();
    expect((await fresh.importArchive(archive, PATTERN_A)).entryCount).toBe(0);
  });
});

describe('forensic-safe duress engine', () => {
  async function populated(extra: Partial<VaultClientOptions> = {}) {
    const adapter = new MemoryStorageAdapter();
    const { client } = makeClient(adapter, extra);
    await client.unlock(PATTERN_A);
    await client.putFile(enc.encode('a'), { name: 'a' });
    client.lock();
    await client.unlock(PATTERN_B);
    await client.putFile(enc.encode('b'), { name: 'b' });
    client.lock();
    expect(await adapter.listNamespaces()).toHaveLength(2);
    return { client, adapter };
  }

  it('runtime duress pattern: purges adapter, Cache API, localStorage, sessionStorage and wipes the live key', async () => {
    const stores = stubBrowserStores();
    const { client, adapter } = await populated({ duressPattern: DURESS });
    await client.unlock(PATTERN_A); // active unlocked session at the moment of duress
    const states: boolean[] = [];
    client.subscribe((s) => states.push(s.unlocked));

    const res = await client.unlock(DURESS);
    expect(res).toEqual({ status: 'duress_triggered' });
    expect(client.isUnlocked).toBe(false);
    expect(states).toEqual([false]);
    expect(await adapter.listNamespaces()).toEqual([]);
    expect(stores.localStorage.clear).toHaveBeenCalled();
    expect(stores.sessionStorage.clear).toHaveBeenCalled();
    expect(stores.cacheDelete).toHaveBeenCalledWith('app-shell');
    expect(stores.cacheDelete).toHaveBeenCalledWith('media');

    // Everything is gone for real: A re-opens as a brand-new empty vault.
    const a = await client.unlock(PATTERN_A);
    if (a.status !== 'unlocked') throw new Error('unreachable');
    expect(a.created).toBe(true);
    expect(client.listEntries()).toEqual([]);
  });

  it('runtime duress works on a never-used store and writes nothing to disk', async () => {
    const adapter = new MemoryStorageAdapter();
    const { client } = makeClient(adapter, { duressPattern: DURESS });
    expect(await client.unlock(DURESS)).toEqual({ status: 'duress_triggered' });
    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('can skip the global environment purge when disabled', async () => {
    const stores = stubBrowserStores();
    const { client, adapter } = await populated({ duressPattern: DURESS, purgeEnvironment: false });
    expect(await client.unlock(DURESS)).toEqual({ status: 'duress_triggered' });
    expect(await adapter.listNamespaces()).toEqual([]);
    expect(stores.localStorage.clear).not.toHaveBeenCalled();
  });

  it('configured-in-vault duress: persisted ONLY as an encrypted, decoy-looking vault', async () => {
    const stores = stubBrowserStores();
    const adapter = new MemoryStorageAdapter();
    const { client } = makeClient(adapter); // NO runtime duress option anywhere
    await client.unlock(PATTERN_A);
    await client.putFile(enc.encode('real'), { name: 'real' });
    await client.configureDuress(DURESS);

    const dump = await dumpAdapter(adapter);
    const nss = [...new Set(dump.map((d) => d.ns))];
    expect(nss).toHaveLength(2);
    for (const d of dump) {
      expect(contains(d.data, 'duress')).toBe(false); // no plaintext marker anywhere
      expect(contains(d.data, 'true')).toBe(false);
    }
    // Duress vault is structurally identical to a normal one.
    const duressNs = nss.find((n) => n !== client.namespaceId)!;
    expect((await adapter.list(duressNs)).sort()).toEqual([INDEX_FILE, KEYS_FILE].sort());
    client.lock();

    // A completely fresh client instance still honours it, proving it lives in the encrypted store.
    const { client: cold } = makeClient(adapter);
    expect(await cold.unlock(DURESS)).toEqual({ status: 'duress_triggered' });
    expect(await adapter.listNamespaces()).toEqual([]);
    expect(stores.localStorage.clear).toHaveBeenCalled();
    expect(stores.cacheDelete).toHaveBeenCalled();
  });

  it('configureDuress validates its input', async () => {
    const { client } = makeClient();
    await client.unlock(PATTERN_A);
    await expectCode(client.configureDuress(PATTERN_A), 'INVALID_ARGUMENT'); // same as active vault
    await expectCode(client.configureDuress([1, 2, 3]), 'INVALID_PATTERN');
    client.lock();
    await client.unlock(PATTERN_B);
    client.lock();
    await client.unlock(PATTERN_A);
    await expectCode(client.configureDuress(PATTERN_B), 'INVALID_ARGUMENT'); // would clobber a real vault
    await client.configureDuress(PATTERN_B, { overwrite: true }); // explicit consent
    client.lock();
    expect(await client.unlock(PATTERN_B)).toEqual({ status: 'duress_triggered' });
  });

  it('removeDuress deletes the trigger and returns the pattern to normal use', async () => {
    const { client, adapter } = makeClient();
    await client.unlock(PATTERN_A);
    await client.configureDuress(DURESS);
    expect(await client.removeDuress(PATTERN_B)).toBe(false); // not a duress vault
    expect(await client.removeDuress(PATTERN_A)).toBe(false); // a real vault is never removed
    expect(await client.removeDuress(DURESS)).toBe(true);
    expect(await adapter.listNamespaces()).toHaveLength(1);
    client.lock();
    const r = await client.unlock(DURESS);
    expect(r.status).toBe('unlocked');
  });

  it('purges a real IndexedDB-backed store (including the database itself)', async () => {
    const dbName = `vaulty-duress-${Math.random().toString(36).slice(2)}`;
    const adapter = new IndexedDBStorageAdapter({ dbName });
    const client = new VaultClient({ adapter, kdfIterations: FAST, duressPattern: DURESS });
    await client.unlock(PATTERN_A);
    await client.putFile(enc.encode('in idb'), { name: 'f' });
    client.lock();
    await client.unlock(PATTERN_B);
    client.lock();
    expect(await adapter.listNamespaces()).toHaveLength(2);
    expect((await indexedDB.databases()).map((d) => d.name)).toContain(dbName);

    expect(await client.unlock(DURESS)).toEqual({ status: 'duress_triggered' });
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(dbName);
    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('purges every OPFS file and directory', async () => {
    const root = new MockDir();
    const adapter = new OPFSStorageAdapter({ getRoot: async () => root });
    const client = new VaultClient({
      adapter,
      kdfIterations: FAST,
      duressPattern: DURESS,
      purgeEnvironment: { getOpfsRoot: async () => root },
    });
    await client.unlock(PATTERN_A);
    await client.putFile(enc.encode('in opfs'), { name: 'f' });
    await root.getFileHandle('unrelated-app-file', { create: true });
    expect(root.paths().length).toBeGreaterThan(3);
    expect(await client.unlock(DURESS)).toEqual({ status: 'duress_triggered' });
    expect(root.paths()).toEqual([]);
  });

  it('still wipes the key and the rest of the stores if one purge step fails', async () => {
    const stores = stubBrowserStores();
    stores.localStorage.clear.mockImplementation(() => {
      throw new Error('storage disabled');
    });
    class FailingPurgeAdapter extends MemoryStorageAdapter {
      override async purgeAll(): Promise<void> {
        throw new Error('adapter purge failed');
      }
    }
    const client = new VaultClient({ adapter: new FailingPurgeAdapter(), kdfIterations: FAST, duressPattern: DURESS });
    await client.unlock(PATTERN_A);
    expect(await client.unlock(DURESS)).toEqual({ status: 'duress_triggered' });
    expect(client.isUnlocked).toBe(false);
    expect(stores.sessionStorage.clear).toHaveBeenCalled();
    expect(stores.cacheDelete).toHaveBeenCalled();
  });
});

describe('hardened namespace ids (T3): folder names cost as much as the key envelope', () => {
  const folder = (pattern: number[], iterations: number) =>
    pbkdf2Sync(`vaulty-ns:v2:${pattern.join(',')}`, 'vaulty-ns-salt:v2', iterations, 32, 'sha256').toString('hex');
  const legacyFolder = (pattern: number[]) => createHash('sha256').update(`vaulty-ns:${pattern.join(',')}`).digest('hex');

  it('names vault folders with PBKDF2 at the configured kdfIterations, never the legacy single SHA-256', async () => {
    const { client, adapter } = makeClient();
    const r = await client.unlock(PATTERN_A);
    if (r.status !== 'unlocked') throw new Error('unreachable');
    expect(r.namespaceId).toBe(folder(PATTERN_A, FAST));
    expect(r.namespaceId).not.toBe(legacyFolder(PATTERN_A));
    expect(await adapter.listNamespaces()).toEqual([folder(PATTERN_A, FAST)]);
  });

  it('applies to decoy, duress and re-keyed vaults as well', async () => {
    const { client, adapter } = makeClient();
    await client.unlock(PATTERN_A);
    await client.configureDuress(DURESS);
    const archive = await client.exportArchive();
    client.lock();
    await client.unlock(PATTERN_B);
    expect((await adapter.listNamespaces()).sort()).toEqual(
      [folder(PATTERN_A, FAST), folder(DURESS, FAST), folder(PATTERN_B, FAST)].sort(),
    );
    const { client: fresh } = makeClient();
    const res = await fresh.importArchive(archive, PATTERN_A, undefined, { newPattern: NEW_PATTERN });
    expect(res.namespaceId).toBe(folder(NEW_PATTERN, FAST));
  });

  it('charges exactly one PBKDF2 namespace derivation (at kdfIterations) per unlock, and none for a runtime duress match', async () => {
    const { client } = makeClient(new MemoryStorageAdapter(), { duressPattern: DURESS });
    const spy = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');
    await client.unlock(PATTERN_A); // create
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![0] as Pbkdf2Params).iterations).toBe(FAST);
    client.lock();
    await client.unlock(PATTERN_A); // open
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    await client.unlock(DURESS); // runtime duress short-circuits before any KDF
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('makes kdfIterations part of the vault address (a different setting does not find the vault)', async () => {
    const adapter = new MemoryStorageAdapter();
    const slow = new VaultClient({ adapter, kdfIterations: 2_000 });
    const a = await slow.unlock(PATTERN_A);
    await slow.putRecord({ k: 1 });
    slow.lock();
    const sameSetting = await new VaultClient({ adapter, kdfIterations: 2_000 }).unlock(PATTERN_A);
    const otherSetting = new VaultClient({ adapter, kdfIterations: FAST });
    const b = await otherSetting.unlock(PATTERN_A);
    if (a.status !== 'unlocked' || b.status !== 'unlocked' || sameSetting.status !== 'unlocked') throw new Error('unreachable');
    expect(sameSetting.created).toBe(false);
    expect(sameSetting.namespaceId).toBe(a.namespaceId);
    expect(b.created).toBe(true);
    expect(b.namespaceId).not.toBe(a.namespaceId);
    expect(otherSetting.listEntries()).toEqual([]);
  });

  it('uses 600,000 iterations for folder names AND envelopes by default', async () => {
    const adapter = new MemoryStorageAdapter();
    const client = new VaultClient({ adapter }); // production defaults
    const spy = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');
    const r = await client.unlock(PATTERN_C);
    if (r.status !== 'unlocked') throw new Error('unreachable');
    expect((spy.mock.calls[0]![0] as Pbkdf2Params).iterations).toBe(600_000);
    spy.mockRestore();
    expect(r.namespaceId).toBe(folder(PATTERN_C, 600_000));
    const header = await readArchiveHeader(await client.exportArchive());
    expect(header.namespaceId).toBe(folder(PATTERN_C, 600_000));
    expect(header.patternEnvelope.kdfIterations).toBe(600_000);
    expect(header.recoveryEnvelope.kdfIterations).toBe(600_000);
  });
});

describe('default storage adapter factory', () => {
  it('accepts an async adapter factory', async () => {
    const adapter = new MemoryStorageAdapter();
    const client = new VaultClient({ adapter: async () => adapter, kdfIterations: FAST });
    await client.unlock(PATTERN_A);
    expect(await adapter.listNamespaces()).toHaveLength(1);
  });

  it('falls back automatically when none is supplied (IndexedDB via fake-indexeddb in Node)', async () => {
    const client = new VaultClient({ kdfIterations: FAST });
    const r = await client.unlock(PATTERN_C);
    expect(r.status).toBe('unlocked');
    await client.putRecord({ ok: true });
    expect(client.listEntries()).toHaveLength(1);
    client.dispose();
    const adapterCleanup = new IndexedDBStorageAdapter();
    await adapterCleanup.purgeAll();
  });
});
