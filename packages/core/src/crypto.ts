import { ByteReader, ByteWriter, bytesToHex, concatBytes, utf8 } from './bytes';
import { SecureBuffer } from './memory';
import { type PatternNode, type WrappedKeyEnvelope, VaultyError } from './types';
import { WORDLIST } from './wordlist';

/** Production PBKDF2-HMAC-SHA256 iteration count (OWASP 2023+ guidance). */
export const DEFAULT_KDF_ITERATIONS = 600_000;
/** Hard ceiling when parsing untrusted envelopes (prevents CPU-exhaustion via crafted archives). */
export const MAX_KDF_ITERATIONS = 10_000_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const MVK_BYTES = 32;
export const GCM_TAG_BYTES = 16;
export const WRAPPED_KEY_BYTES = MVK_BYTES + GCM_TAG_BYTES;
export const RECOVERY_WORD_COUNT = 9;
export const MIN_PATTERN_NODES = 6;
export const PATTERN_GRID_NODES = 25;
/** Serialized envelope size: salt(16) + iv(12) + iterations(4) + wrappedLen(2) + wrapped(48). */
export const ENVELOPE_BYTES = SALT_BYTES + IV_BYTES + 4 + 2 + WRAPPED_KEY_BYTES;

export type EnvelopeRole = 'pattern' | 'recovery';

export interface KdfOptions {
  /** PBKDF2 iterations. Defaults to {@link DEFAULT_KDF_ITERATIONS}. Lower ONLY in unit tests. */
  kdfIterations?: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Web Crypto access                                                                          */
/* ------------------------------------------------------------------------------------------ */

function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new VaultyError('CRYPTO_FAILURE', 'Web Crypto (globalThis.crypto.subtle) is unavailable');
  }
  return c.subtle;
}

/** Cryptographically secure random bytes via `crypto.getRandomValues`. */
export function randomBytes(length: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) {
    throw new VaultyError('CRYPTO_FAILURE', 'Web Crypto (globalThis.crypto) is unavailable');
  }
  const out = new Uint8Array(length);
  // getRandomValues is capped at 65536 bytes per call.
  for (let i = 0; i < length; i += 65536) c.getRandomValues(out.subarray(i, Math.min(i + 65536, length)));
  return out;
}

export function randomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.randomUUID) {
    throw new VaultyError('CRYPTO_FAILURE', 'crypto.randomUUID is unavailable');
  }
  return c.randomUUID();
}

const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().digest('SHA-256', bs(data)));
}

/* ------------------------------------------------------------------------------------------ */
/* Pattern normalisation & validation                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Validate a 5×5 grid pattern: an ordered sequence of integers 0…24, no node repeated,
 * at least `minNodes` (default 6) distinct nodes. Returns a defensive typed copy.
 * @throws VaultyError('INVALID_PATTERN')
 */
export function normalizePattern(
  input: readonly number[],
  minNodes: number = MIN_PATTERN_NODES,
): PatternNode[] {
  if (!Array.isArray(input)) {
    throw new VaultyError('INVALID_PATTERN', 'Pattern must be an array of node indexes');
  }
  if (input.length > PATTERN_GRID_NODES) {
    throw new VaultyError('INVALID_PATTERN', `Pattern cannot exceed ${PATTERN_GRID_NODES} nodes`);
  }
  const seen = new Set<number>();
  for (const n of input) {
    if (!Number.isInteger(n) || n < 0 || n >= PATTERN_GRID_NODES) {
      throw new VaultyError('INVALID_PATTERN', 'Pattern nodes must be integers between 0 and 24');
    }
    if (seen.has(n)) {
      throw new VaultyError('INVALID_PATTERN', 'Pattern nodes must be distinct');
    }
    seen.add(n);
  }
  if (seen.size < minNodes) {
    throw new VaultyError('INVALID_PATTERN', `Pattern must connect at least ${minNodes} distinct nodes`);
  }
  return [...input] as PatternNode[];
}

/** True when `input` is a valid pattern (never throws). */
export function isValidPattern(input: readonly number[], minNodes: number = MIN_PATTERN_NODES): boolean {
  try {
    normalizePattern(input, minNodes);
    return true;
  } catch {
    return false;
  }
}

/** Deterministic canonical string, e.g. `[0,1,7,13,19,24]` → `"0,1,7,13,19,24"`. */
export function serializePattern(pattern: readonly PatternNode[]): string {
  return pattern.join(',');
}

