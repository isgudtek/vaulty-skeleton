/**
 * Domain contracts for @vaulty/core. Pure types — no runtime code except error classes.
 */

/** A node on the 5×5 pattern grid, numbered row-major: 0 (top-left) … 24 (bottom-right). */
export type PatternNode =
  | 0 | 1 | 2 | 3 | 4
  | 5 | 6 | 7 | 8 | 9
  | 10 | 11 | 12 | 13 | 14
  | 15 | 16 | 17 | 18 | 19
  | 20 | 21 | 22 | 23 | 24;

/** Plaintext metadata of one stored item. Only ever persisted inside the encrypted index. */
export interface VaultMetadataEntry {
  /** UUID; also the (opaque) name of the encrypted blob in storage. */
  id: string;
  name: string;
  mimeType: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  tags: string[];
}

/** A structured JSON document stored in the vault (for apps such as journals/notes/contacts). */
export interface VaultRecord<T> {
  id: string;
  name: string;
  data: T;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/**
 * A 32-byte Master Vault Key wrapped (AES-256-GCM) by a key-encryption key that is
 * derived with PBKDF2-HMAC-SHA256 from a secret (pattern or recovery phrase).
 */
export interface WrappedKeyEnvelope {
  /** 16 random bytes fed to PBKDF2. */
  salt: Uint8Array;
  /** 12 random bytes, unique per wrap operation. */
  iv: Uint8Array;
  /** AES-GCM(KEK, MVK): 32 ciphertext bytes + 16 byte tag = 48 bytes. */
  wrappedKeyBytes: Uint8Array;
  /** PBKDF2 iteration count used to derive the KEK. */
  kdfIterations: number;
}

/** Parsed fixed header of a `.vault` archive. Everything here is non-secret. */
export interface VaultArchiveHeader {
  magic: 'VLT1';
  version: number;
  /** Hex SHA-256 namespace id of the vault at export time. */
  namespaceId: string;
  patternEnvelope: WrappedKeyEnvelope;
  recoveryEnvelope: WrappedKeyEnvelope;
  /** Byte length of the encrypted index (`index.enc`). */
  indexLength: number;
  /** Number of encrypted blobs that follow the index. */
  blobCount: number;
}

export type ProgressCallback = (stage: string, percent: number) => void;

/**
 * Minimal namespaced blob store. Every method deals exclusively in ciphertext
 * (or public envelopes); adapters never see keys or plaintext.
 * Namespace and object names must match `/^[A-Za-z0-9._-]{1,128}$/` (and not be `.`/`..`).
 */
export interface StorageAdapter {
  readonly kind: 'opfs' | 'indexeddb' | 'memory' | (string & {});
  put(namespace: string, name: string, data: Uint8Array): Promise<void>;
  get(namespace: string, name: string): Promise<Uint8Array | null>;
  delete(namespace: string, name: string): Promise<void>;
  list(namespace: string): Promise<string[]>;
  hasNamespace(namespace: string): Promise<boolean>;
  listNamespaces(): Promise<string[]>;
  deleteNamespace(namespace: string): Promise<void>;
  /** Destroy EVERYTHING this adapter owns (used by the duress engine). */
  purgeAll(): Promise<void>;
}

export type VaultErrorCode =
  | 'INVALID_PATTERN'
  | 'INVALID_RECOVERY_PHRASE'
  | 'CRYPTO_FAILURE'
  | 'VAULT_LOCKED'
  | 'NOT_FOUND'
  | 'ARCHIVE_INVALID'
  | 'STORAGE_ERROR'
  | 'INVALID_ARGUMENT';

/** Base class for all errors thrown by @vaulty/core. Messages never contain secrets. */
export class VaultyError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VaultyError';
    this.code = code;
  }
}
