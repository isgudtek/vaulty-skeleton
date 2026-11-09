import { createHash, pbkdf2Sync as pbkdfSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { equalBytes } from '../src/bytes';
import {
  DEFAULT_KDF_ITERATIONS,
  ENVELOPE_BYTES,
  GCM_TAG_BYTES,
  IV_BYTES,
  MAX_KDF_ITERATIONS,
  MVK_BYTES,
  RECOVERY_WORD_COUNT,
  SALT_BYTES,
  createPatternEnvelope,
  createRecoveryEnvelope,
  decryptBytes,
  deriveNamespaceId,
  encryptBytes,
  generateMvk,
  generateRecoveryPhrase,
  isValidPattern,
  normalizePattern,
  normalizeRecoveryPhrase,
  parseEnvelope,
  serializeEnvelope,
  serializePattern,
  tryNormalizeRecoveryPhrase,
  unwrapMvk,
  unwrapWithPattern,
  unwrapWithRecoveryPhrase,
} from '../src/crypto';
import { SecureBuffer } from '../src/memory';
import { VaultyError } from '../src/types';
import { WORDLIST } from '../src/wordlist';

const FAST = { kdfIterations: 1_000 };
const PATTERN = normalizePattern([0, 1, 2, 3, 4, 9]);
const OTHER = normalizePattern([24, 23, 22, 21, 20, 15]);

const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VaultyError);
  expect((err as VaultyError).code).toBe(code);
};

afterEach(() => vi.restoreAllMocks());

