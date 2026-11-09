import {
  ByteReader,
  ByteWriter,
  UUID_RE,
  bytesToHex,
  bytesToUuid,
  concatBytes,
  equalBytes,
  fromUtf8,
  hexToBytes,
  isArrayBuffer,
  isBlob,
  isUint8Array,
  utf8,
  uuidToBytes,
} from './bytes';
import {
  DEFAULT_KDF_ITERATIONS,
  createPatternEnvelope,
  createRecoveryEnvelope,
  decryptBytes,
  deriveNamespaceId,
  encryptBytes,
  generateMvk,
  normalizePattern,
  parseEnvelope,
  randomUUID,
  readEnvelope,
  serializeEnvelope,
  serializePattern,
  sha256,
  tryNormalizeRecoveryPhrase,
  unwrapWithPattern,
  unwrapWithRecoveryPhrase,
} from './crypto';
import { type LockReason, SecureBuffer, SessionGuard, type SessionGuardOptions } from './memory';
import {
  IndexedDBStorageAdapter,
  type PurgeEnvironmentOptions,
  createBestStorageAdapter,
  purgeEnvironment,
} from './storage';
import {
  type PatternNode,
  type ProgressCallback,
  type StorageAdapter,
  type VaultArchiveHeader,
  type VaultMetadataEntry,
  type VaultRecord,
  type WrappedKeyEnvelope,
  VaultyError,
} from './types';

/* ------------------------------------------------------------------------------------------ */
/* Constants & on-disk layouts                                                                */
/* ------------------------------------------------------------------------------------------ */

/** Constant object names inside every vault namespace (identical for real, decoy and duress vaults). */
export const KEYS_FILE = 'keys.bin';
export const INDEX_FILE = 'index.enc';
export const RECORD_MIME = 'application/vnd.vaulty.record+json';
export const ARCHIVE_MAGIC = 'VLT1';
export const ARCHIVE_VERSION = 1;
const KEYS_VERSION = 1;
const CHECKSUM_BYTES = 32;

const indexAad = (ns: string): string => `vaulty-index:v1:${ns}`;
const blobAad = (ns: string, id: string): string => `vaulty-blob:v1:${ns}:${id}`;

interface IndexFlags {
  /** Present (and true) only inside the encrypted index of a duress vault. */
  duress?: boolean;
}

interface IndexData {
  v: 1;
  createdAt: number;
  entries: Record<string, VaultMetadataEntry>;
  flags: IndexFlags;
}

interface Session {
  namespaceId: string;
  mvk: SecureBuffer;
  index: IndexData;
  patternEnvelope: WrappedKeyEnvelope;
  recoveryEnvelope: WrappedKeyEnvelope;
}

/* ------------------------------------------------------------------------------------------ */
/* Public types                                                                               */
/* ------------------------------------------------------------------------------------------ */

export type UnlockResult =
  | {
      status: 'unlocked';
      namespaceId: string;
      /** True when no vault existed for this pattern and an empty one was silently created. */
      created: boolean;
      /** Only present when `created` is true. Display ONCE; it is never stored anywhere. */
      recoveryPhrase?: string;
    }
  | { status: 'duress_triggered' };

export interface ImportResult {
  status: 'imported';
  namespaceId: string;
  entryCount: number;
}

export interface VaultState {
  unlocked: boolean;
  namespaceId: string | null;
  lastLockReason: LockReason | null;
}