/** Public, constant, domain-separated PBKDF2 salt for namespace ids (it must be derivable from the pattern alone). */
export const NAMESPACE_SALT_LABEL = 'vaulty-ns-salt:v2';
/** Domain prefix of the PBKDF2 password for namespace ids (distinct from the KEK prefixes). */
export const NAMESPACE_SECRET_PREFIX = 'vaulty-ns:v2:';

/**
 * The vault's storage namespace id (the on-disk folder name): the 32-byte output of
 * `PBKDF2-HMAC-SHA256(password = "vaulty-ns:v2:" + pattern, salt = "vaulty-ns-salt:v2", iterations)`
 * as lowercase hex.
 *
 * `iterations` is the SAME `kdfIterations` used for the key envelopes (default 600 000), so an
 * attacker who can read folder names pays exactly the same per-guess cost as an attacker
 * attacking `keys.bin`, instead of a single SHA-256. The password prefix and salt differ from the
 * KEK derivation inputs (`vaulty-pattern:v1:` + random salt), so the folder name is an independent
 * PBKDF2 output that reveals nothing about the KEK.
 *
 * Because the iteration count is an input, it is part of a vault's address: a client configured
 * with different `kdfIterations` will not find vaults created with another value.
 */
export async function deriveNamespaceId(
  pattern: readonly PatternNode[],
  options: KdfOptions = {},
): Promise<string> {
  const iterations = checkIterations(options.kdfIterations ?? DEFAULT_KDF_ITERATIONS);
  const subtle = getSubtle();
  const secret = utf8(NAMESPACE_SECRET_PREFIX + serializePattern(pattern));
  try {
    const base = await subtle.importKey('raw', bs(secret), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: bs(utf8(NAMESPACE_SALT_LABEL)), iterations },
      base,
      256,
    );
    return bytesToHex(new Uint8Array(bits));
  } finally {
    secret.fill(0);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Recovery phrase                                                                            */
/* ------------------------------------------------------------------------------------------ */

const WORD_INDEX: ReadonlyMap<string, number> = new Map(WORDLIST.map((w, i) => [w, i]));

/** 9 words × 11 bits = 99 bits of entropy from the embedded BIP-39 list. */
export function generateRecoveryPhrase(): string {
  const raw = randomBytes(RECOVERY_WORD_COUNT * 2);
  const words: string[] = [];
  for (let i = 0; i < RECOVERY_WORD_COUNT; i++) {
    const v = (((raw[i * 2] as number) << 8) | (raw[i * 2 + 1] as number)) & 0x7ff; // 2048 = 2^11: unbiased
    words.push(WORDLIST[v] as string);
  }
  raw.fill(0);
  return words.join(' ');
}

/** Lower-case, collapse whitespace and verify every word is in the wordlist. Returns null if invalid. */
export function tryNormalizeRecoveryPhrase(phrase: string): string | null {
  if (typeof phrase !== 'string') return null;
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== RECOVERY_WORD_COUNT) return null;
  for (const w of words) if (!WORD_INDEX.has(w)) return null;
  return words.join(' ');
}

export function normalizeRecoveryPhrase(phrase: string): string {
  const n = tryNormalizeRecoveryPhrase(phrase);
  if (n === null) {
    throw new VaultyError(
      'INVALID_RECOVERY_PHRASE',
      `Recovery phrase must be exactly ${RECOVERY_WORD_COUNT} valid words`,
    );
  }
  return n;
}

/* ------------------------------------------------------------------------------------------ */
/* Key derivation & wrapping                                                                  */
/* ------------------------------------------------------------------------------------------ */

function checkIterations(iterations: number): number {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_KDF_ITERATIONS) {
    throw new VaultyError('INVALID_ARGUMENT', 'Invalid PBKDF2 iteration count');
  }
  return iterations;
}