describe('pattern normalisation & validation', () => {
  it('accepts a valid ordered pattern and returns a defensive copy', () => {
    const input = [0, 1, 2, 3, 4, 9];
    const out = normalizePattern(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('accepts the full 25-node pattern', () => {
    const all = Array.from({ length: 25 }, (_, i) => i);
    expect(normalizePattern(all)).toHaveLength(25);
  });

  it.each([
    ['too short (5 nodes)', [0, 1, 2, 3, 4]],
    ['empty', []],
    ['duplicate node', [0, 1, 2, 3, 4, 4]],
    ['negative node', [0, 1, 2, 3, 4, -1]],
    ['node 25 out of range', [0, 1, 2, 3, 4, 25]],
    ['non-integer', [0, 1, 2, 3, 4, 5.5]],
    ['NaN', [0, 1, 2, 3, 4, Number.NaN]],
    ['more than 25 nodes', Array.from({ length: 26 }, (_, i) => i % 25)],
  ])('rejects %s', (_label, bad) => {
    expect(() => normalizePattern(bad)).toThrowError(VaultyError);
    expect(isValidPattern(bad)).toBe(false);
  });

  it('rejects non-arrays', () => {
    expect(() => normalizePattern('012345' as unknown as number[])).toThrowError(VaultyError);
  });

  it('serialises deterministically and order-sensitively', () => {
    expect(serializePattern(PATTERN)).toBe('0,1,2,3,4,9');
    const reordered = normalizePattern([9, 4, 3, 2, 1, 0]);
    expect(serializePattern(reordered)).not.toBe(serializePattern(PATTERN));
  });

  describe('namespace id (domain-separated PBKDF2-HMAC-SHA256)', () => {
    const independent = (pattern: string, iterations: number) =>
      pbkdfSync(`vaulty-ns:v2:${pattern}`, 'vaulty-ns-salt:v2', iterations, 32, 'sha256').toString('hex');

    it('equals an independent PBKDF2 computation with the configured iterations', async () => {
      expect(await deriveNamespaceId(PATTERN, { kdfIterations: 1_000 })).toBe(independent('0,1,2,3,4,9', 1_000));
      expect(await deriveNamespaceId(OTHER, { kdfIterations: 2_500 })).toBe(independent('24,23,22,21,20,15', 2_500));
    });

    it('defaults to 600,000 iterations', async () => {
      expect(await deriveNamespaceId(PATTERN)).toBe(independent('0,1,2,3,4,9', 600_000));
    });

    it('is deterministic, 64 lowercase hex chars, and sensitive to pattern order and to the iteration count', async () => {
      const a = await deriveNamespaceId(PATTERN, FAST);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(await deriveNamespaceId(PATTERN, FAST)).toBe(a);
      expect(await deriveNamespaceId(normalizePattern([9, 4, 3, 2, 1, 0]), FAST)).not.toBe(a);
      expect(await deriveNamespaceId(OTHER, FAST)).not.toBe(a);
      expect(await deriveNamespaceId(PATTERN, { kdfIterations: 1_001 })).not.toBe(a);
    });

    it('is no longer a single-round hash: it differs from the legacy SHA-256 and costs real PBKDF2 iterations', async () => {
      const legacy = createHash('sha256').update('vaulty-ns:0,1,2,3,4,9').digest('hex');
      const legacyV2Prefix = createHash('sha256').update('vaulty-ns:v2:0,1,2,3,4,9').digest('hex');
      const ns = await deriveNamespaceId(PATTERN, FAST);
      expect(ns).not.toBe(legacy);
      expect(ns).not.toBe(legacyV2Prefix);

      const spy = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');
      await deriveNamespaceId(PATTERN, { kdfIterations: 4_321 });
      expect(spy).toHaveBeenCalledTimes(1);
      const params = spy.mock.calls[0]![0] as Pbkdf2Params;
      expect(params.name).toBe('PBKDF2');
      expect(params.hash).toBe('SHA-256');
      expect(params.iterations).toBe(4_321);
    });

    it('is domain-separated from the pattern KEK: different input and salt, and the id never equals key material', async () => {
      const ns = await deriveNamespaceId(PATTERN, FAST);
      // Same PBKDF2 parameters, but with the KEK password prefix, must give an unrelated value.
      const kekPrefixed = pbkdfSync('vaulty-pattern:v1:0,1,2,3,4,9', 'vaulty-ns-salt:v2', 1_000, 32, 'sha256').toString('hex');
      expect(ns).not.toBe(kekPrefixed);
      // And the NS password with a different salt is unrelated too.
      const otherSalt = pbkdfSync('vaulty-ns:v2:0,1,2,3,4,9', 'x'.repeat(16), 1_000, 32, 'sha256').toString('hex');
      expect(ns).not.toBe(otherSalt);
      // The folder name is not derivable from the stored envelope's salt either.
      const env = await createPatternEnvelope(generateMvk(), PATTERN, FAST);
      const viaEnvSalt = pbkdfSync('vaulty-ns:v2:0,1,2,3,4,9', Buffer.from(env.salt), 1_000, 32, 'sha256').toString('hex');
      expect(ns).not.toBe(viaEnvSalt);
    });

    it('rejects invalid or absurd iteration counts', async () => {
      await rejectsWith(deriveNamespaceId(PATTERN, { kdfIterations: 0 }), 'INVALID_ARGUMENT');
      await rejectsWith(deriveNamespaceId(PATTERN, { kdfIterations: -5 }), 'INVALID_ARGUMENT');
      await rejectsWith(deriveNamespaceId(PATTERN, { kdfIterations: 1.5 }), 'INVALID_ARGUMENT');
      await rejectsWith(deriveNamespaceId(PATTERN, { kdfIterations: MAX_KDF_ITERATIONS + 1 }), 'INVALID_ARGUMENT');
    });
  });
});

describe('embedded BIP-39 wordlist & recovery phrase', () => {
  it('is the canonical 2048-word list', () => {
    expect(WORDLIST).toHaveLength(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect(WORDLIST[0]).toBe('abandon');
    expect(WORDLIST[2047]).toBe('zoo');
    const digest = createHash('sha256').update(WORDLIST.join('\n') + '\n').digest('hex');
    expect(digest).toBe('2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  });

  it('generates 9 valid words and never repeats across generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const phrase = generateRecoveryPhrase();
      const words = phrase.split(' ');
      expect(words).toHaveLength(RECOVERY_WORD_COUNT);
      for (const w of words) expect(WORDLIST).toContain(w);
      seen.add(phrase);
    }
    expect(seen.size).toBe(50);
  });

  it('normalises case and whitespace, and rejects bad phrases', () => {
    const phrase = generateRecoveryPhrase();
    const messy = `  ${phrase.toUpperCase().replace(/ /g, '   ')}\n`;
    expect(normalizeRecoveryPhrase(messy)).toBe(phrase);
    expect(tryNormalizeRecoveryPhrase(phrase.split(' ').slice(0, 8).join(' '))).toBeNull();
    expect(tryNormalizeRecoveryPhrase(`${phrase} abandon`)).toBeNull();
    expect(tryNormalizeRecoveryPhrase(phrase.replace(/^\w+/, 'zzzzzz'))).toBeNull();
    expect(() => normalizeRecoveryPhrase('nope')).toThrowError(VaultyError);
  });
});

describe('MVK wrapping with a pattern-derived KEK (PBKDF2-HMAC-SHA256)', () => {
  it('wraps and unwraps the same 256-bit key', async () => {
    const mvk = generateMvk();
    expect(mvk.length).toBe(MVK_BYTES);
    const original = mvk.bytes.slice();
    const env = await createPatternEnvelope(mvk, PATTERN, FAST);
    expect(env.salt).toHaveLength(SALT_BYTES);
    expect(env.iv).toHaveLength(IV_BYTES);
    expect(env.wrappedKeyBytes).toHaveLength(MVK_BYTES + GCM_TAG_BYTES);
    expect(env.kdfIterations).toBe(1_000);
    const back = await unwrapWithPattern(env, PATTERN);
    expect(equalBytes(back.bytes, original)).toBe(true);
  });

  it('defaults to 600,000 PBKDF2 iterations', async () => {
    expect(DEFAULT_KDF_ITERATIONS).toBe(600_000);
    const env = await createPatternEnvelope(generateMvk(), PATTERN);
    expect(env.kdfIterations).toBe(600_000);
    const back = await unwrapWithPattern(env, PATTERN);
    expect(back.length).toBe(MVK_BYTES);
  });

  it('rejects the wrong pattern', async () => {
    const env = await createPatternEnvelope(generateMvk(), PATTERN, FAST);
    await rejectsWith(unwrapWithPattern(env, OTHER), 'CRYPTO_FAILURE');
  });

  it('pattern order matters', async () => {
    const env = await createPatternEnvelope(generateMvk(), PATTERN, FAST);
    await rejectsWith(unwrapWithPattern(env, normalizePattern([9, 4, 3, 2, 1, 0])), 'CRYPTO_FAILURE');
  });

  it('uses a fresh salt and IV for every wrap, so envelopes differ for the same inputs', async () => {
    const mvk = generateMvk();
    const a = await createPatternEnvelope(mvk, PATTERN, FAST);
    const b = await createPatternEnvelope(mvk, PATTERN, FAST);
    expect(equalBytes(a.salt, b.salt)).toBe(false);
    expect(equalBytes(a.iv, b.iv)).toBe(false);
    expect(equalBytes(a.wrappedKeyBytes, b.wrappedKeyBytes)).toBe(false);
  });

  it('rejects any tampering with salt, iv, wrapped bytes or iteration count', async () => {
    const env = await createPatternEnvelope(generateMvk(), PATTERN, FAST);
    const flip = (u: Uint8Array) => {
      const c = u.slice();
      c[0] = (c[0] as number) ^ 1;
      return c;
    };
    await rejectsWith(unwrapWithPattern({ ...env, salt: flip(env.salt) }, PATTERN), 'CRYPTO_FAILURE');
    await rejectsWith(unwrapWithPattern({ ...env, iv: flip(env.iv) }, PATTERN), 'CRYPTO_FAILURE');
    await rejectsWith(
      unwrapWithPattern({ ...env, wrappedKeyBytes: flip(env.wrappedKeyBytes) }, PATTERN),
      'CRYPTO_FAILURE',
    );
    await rejectsWith(unwrapWithPattern({ ...env, kdfIterations: 1_001 }, PATTERN), 'CRYPTO_FAILURE');
  });

  it('refuses absurd iteration counts (CPU-exhaustion guard) and malformed envelopes', async () => {
    const env = await createPatternEnvelope(generateMvk(), PATTERN, FAST);
    await rejectsWith(
      unwrapWithPattern({ ...env, kdfIterations: MAX_KDF_ITERATIONS + 1 }, PATTERN),
      'INVALID_ARGUMENT',
    );
    await rejectsWith(unwrapWithPattern({ ...env, kdfIterations: 0 }, PATTERN), 'INVALID_ARGUMENT');
    await rejectsWith(unwrapWithPattern({ ...env, salt: new Uint8Array(8) }, PATTERN), 'CRYPTO_FAILURE');
  });

  it('wiping the unwrapped key zeroes it', async () => {
    const env = await createPatternEnvelope(generateMvk(), PATTERN, FAST);
    const key = await unwrapWithPattern(env, PATTERN);
    const view = key.bytes;
    expect(view.some((b) => b !== 0)).toBe(true);
    key.wipe();
    expect(view.every((b) => b === 0)).toBe(true);
  });
});

describe('9-word recovery phrase envelope', () => {
  it('unwraps to exactly the same MVK as the pattern envelope', async () => {
    const mvk = generateMvk();
    const original = mvk.bytes.slice();
    const patternEnv = await createPatternEnvelope(mvk, PATTERN, FAST);
    const { phrase, envelope } = await createRecoveryEnvelope(mvk, FAST);
    expect(phrase.split(' ')).toHaveLength(9);
    const viaPhrase = await unwrapWithRecoveryPhrase(envelope, phrase);
    const viaPattern = await unwrapWithPattern(patternEnv, PATTERN);
    expect(equalBytes(viaPhrase.bytes, original)).toBe(true);
    expect(equalBytes(viaPattern.bytes, original)).toBe(true);
  });

  it('is an independent envelope (own salt, IV and ciphertext)', async () => {
    const mvk = generateMvk();
    const patternEnv = await createPatternEnvelope(mvk, PATTERN, FAST);
    const { envelope } = await createRecoveryEnvelope(mvk, FAST);
    expect(equalBytes(patternEnv.salt, envelope.salt)).toBe(false);
    expect(equalBytes(patternEnv.iv, envelope.iv)).toBe(false);
    expect(equalBytes(patternEnv.wrappedKeyBytes, envelope.wrappedKeyBytes)).toBe(false);
  });

  it('accepts messy casing/whitespace but rejects a wrong or malformed phrase', async () => {
    const mvk = generateMvk();
    const { phrase, envelope } = await createRecoveryEnvelope(mvk, FAST);
    const ok = await unwrapWithRecoveryPhrase(envelope, `  ${phrase.toUpperCase()}  `);
    expect(ok.length).toBe(MVK_BYTES);
    await rejectsWith(unwrapWithRecoveryPhrase(envelope, generateRecoveryPhrase()), 'CRYPTO_FAILURE');
    await rejectsWith(unwrapWithRecoveryPhrase(envelope, 'only three words'), 'INVALID_RECOVERY_PHRASE');
  });

  it('role-binds envelopes: a pattern cannot open the recovery envelope and vice-versa', async () => {
    const mvk = generateMvk();
    const patternEnv = await createPatternEnvelope(mvk, PATTERN, FAST);
    const { phrase, envelope } = await createRecoveryEnvelope(mvk, FAST);
    await rejectsWith(unwrapWithPattern(envelope, PATTERN), 'CRYPTO_FAILURE');
    await rejectsWith(unwrapWithRecoveryPhrase(patternEnv, phrase), 'CRYPTO_FAILURE');
    // Even with the right raw secret, the wrong role must fail (AAD binding).
    const secret = new TextEncoder().encode('vaulty-pattern:v1:0,1,2,3,4,9');
    await rejectsWith(unwrapMvk(patternEnv, secret, 'recovery'), 'CRYPTO_FAILURE');
  });
});

describe('envelope binary layout', () => {
  it('serialises to the documented fixed 82-byte layout and round-trips', async () => {
    const env = await createPatternEnvelope(generateMvk(), PATTERN, FAST);
    const bytes = serializeEnvelope(env);
    expect(ENVELOPE_BYTES).toBe(82);
    expect(bytes).toHaveLength(82);
    expect(equalBytes(bytes.subarray(0, 16), env.salt)).toBe(true);
    expect(equalBytes(bytes.subarray(16, 28), env.iv)).toBe(true);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(28, false)).toBe(1_000);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(32, false)).toBe(48);
    expect(equalBytes(bytes.subarray(34), env.wrappedKeyBytes)).toBe(true);
    const parsed = parseEnvelope(bytes);
    expect(parsed.kdfIterations).toBe(1_000);
    expect(equalBytes(parsed.wrappedKeyBytes, env.wrappedKeyBytes)).toBe(true);
  });

  it('rejects truncated, over-long and wrong-length envelopes', async () => {
    const bytes = serializeEnvelope(await createPatternEnvelope(generateMvk(), PATTERN, FAST));
    expect(() => parseEnvelope(bytes.subarray(0, 81))).toThrowError(VaultyError);
    expect(() => parseEnvelope(new Uint8Array([...bytes, 0]))).toThrowError(VaultyError);
    const wrongLen = bytes.slice();
    new DataView(wrongLen.buffer).setUint16(32, 47, false);
    expect(() => parseEnvelope(wrongLen)).toThrowError(VaultyError);
  });
});

describe('AES-256-GCM authenticated encryption', () => {
  it('round-trips and uses the IV ‖ ciphertext ‖ tag layout', async () => {
    const mvk = generateMvk();
    const plain = new TextEncoder().encode('attack at dawn');
    const payload = await encryptBytes(mvk, plain);
    expect(payload).toHaveLength(IV_BYTES + plain.length + GCM_TAG_BYTES);
    expect(new TextDecoder().decode(await decryptBytes(mvk, payload))).toBe('attack at dawn');
  });

  it('handles empty and large plaintexts', async () => {
    const mvk = generateMvk();
    expect(await decryptBytes(mvk, await encryptBytes(mvk, new Uint8Array(0)))).toHaveLength(0);
    const big = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536));
    const back = await decryptBytes(mvk, await encryptBytes(mvk, big));
    expect(equalBytes(back, big)).toBe(true);
  });

  it('never repeats an IV across 100 encryptions of the same plaintext, and draws each from getRandomValues', async () => {
    const mvk = generateMvk();
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const plain = new TextEncoder().encode('same plaintext every time');
    const ivs = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const payload = await encryptBytes(mvk, plain);
      ivs.add(Buffer.from(payload.subarray(0, IV_BYTES)).toString('hex'));
      ciphertexts.add(Buffer.from(payload).toString('hex'));
    }
    expect(ivs.size).toBe(100);
    expect(ciphertexts.size).toBe(100);
    const ivDraws = spy.mock.calls.filter(([arr]) => (arr as Uint8Array).length === IV_BYTES);
    expect(ivDraws.length).toBeGreaterThanOrEqual(100);
  });

  it('binds AAD: wrong, missing or extra AAD is rejected', async () => {
    const mvk = generateMvk();
    const plain = new TextEncoder().encode('bound to vault A');
    const payload = await encryptBytes(mvk, plain, 'vault-A');
    expect(equalBytes(await decryptBytes(mvk, payload, 'vault-A'), plain)).toBe(true);
    expect(equalBytes(await decryptBytes(mvk, payload, new TextEncoder().encode('vault-A')), plain)).toBe(true);
    await rejectsWith(decryptBytes(mvk, payload, 'vault-B'), 'CRYPTO_FAILURE');
    await rejectsWith(decryptBytes(mvk, payload), 'CRYPTO_FAILURE');
    const noAad = await encryptBytes(mvk, plain);
    await rejectsWith(decryptBytes(mvk, noAad, 'vault-A'), 'CRYPTO_FAILURE');
  });

  it('prevents cross-vault ciphertext swapping via namespace-bound AAD', async () => {
    const mvk = generateMvk(); // even the SAME key cannot validate a swapped ciphertext
    const nsA = await deriveNamespaceId(PATTERN);
    const nsB = await deriveNamespaceId(OTHER);
    const fromA = await encryptBytes(mvk, new TextEncoder().encode('A-secret'), nsA);
    await rejectsWith(decryptBytes(mvk, fromA, nsB), 'CRYPTO_FAILURE');
  });

  it('rejects a bit-flip anywhere in IV, ciphertext or tag', async () => {
    const mvk = generateMvk();
    const payload = await encryptBytes(mvk, new TextEncoder().encode('integrity matters'), 'ctx');
    for (const pos of [0, IV_BYTES - 1, IV_BYTES, payload.length - GCM_TAG_BYTES - 1, payload.length - 1]) {
      const bad = payload.slice();
      bad[pos] = (bad[pos] as number) ^ 0x01;
      await rejectsWith(decryptBytes(mvk, bad, 'ctx'), 'CRYPTO_FAILURE');
    }
  });

  it('rejects truncated payloads and wrong keys', async () => {
    const mvk = generateMvk();
    const payload = await encryptBytes(mvk, new TextEncoder().encode('hello'));
    await rejectsWith(decryptBytes(mvk, payload.subarray(0, payload.length - 1)), 'CRYPTO_FAILURE');
    await rejectsWith(decryptBytes(mvk, payload.subarray(0, 10)), 'CRYPTO_FAILURE');
    await rejectsWith(decryptBytes(mvk, new Uint8Array(0)), 'CRYPTO_FAILURE');
    await rejectsWith(decryptBytes(generateMvk(), payload), 'CRYPTO_FAILURE');
  });

  it('rejects keys of the wrong size', async () => {
    await rejectsWith(encryptBytes(new Uint8Array(16), new Uint8Array(1)), 'INVALID_ARGUMENT');
  });

  it('refuses to use a wiped key (no silent all-zero-key encryption)', async () => {
    const mvk = generateMvk();
    mvk.wipe();
    await rejectsWith(encryptBytes(mvk, new Uint8Array(4)), 'VAULT_LOCKED');
    await rejectsWith(decryptBytes(mvk, new Uint8Array(40)), 'VAULT_LOCKED');
  });
});