export interface VaultClientOptions {
  /** Storage backend, or a factory for it. Defaults to {@link createBestStorageAdapter}. */
  adapter?: StorageAdapter | (() => Promise<StorageAdapter>);
  /** PBKDF2 iterations. Defaults to 600 000; lower ONLY in unit tests. */
  kdfIterations?: number;
  /** Runtime-configured duress pattern (kept in memory only, never persisted). */
  duressPattern?: readonly number[];
  /** Auto-lock after this many ms of inactivity. 0 / undefined disables. */
  idleTimeoutMs?: number;
  /** Lock when the tab is hidden. Default true. */
  lockOnHidden?: boolean;
  /** Lock on `pagehide`. Default true. */
  lockOnPageHide?: boolean;
  /** Passed to the underlying SessionGuard (test/SSR injection, activity tracking). */
  guard?: Pick<SessionGuardOptions, 'documentRef' | 'windowRef' | 'trackActivity'>;
  /** Extra options for the duress environment purge. Pass `false` to skip the global purge. */
  purgeEnvironment?: false | PurgeEnvironmentOptions;
  /** Invoked every time the vault locks, for any reason. */
  onLock?: (reason: LockReason) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface PutFileMeta {
  name: string;
  mimeType?: string;
  tags?: string[];
  /** Supply an existing id to overwrite that item; must be a lowercase UUID. */
  id?: string;
}

export interface PutRecordMeta {
  name?: string;
  tags?: string[];
  id?: string;
}

export interface ListFilter {
  tag?: string;
  mimeType?: string;
  nameContains?: string;
}

export interface ImportOptions {
  /**
   * Re-key the imported vault under a NEW pattern (new namespace). Essential after recovering
   * with the 9-word phrase because the original pattern has been forgotten.
   */
  newPattern?: readonly number[];
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const cloneEntry = (e: VaultMetadataEntry): VaultMetadataEntry => ({ ...e, tags: [...e.tags] });

function emptyIndex(now: number, flags: IndexFlags = {}): IndexData {
  return { v: 1, createdAt: now, entries: {}, flags };
}

function parseIndex(plain: Uint8Array): IndexData {
  let raw: unknown;
  try {
    raw = JSON.parse(fromUtf8(plain));
  } catch (cause) {
    throw new VaultyError('CRYPTO_FAILURE', 'Index is corrupt', { cause });
  }
  const bad = (): never => {
    throw new VaultyError('CRYPTO_FAILURE', 'Index is corrupt');
  };
  if (typeof raw !== 'object' || raw === null) return bad();
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.createdAt !== 'number') return bad();
  if (typeof r.entries !== 'object' || r.entries === null || Array.isArray(r.entries)) return bad();
  const entries: Record<string, VaultMetadataEntry> = {};
  for (const [id, value] of Object.entries(r.entries as Record<string, unknown>)) {
    const e = value as Partial<VaultMetadataEntry> | null;
    if (
      !UUID_RE.test(id) ||
      typeof e !== 'object' ||
      e === null ||
      e.id !== id ||
      typeof e.name !== 'string' ||
      typeof e.mimeType !== 'string' ||
      typeof e.size !== 'number' ||
      !Number.isInteger(e.size) ||
      e.size < 0 ||
      typeof e.createdAt !== 'number' ||
      typeof e.updatedAt !== 'number' ||
      !Array.isArray(e.tags) ||
      !e.tags.every((t) => typeof t === 'string')
    ) {
      return bad();
    }
    entries[id] = cloneEntry(e as VaultMetadataEntry);
  }
  const flagsRaw = (typeof r.flags === 'object' && r.flags !== null ? r.flags : {}) as Record<string, unknown>;
  const flags: IndexFlags = flagsRaw.duress === true ? { duress: true } : {};
  return { v: 1, createdAt: r.createdAt, entries, flags };
}

async function toBytes(bundle: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (isUint8Array(bundle)) return bundle;
  if (isArrayBuffer(bundle)) return new Uint8Array(bundle);
  if (isBlob(bundle)) return new Uint8Array(await bundle.arrayBuffer());
  throw new VaultyError('INVALID_ARGUMENT', 'Archive must be a Uint8Array, ArrayBuffer or Blob');
}

function isCryptoish(e: unknown): boolean {
  return e instanceof VaultyError && (e.code === 'CRYPTO_FAILURE' || e.code === 'ARCHIVE_INVALID');
}

/* ------------------------------------------------------------------------------------------ */
/* keys.bin layout                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** `version(1) ‖ patternEnvelope(82) ‖ recoveryEnvelope(82)` */
function serializeKeys(pattern: WrappedKeyEnvelope, recovery: WrappedKeyEnvelope): Uint8Array {
  return concatBytes(Uint8Array.of(KEYS_VERSION), serializeEnvelope(pattern), serializeEnvelope(recovery));
}

function parseKeys(bytes: Uint8Array): { pattern: WrappedKeyEnvelope; recovery: WrappedKeyEnvelope } {
  const r = new ByteReader(bytes);
  if (r.u8() !== KEYS_VERSION) throw new VaultyError('CRYPTO_FAILURE', 'Unsupported key file version');
  const pattern = readEnvelope(r);
  const recovery = readEnvelope(r);
  if (r.remaining !== 0) throw new VaultyError('CRYPTO_FAILURE', 'Trailing bytes in key file');
  return { pattern, recovery };
}

/* ------------------------------------------------------------------------------------------ */
/* .vault archive codec                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * Binary layout (big-endian):
 *   "VLT1"(4) ‖ version(u8) ‖ flags(u8, =0) ‖ namespaceId(32 raw)
 *   ‖ u16 len ‖ patternEnvelope ‖ u16 len ‖ recoveryEnvelope
 *   ‖ u32 indexLength ‖ index.enc (IV‖ct‖tag)
 *   ‖ u32 blobCount ‖ { uuid(16) ‖ u32 len ‖ blob (IV‖ct‖tag) } × blobCount
 *   ‖ SHA-256 of every preceding byte (32)
 */
interface ParsedArchive {
  header: VaultArchiveHeader;
  indexBytes: Uint8Array;
  blobs: Map<string, Uint8Array>;
}

function writeArchive(
  namespaceId: string,
  patternEnvelope: WrappedKeyEnvelope,
  recoveryEnvelope: WrappedKeyEnvelope,
  indexBytes: Uint8Array,
  blobs: Array<{ id: string; data: Uint8Array }>,
): Uint8Array {
  const pe = serializeEnvelope(patternEnvelope);
  const re = serializeEnvelope(recoveryEnvelope);
  const w = new ByteWriter()
    .bytes(utf8(ARCHIVE_MAGIC))
    .u8(ARCHIVE_VERSION)
    .u8(0)
    .bytes(hexToBytes(namespaceId))
    .u16(pe.length)
    .bytes(pe)
    .u16(re.length)
    .bytes(re)
    .u32(indexBytes.length)
    .bytes(indexBytes)
    .u32(blobs.length);
  for (const b of blobs) w.bytes(uuidToBytes(b.id)).u32(b.data.length).bytes(b.data);
  return w.finish();
}

async function parseArchive(bytes: Uint8Array): Promise<ParsedArchive> {
  const bad = (msg: string): never => {
    throw new VaultyError('ARCHIVE_INVALID', msg);
  };
  if (bytes.length < 4 + CHECKSUM_BYTES) return bad('File is too small to be a .vault archive');
  if (fromUtf8(bytes.subarray(0, 4)) !== ARCHIVE_MAGIC) return bad('Not a Vaulty archive (bad magic)');
  const body = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  const checksum = bytes.subarray(bytes.length - CHECKSUM_BYTES);
  if (!equalBytes(await sha256(body), checksum)) return bad('Archive checksum mismatch (corrupt or truncated)');

  const r = new ByteReader(body);
  r.bytes(4);
  const version = r.u8();
  if (version !== ARCHIVE_VERSION) return bad(`Unsupported archive version ${version}`);
  if (r.u8() !== 0) return bad('Unsupported archive flags');
  const namespaceId = bytesToHex(r.bytes(32));
  const pLen = r.u16();
  const patternEnvelope = parseEnvelope(r.bytes(pLen));
  const rLen = r.u16();
  const recoveryEnvelope = parseEnvelope(r.bytes(rLen));
  const indexLength = r.u32();
  const indexBytes = r.bytes(indexLength);
  const blobCount = r.u32();
  if (blobCount * 20 > r.remaining) return bad('Blob count exceeds archive size');
  const blobs = new Map<string, Uint8Array>();
  for (let i = 0; i < blobCount; i++) {
    const id = bytesToUuid(r.bytes(16));
    const len = r.u32();
    if (blobs.has(id)) return bad('Duplicate blob id');
    blobs.set(id, r.bytes(len));
  }
  if (r.remaining !== 0) return bad('Trailing bytes in archive');
  return {
    header: {
      magic: ARCHIVE_MAGIC,
      version,
      namespaceId,
      patternEnvelope,
      recoveryEnvelope,
      indexLength,
      blobCount,
    },
    indexBytes,
    blobs,
  };
}

/** Parse only the non-secret header of a `.vault` file (e.g. to show format/version in a UI). */
export async function readArchiveHeader(bundle: Uint8Array | ArrayBuffer | Blob): Promise<VaultArchiveHeader> {
  return (await parseArchive(await toBytes(bundle))).header;
}

/* ------------------------------------------------------------------------------------------ */
/* VaultClient                                                                                */
/* ------------------------------------------------------------------------------------------ */

export class VaultClient {
  readonly #options: VaultClientOptions;
  readonly #iterations: number;
  readonly #now: () => number;
  readonly #duress: string | null;
  readonly #guard: SessionGuard;
  readonly #listeners = new Set<(state: VaultState) => void>();
  #adapterPromise: Promise<StorageAdapter> | null = null;
  #session: Session | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #lastLockReason: LockReason | null = null;