/** PBKDF2-HMAC-SHA256 → non-extractable AES-256-GCM key-encryption key. */
export async function deriveKek(
  secret: Uint8Array,
  salt: Uint8Array,
  iterations: number = DEFAULT_KDF_ITERATIONS,
): Promise<CryptoKey> {
  checkIterations(iterations);
  if (salt.length !== SALT_BYTES) {
    throw new VaultyError('INVALID_ARGUMENT', `Salt must be ${SALT_BYTES} bytes`);
  }
  const subtle = getSubtle();
  const base = await subtle.importKey('raw', bs(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bs(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Bytes fed into PBKDF2 for a pattern (domain-separated from the namespace hash input). */
export function patternSecret(pattern: readonly PatternNode[]): Uint8Array {
  return utf8('vaulty-pattern:v1:' + serializePattern(pattern));
}

/** Bytes fed into PBKDF2 for a recovery phrase. */
export function recoverySecret(normalizedPhrase: string): Uint8Array {
  return utf8('vaulty-recovery:v1:' + normalizedPhrase);
}

const wrapAad = (role: EnvelopeRole): Uint8Array => utf8(`vaulty-wrap:v1:${role}`);

/** Generate a fresh random 256-bit Master Vault Key held in a wipeable buffer. */
export function generateMvk(): SecureBuffer {
  return new SecureBuffer(randomBytes(MVK_BYTES));
}

/** Wrap `mvk` under a KEK derived from `secret` with a fresh salt and fresh IV. */
export async function wrapMvk(
  mvk: SecureBuffer | Uint8Array,
  secret: Uint8Array,
  role: EnvelopeRole,
  iterations: number = DEFAULT_KDF_ITERATIONS,
): Promise<WrappedKeyEnvelope> {
  const raw = mvkBytes(mvk);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kek = await deriveKek(secret, salt, iterations);
  const wrapped = new Uint8Array(
    await getSubtle().encrypt(
      { name: 'AES-GCM', iv: bs(iv), additionalData: bs(wrapAad(role)) },
      kek,
      bs(raw),
    ),
  );
  return { salt, iv, wrappedKeyBytes: wrapped, kdfIterations: iterations };
}

/**
 * Unwrap an MVK. Returns a wipeable SecureBuffer.
 * @throws VaultyError('CRYPTO_FAILURE') on wrong secret OR tampered envelope (indistinguishable).
 */
export async function unwrapMvk(
  envelope: WrappedKeyEnvelope,
  secret: Uint8Array,
  role: EnvelopeRole,
): Promise<SecureBuffer> {
  validateEnvelope(envelope);
  const kek = await deriveKek(secret, envelope.salt, envelope.kdfIterations);
  let plain: ArrayBuffer;
  try {
    plain = await getSubtle().decrypt(
      { name: 'AES-GCM', iv: bs(envelope.iv), additionalData: bs(wrapAad(role)) },
      kek,
      bs(envelope.wrappedKeyBytes),
    );
  } catch (cause) {
    throw new VaultyError('CRYPTO_FAILURE', 'Unable to unwrap key', { cause });
  }
  if (plain.byteLength !== MVK_BYTES) {
    throw new VaultyError('CRYPTO_FAILURE', 'Unwrapped key has unexpected length');
  }
  return new SecureBuffer(new Uint8Array(plain));
}

export function validateEnvelope(e: WrappedKeyEnvelope): void {
  if (
    e.salt.length !== SALT_BYTES ||
    e.iv.length !== IV_BYTES ||
    e.wrappedKeyBytes.length !== WRAPPED_KEY_BYTES
  ) {
    throw new VaultyError('CRYPTO_FAILURE', 'Malformed key envelope');
  }
  checkIterations(e.kdfIterations);
}

/** Wrap the MVK with a pattern-derived KEK. */
export async function createPatternEnvelope(
  mvk: SecureBuffer | Uint8Array,
  pattern: readonly PatternNode[],
  options: KdfOptions = {},
): Promise<WrappedKeyEnvelope> {
  const secret = patternSecret(pattern);
  try {
    return await wrapMvk(mvk, secret, 'pattern', options.kdfIterations ?? DEFAULT_KDF_ITERATIONS);
  } finally {
    secret.fill(0);
  }
}

export async function unwrapWithPattern(
  envelope: WrappedKeyEnvelope,
  pattern: readonly PatternNode[],
): Promise<SecureBuffer> {
  const secret = patternSecret(pattern);
  try {
    return await unwrapMvk(envelope, secret, 'pattern');
  } finally {
    secret.fill(0);
  }
}

export interface RecoveryEnvelope {
  /** The 9-word phrase. Show to the user ONCE; it is never stored. */
  phrase: string;
  envelope: WrappedKeyEnvelope;
}

/** Generate a fresh 9-word phrase and an independent recovery envelope of the same MVK. */
export async function createRecoveryEnvelope(
  mvk: SecureBuffer | Uint8Array,
  options: KdfOptions = {},
): Promise<RecoveryEnvelope> {
  const phrase = generateRecoveryPhrase();
  const secret = recoverySecret(phrase);
  try {
    const envelope = await wrapMvk(mvk, secret, 'recovery', options.kdfIterations ?? DEFAULT_KDF_ITERATIONS);
    return { phrase, envelope };
  } finally {
    secret.fill(0);
  }
}

export async function unwrapWithRecoveryPhrase(
  envelope: WrappedKeyEnvelope,
  phrase: string,
): Promise<SecureBuffer> {
  const secret = recoverySecret(normalizeRecoveryPhrase(phrase));
  try {
    return await unwrapMvk(envelope, secret, 'recovery');
  } finally {
    secret.fill(0);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Envelope binary layout                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Layout (big-endian), 82 bytes for a 32-byte MVK:
 *   [0..16)   salt
 *   [16..28)  IV
 *   [28..32)  PBKDF2 iterations (u32)
 *   [32..34)  wrapped length (u16)
 *   [34..82)  wrapped key (32 ciphertext + 16 GCM tag)
 */
export function serializeEnvelope(e: WrappedKeyEnvelope): Uint8Array {
  validateEnvelope(e);
  return new ByteWriter()
    .bytes(e.salt)
    .bytes(e.iv)
    .u32(e.kdfIterations)
    .u16(e.wrappedKeyBytes.length)
    .bytes(e.wrappedKeyBytes)
    .finish();
}

export function readEnvelope(reader: ByteReader): WrappedKeyEnvelope {
  const salt = reader.bytes(SALT_BYTES);
  const iv = reader.bytes(IV_BYTES);
  const kdfIterations = reader.u32();
  const len = reader.u16();
  if (len !== WRAPPED_KEY_BYTES) {
    throw new VaultyError('CRYPTO_FAILURE', 'Malformed key envelope');
  }
  const wrappedKeyBytes = reader.bytes(len);
  const env = { salt, iv, wrappedKeyBytes, kdfIterations };
  validateEnvelope(env);
  return env;
}

export function parseEnvelope(bytes: Uint8Array): WrappedKeyEnvelope {
  const reader = new ByteReader(bytes);
  const env = readEnvelope(reader);
  if (reader.remaining !== 0) throw new VaultyError('CRYPTO_FAILURE', 'Trailing bytes after envelope');
  return env;
}

/* ------------------------------------------------------------------------------------------ */
/* Authenticated encryption                                                                   */
/* ------------------------------------------------------------------------------------------ */

function mvkBytes(mvk: SecureBuffer | Uint8Array): Uint8Array {
  const raw = mvk instanceof SecureBuffer ? mvk.bytes : mvk; // SecureBuffer.bytes throws once wiped
  if (raw.length !== MVK_BYTES) {
    throw new VaultyError('INVALID_ARGUMENT', `Master key must be ${MVK_BYTES} bytes`);
  }
  return raw;
}

async function importMvk(mvk: SecureBuffer | Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey('raw', bs(mvkBytes(mvk)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const toAad = (aad?: Uint8Array | string): Uint8Array | undefined =>
  aad === undefined ? undefined : typeof aad === 'string' ? utf8(aad) : aad;

/**
 * AES-256-GCM encrypt. Output layout: `IV(12) ‖ ciphertext ‖ tag(16)`.
 * A FRESH random 12-byte IV is drawn from `crypto.getRandomValues` for every call.
 * `aad` (e.g. the vault namespace id) is authenticated but not encrypted.
 */
export async function encryptBytes(
  mvk: SecureBuffer | Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array | string,
): Promise<Uint8Array> {
  const key = await importMvk(mvk);
  const iv = randomBytes(IV_BYTES);
  const additionalData = toAad(aad);
  const params: AesGcmParams = { name: 'AES-GCM', iv: bs(iv) };
  if (additionalData) params.additionalData = bs(additionalData);
  const ct = new Uint8Array(await getSubtle().encrypt(params, key, bs(plaintext)));
  return concatBytes(iv, ct);
}

/**
 * Inverse of {@link encryptBytes}.
 * @throws VaultyError('CRYPTO_FAILURE') on wrong key, wrong AAD, or any tampering.
 */
export async function decryptBytes(
  mvk: SecureBuffer | Uint8Array,
  payload: Uint8Array,
  aad?: Uint8Array | string,
): Promise<Uint8Array> {
  if (payload.length < IV_BYTES + GCM_TAG_BYTES) {
    throw new VaultyError('CRYPTO_FAILURE', 'Ciphertext too short');
  }
  const key = await importMvk(mvk);
  const iv = payload.subarray(0, IV_BYTES);
  const additionalData = toAad(aad);
  const params: AesGcmParams = { name: 'AES-GCM', iv: bs(iv) };
  if (additionalData) params.additionalData = bs(additionalData);
  try {
    return new Uint8Array(await getSubtle().decrypt(params, key, bs(payload.subarray(IV_BYTES))));
  } catch (cause) {
    throw new VaultyError('CRYPTO_FAILURE', 'Decryption failed (wrong key, wrong context, or tampered data)', {
      cause,
    });
  }
}