describe('SecureBuffer', () => {
  it('wipe() zero-fills the underlying memory deterministically', () => {
    const backing = new Uint8Array(64);
    crypto.getRandomValues(backing);
    backing[0] = 0xff; // guarantee non-zero
    const buf = new SecureBuffer(backing);
    expect(buf.isWiped).toBe(false);
    expect(buf.length).toBe(64);
    expect(backing.some((b) => b !== 0)).toBe(true);
    buf.wipe();
    expect(buf.isWiped).toBe(true);
    expect(backing.every((b) => b === 0)).toBe(true);
  });

  it('throws on access after wipe, and wipe is idempotent', () => {
    const buf = SecureBuffer.copyOf(new Uint8Array([1, 2, 3]));
    expect(Array.from(buf.bytes)).toEqual([1, 2, 3]);
    buf.wipe();
    buf.wipe();
    expect(() => buf.bytes).toThrowError(VaultyError);
    expect(buf.isWiped).toBe(true);
  });

  it('alloc() creates a zeroed, un-wiped buffer; copyOf() does not alias the source', () => {
    const a = SecureBuffer.alloc(8);
    expect(a.isWiped).toBe(false);
    expect(Array.from(a.bytes)).toEqual(new Array(8).fill(0));
    const src = new Uint8Array([9, 9, 9]);
    const c = SecureBuffer.copyOf(src);
    c.wipe();
    expect(Array.from(src)).toEqual([9, 9, 9]);
  });
});