  constructor(options: VaultClientOptions = {}) {
    this.#options = options;
    this.#iterations = options.kdfIterations ?? DEFAULT_KDF_ITERATIONS;
    this.#now = options.now ?? Date.now;
    this.#duress = options.duressPattern ? serializePattern(normalizePattern(options.duressPattern)) : null;
    const guardOptions: SessionGuardOptions = {
      ...options.guard,
      onLock: (reason) => {
        if (this.#clearSession()) {
          this.#lastLockReason = reason;
          this.#emit();
        }
        options.onLock?.(reason);
      },
    };
    if (options.idleTimeoutMs !== undefined) guardOptions.idleTimeoutMs = options.idleTimeoutMs;
    if (options.lockOnHidden !== undefined) guardOptions.lockOnHidden = options.lockOnHidden;
    if (options.lockOnPageHide !== undefined) guardOptions.lockOnPageHide = options.lockOnPageHide;
    this.#guard = new SessionGuard(guardOptions);
  }

  /* ------------------------------ state ------------------------------ */

  get isUnlocked(): boolean {
    return this.#session !== null;
  }

  get namespaceId(): string | null {
    return this.#session?.namespaceId ?? null;
  }

  get state(): VaultState {
    return {
      unlocked: this.#session !== null,
      namespaceId: this.#session?.namespaceId ?? null,
      lastLockReason: this.#lastLockReason,
    };
  }

  /** Subscribe to lock/unlock transitions. Returns an unsubscribe function. */
  subscribe(listener: (state: VaultState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Reset the idle timer (call on user interaction not covered by the built-in activity tracking). */
  touch(): void {
    this.#guard.touch();
  }

  /** Immediately wipe the Master Vault Key and drop all decrypted metadata. */
  lock(): void {
    this.#guard.lock('manual');
  }

  /** Lock and detach all global listeners/timers. Safe to call repeatedly. */
  dispose(): void {
    this.lock();
    this.#guard.stop();
    this.#listeners.clear();
  }

  /* ------------------------------ unlock ----------------------------- */

  /**
   * Plausible-deniability unlock. The pattern alone selects the vault namespace
   * (domain-separated PBKDF2-HMAC-SHA256 with the configured `kdfIterations`, see
   * {@link deriveNamespaceId}). An existing namespace is opened; a missing or
   * undecryptable one is silently replaced by a fresh empty vault — there is no
   * "wrong pattern" outcome. The configured duress pattern wipes everything instead.
   */
  async unlock(patternInput: readonly number[]): Promise<UnlockResult> {
    const pattern = normalizePattern(patternInput);
    // Runtime duress check happens BEFORE any I/O or KDF work.
    if (this.#duress !== null && serializePattern(pattern) === this.#duress) {
      return this.#triggerDuress();
    }
    return this.#exclusive(async () => {
      const adapter = await this.#adapter();
      const ns = await this.#namespaceOf(pattern);
      this.#clearSession();
      this.#guard.stop();

      const opened = await this.#tryOpen(adapter, ns, pattern);
      if (opened) {
        if (opened.index.flags.duress) {
          opened.mvk.wipe();
          return this.#triggerDuress();
        }
        this.#activate(opened);
        return { status: 'unlocked', namespaceId: ns, created: false } as const;
      }

      const { session, recoveryPhrase } = await this.#createVault(adapter, ns, pattern, {});
      this.#activate(session);
      return { status: 'unlocked', namespaceId: ns, created: true, recoveryPhrase } as const;
    });
  }

  /**
   * Register an encrypted duress trigger while unlocked. A decoy-looking vault is created under
   * the duress pattern's namespace whose *encrypted* index carries the duress flag; no plaintext
   * marker exists anywhere. Entering this pattern on `unlock()` purges all stores.
   */
  async configureDuress(patternInput: readonly number[], options: { overwrite?: boolean } = {}): Promise<void> {
    const pattern = normalizePattern(patternInput);
    return this.#exclusive(async () => {
      const s = this.#requireSession();
      const adapter = await this.#adapter();
      const ns = await this.#namespaceOf(pattern);
      if (ns === s.namespaceId) {
        throw new VaultyError('INVALID_ARGUMENT', 'Duress pattern must differ from the active vault pattern');
      }
      if (!options.overwrite && (await adapter.hasNamespace(ns))) {
        throw new VaultyError('INVALID_ARGUMENT', 'That pattern is already in use; choose another or pass overwrite');
      }
      const { session } = await this.#createVault(adapter, ns, pattern, { duress: true });
      session.mvk.wipe();
      this.#guard.touch();
    });
  }

  /** Remove a previously configured duress trigger. Returns false if `pattern` is not a duress vault. */
  async removeDuress(patternInput: readonly number[]): Promise<boolean> {
    const pattern = normalizePattern(patternInput);
    return this.#exclusive(async () => {
      this.#requireSession();
      const adapter = await this.#adapter();
      const ns = await this.#namespaceOf(pattern);
      const opened = await this.#tryOpen(adapter, ns, pattern);
      if (!opened) return false;
      opened.mvk.wipe();
      if (!opened.index.flags.duress) return false;
      await adapter.deleteNamespace(ns);
      return true;
    });
  }

  /* ------------------------------ items ------------------------------ */

  async putFile(data: Uint8Array, meta: PutFileMeta): Promise<VaultMetadataEntry> {
    if (!isUint8Array(data)) throw new VaultyError('INVALID_ARGUMENT', 'File data must be a Uint8Array');
    return this.#putBlob(data, meta.name, meta.mimeType ?? 'application/octet-stream', meta.tags, meta.id);
  }

  async getFile(id: string): Promise<{ entry: VaultMetadataEntry; data: Uint8Array }> {
    const s = this.#requireSession();
    const entry = s.index.entries[id];
    if (!entry) throw new VaultyError('NOT_FOUND', 'No such item');
    const adapter = await this.#adapter();
    const blob = await adapter.get(s.namespaceId, id);
    if (!blob) throw new VaultyError('NOT_FOUND', 'Encrypted blob is missing from storage');
    const data = await decryptBytes(s.mvk, blob, blobAad(s.namespaceId, id));
    this.#guard.touch();
    return { entry: cloneEntry(entry), data };
  }

  async deleteFile(id: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const s = this.#requireSession();
      if (!s.index.entries[id]) return false;
      const entries = { ...s.index.entries };
      delete entries[id];
      await this.#persistIndex(s, { ...s.index, entries });
      await (await this.#adapter()).delete(s.namespaceId, id);
      this.#guard.touch();
      return true;
    });
  }

  async putRecord<T>(data: T, meta: PutRecordMeta = {}): Promise<VaultRecord<T>> {
    const json = JSON.stringify(data);
    if (typeof json !== 'string') throw new VaultyError('INVALID_ARGUMENT', 'Record data must be JSON-serialisable');
    const bytes = utf8(json);
    try {
      const entry = await this.#putBlob(bytes, meta.name ?? 'record', RECORD_MIME, meta.tags, meta.id);
      return this.#toRecord<T>(entry, data);
    } finally {
      bytes.fill(0);
    }
  }

  async getRecord<T>(id: string): Promise<VaultRecord<T>> {
    const { entry, data } = await this.getFile(id);
    if (entry.mimeType !== RECORD_MIME) {
      data.fill(0);
      throw new VaultyError('INVALID_ARGUMENT', 'Item is not a structured record');
    }
    try {
      return this.#toRecord<T>(entry, JSON.parse(fromUtf8(data)) as T);
    } finally {
      data.fill(0);
    }
  }

  listEntries(filter: ListFilter = {}): VaultMetadataEntry[] {
    const s = this.#requireSession();
    const needle = filter.nameContains?.toLowerCase();
    return Object.values(s.index.entries)
      .filter(
        (e) =>
          (filter.tag === undefined || e.tags.includes(filter.tag)) &&
          (filter.mimeType === undefined || e.mimeType === filter.mimeType) &&
          (needle === undefined || e.name.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
      .map(cloneEntry);
  }

  /* ------------------------------ archive ---------------------------- */

  /** Produce a self-contained `.vault` file (still fully encrypted) for backup / cloud upload. */
  async exportArchive(onProgress?: ProgressCallback): Promise<Uint8Array> {
    return this.#exclusive(async () => {
      const s = this.#requireSession();
      const adapter = await this.#adapter();
      onProgress?.('preparing', 0);
      const indexBytes = await adapter.get(s.namespaceId, INDEX_FILE);
      if (!indexBytes) throw new VaultyError('STORAGE_ERROR', 'Vault index is missing from storage');
      const ids = Object.keys(s.index.entries);
      const blobs: Array<{ id: string; data: Uint8Array }> = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i] as string;
        const data = await adapter.get(s.namespaceId, id);
        if (!data) throw new VaultyError('STORAGE_ERROR', 'An encrypted blob is missing from storage');
        blobs.push({ id, data });
        onProgress?.('exporting', Math.round(5 + (90 * (i + 1)) / ids.length));
      }
      const body = writeArchive(s.namespaceId, s.patternEnvelope, s.recoveryEnvelope, indexBytes, blobs);
      const out = concatBytes(body, await sha256(body));
      onProgress?.('done', 100);
      this.#guard.touch();
      return out;
    });
  }

  /**
   * Restore a `.vault` file using either the vault's pattern (array of nodes) or its 9-word
   * recovery phrase (string). On success the client is left UNLOCKED on the restored vault.
   */
  async importArchive(
    bundle: Uint8Array | ArrayBuffer | Blob,
    patternOrPhrase: readonly number[] | string,
    onProgress?: ProgressCallback,
    options: ImportOptions = {},
  ): Promise<ImportResult> {
    const bytes = await toBytes(bundle);
    return this.#exclusive(async () => {
      onProgress?.('parsing', 0);
      const { header, indexBytes, blobs } = await parseArchive(bytes);

      let mvk: SecureBuffer;
      try {
        if (typeof patternOrPhrase === 'string') {
          if (tryNormalizeRecoveryPhrase(patternOrPhrase) === null) {
            throw new VaultyError('INVALID_RECOVERY_PHRASE', 'Recovery phrase must be exactly 9 valid words');
          }
          mvk = await unwrapWithRecoveryPhrase(header.recoveryEnvelope, patternOrPhrase);
        } else {
          mvk = await unwrapWithPattern(header.patternEnvelope, normalizePattern(patternOrPhrase));
        }
      } catch (e) {
        if (e instanceof VaultyError && e.code === 'CRYPTO_FAILURE') {
          throw new VaultyError('CRYPTO_FAILURE', 'Unable to open archive with the supplied pattern or recovery phrase');
        }
        throw e;
      }

      try {
        onProgress?.('decrypting-index', 10);
        const plainIndex = await decryptBytes(mvk, indexBytes, indexAad(header.namespaceId));
        const index = parseIndex(plainIndex);
        plainIndex.fill(0);
        if (index.flags.duress) throw new VaultyError('ARCHIVE_INVALID', 'Archive contains a duress marker');
        const ids = Object.keys(index.entries);
        for (const id of ids) {
          if (!blobs.has(id)) throw new VaultyError('ARCHIVE_INVALID', 'Archive is missing an encrypted blob');
        }

        const newPattern = options.newPattern ? normalizePattern(options.newPattern) : null;
        const targetNs = newPattern ? await this.#namespaceOf(newPattern) : header.namespaceId;
        const rekey = targetNs !== header.namespaceId;

        // Phase 1 (no storage writes): authenticate EVERY blob, re-encrypting under the new
        // namespace AAD when re-keying. A tampered archive therefore never touches storage.
        const prepared: Array<{ id: string; data: Uint8Array }> = [];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i] as string;
          const original = blobs.get(id) as Uint8Array;
          const plain = await decryptBytes(mvk, original, blobAad(header.namespaceId, id));
          const data = rekey ? await encryptBytes(mvk, plain, blobAad(targetNs, id)) : original;
          plain.fill(0);
          prepared.push({ id, data });
          onProgress?.('verifying', Math.round(15 + (45 * (i + 1)) / Math.max(ids.length, 1)));
        }
        let finalIndex = indexBytes;
        if (rekey) {
          const plain = utf8(JSON.stringify(index));
          finalIndex = await encryptBytes(mvk, plain, indexAad(targetNs));
          plain.fill(0);
        }
        const patternEnvelope = newPattern
          ? await createPatternEnvelope(mvk, newPattern, { kdfIterations: this.#iterations })
          : header.patternEnvelope;

        // Phase 2: commit. keys.bin is written last so a half-written vault is never "complete".
        const adapter = await this.#adapter();
        this.#clearSession();
        this.#guard.stop();
        await adapter.deleteNamespace(targetNs);
        for (let i = 0; i < prepared.length; i++) {
          const p = prepared[i] as { id: string; data: Uint8Array };
          await adapter.put(targetNs, p.id, p.data);
          onProgress?.('importing', Math.round(60 + (35 * (i + 1)) / Math.max(prepared.length, 1)));
        }
        await adapter.put(targetNs, INDEX_FILE, finalIndex);
        await adapter.put(targetNs, KEYS_FILE, serializeKeys(patternEnvelope, header.recoveryEnvelope));

        this.#activate({
          namespaceId: targetNs,
          mvk,
          index,
          patternEnvelope,
          recoveryEnvelope: header.recoveryEnvelope,
        });
        onProgress?.('done', 100);
        return { status: 'imported', namespaceId: targetNs, entryCount: ids.length } as const;
      } catch (e) {
        if (!this.#session || this.#session.mvk !== mvk) mvk.wipe();
        if (e instanceof VaultyError && e.code === 'CRYPTO_FAILURE') {
          throw new VaultyError('ARCHIVE_INVALID', 'Archive contents failed authentication', { cause: e });
        }
        throw e;
      }
    });
  }

  /* ------------------------------ internals -------------------------- */

  /** Folder name for `pattern`: PBKDF2 cost matches the key envelopes (same `kdfIterations`). */
  #namespaceOf(pattern: readonly PatternNode[]): Promise<string> {
    return deriveNamespaceId(pattern, { kdfIterations: this.#iterations });
  }

  #adapter(): Promise<StorageAdapter> {
    if (!this.#adapterPromise) {
      const a = this.#options.adapter;
      this.#adapterPromise =
        typeof a === 'function' ? a() : a ? Promise.resolve(a) : createBestStorageAdapter();
      this.#adapterPromise.catch(() => {
        this.#adapterPromise = null;
      });
    }
    return this.#adapterPromise;
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #requireSession(): Session {
    if (!this.#session) throw new VaultyError('VAULT_LOCKED', 'Vault is locked');
    return this.#session;
  }

  #emit(): void {
    const state = this.state;
    for (const l of [...this.#listeners]) l(state);
  }

  #activate(session: Session): void {
    this.#session = session;
    this.#lastLockReason = null;
    this.#guard.register(session.mvk);
    this.#guard.start();
    this.#emit();
  }

  /** Wipe key + drop decrypted metadata. Returns true if a session existed. */
  #clearSession(): boolean {
    const s = this.#session;
    if (!s) return false;
    this.#session = null;
    s.mvk.wipe();
    this.#guard.unregister(s.mvk);
    s.index = emptyIndex(0);
    return true;
  }

  async #triggerDuress(): Promise<UnlockResult> {
    // 1. Volatile memory first, synchronously, before any await.
    const had = this.#clearSession();
    this.#guard.stop();
    if (had) {
      this.#lastLockReason = 'manual';
      this.#emit();
    }
    // 2. Then destroy every persistent store, failing open per step.
    const tasks: Array<Promise<unknown>> = [];
    let idbNames: string[] = [];
    try {
      const adapter = await this.#adapter();
      if (adapter instanceof IndexedDBStorageAdapter) idbNames = [adapter.dbName];
      tasks.push(adapter.purgeAll());
    } catch {
      /* adapter unavailable: still purge the environment */
    }
    if (this.#options.purgeEnvironment !== false) {
      tasks.push(purgeEnvironment({ indexedDbNames: idbNames, ...this.#options.purgeEnvironment }));
    }
    await Promise.allSettled(tasks);
    return { status: 'duress_triggered' };
  }

  /** Returns an open Session, or null when the namespace is absent / not decryptable with `pattern`. */
  async #tryOpen(adapter: StorageAdapter, ns: string, pattern: readonly PatternNode[]): Promise<Session | null> {
    const keyBytes = await adapter.get(ns, KEYS_FILE);
    if (!keyBytes) return null;
    let mvk: SecureBuffer | null = null;
    try {
      const keys = parseKeys(keyBytes);
      mvk = await unwrapWithPattern(keys.pattern, pattern);
      const indexBytes = await adapter.get(ns, INDEX_FILE);
      if (!indexBytes) throw new VaultyError('CRYPTO_FAILURE', 'Index missing');
      const plain = await decryptBytes(mvk, indexBytes, indexAad(ns));
      const index = parseIndex(plain);
      plain.fill(0);
      return {
        namespaceId: ns,
        mvk,
        index,
        patternEnvelope: keys.pattern,
        recoveryEnvelope: keys.recovery,
      };
    } catch (e) {
      mvk?.wipe();
      if (isCryptoish(e)) return null;
      throw e;
    }
  }

  async #createVault(
    adapter: StorageAdapter,
    ns: string,
    pattern: readonly PatternNode[],
    flags: IndexFlags,
  ): Promise<{ session: Session; recoveryPhrase: string }> {
    // Remove any orphaned/corrupt leftovers so the new vault starts clean.
    await adapter.deleteNamespace(ns);
    const mvk = generateMvk();
    try {
      const patternEnvelope = await createPatternEnvelope(mvk, pattern, { kdfIterations: this.#iterations });
      const recovery = await createRecoveryEnvelope(mvk, { kdfIterations: this.#iterations });
      const index = emptyIndex(this.#now(), flags);
      const session: Session = {
        namespaceId: ns,
        mvk,
        index,
        patternEnvelope,
        recoveryEnvelope: recovery.envelope,
      };
      await this.#persistIndex(session, index);
      // keys.bin is written LAST: its presence marks a complete vault.
      await adapter.put(ns, KEYS_FILE, serializeKeys(patternEnvelope, recovery.envelope));
      return { session, recoveryPhrase: recovery.phrase };
    } catch (e) {
      mvk.wipe();
      throw e;
    }
  }

  async #persistIndex(s: Session, next: IndexData): Promise<void> {
    const plain = utf8(JSON.stringify(next));
    try {
      const cipher = await encryptBytes(s.mvk, plain, indexAad(s.namespaceId));
      await (await this.#adapter()).put(s.namespaceId, INDEX_FILE, cipher);
      s.index = next;
    } finally {
      plain.fill(0);
    }
  }

  async #putBlob(
    data: Uint8Array,
    name: string,
    mimeType: string,
    tags: string[] | undefined,
    requestedId: string | undefined,
  ): Promise<VaultMetadataEntry> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new VaultyError('INVALID_ARGUMENT', 'Item name must be a non-empty string');
    }
    if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) {
      throw new VaultyError('INVALID_ARGUMENT', 'Tags must be an array of strings');
    }
    if (requestedId !== undefined && !UUID_RE.test(requestedId)) {
      throw new VaultyError('INVALID_ARGUMENT', 'Item id must be a lowercase UUID');
    }
    return this.#exclusive(async () => {
      const s = this.#requireSession();
      const adapter = await this.#adapter();
      const id = requestedId ?? randomUUID();
      const existing = s.index.entries[id];
      const now = this.#now();
      const cipher = await encryptBytes(s.mvk, data, blobAad(s.namespaceId, id));
      await adapter.put(s.namespaceId, id, cipher);
      const entry: VaultMetadataEntry = {
        id,
        name,
        mimeType,
        size: data.length,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        tags: [...(tags ?? [])],
      };
      await this.#persistIndex(s, { ...s.index, entries: { ...s.index.entries, [id]: entry } });
      this.#guard.touch();
      return cloneEntry(entry);
    });
  }

  #toRecord<T>(entry: VaultMetadataEntry, data: T): VaultRecord<T> {
    return {
      id: entry.id,
      name: entry.name,
      data,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      tags: [...entry.tags],
    };
  }
}
