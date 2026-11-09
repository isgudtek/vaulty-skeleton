# Crypto invariants for Vaulty

These rules apply to **every** change in this repository. They are non-negotiable; if a task seems to
require breaking one, stop and ask the user instead. They are enforced by
`packages/core/scripts/check-security.mjs` (`npm run check:security`) and by the test suite.

## 1. No plaintext or key material in web storage
- NEVER read or write `localStorage`, `sessionStorage` or `document.cookie`. Persistent data goes only through a
  `StorageAdapter` (OPFS / IndexedDB / memory) and is ciphertext or a public key envelope.
- The one exception is **destructive**: `localStorage.clear()` / `sessionStorage.clear()` inside the duress purge
  (`purgeEnvironment`). No `setItem`, `getItem`, `removeItem`, `key()`, `length` or bracket access — ever.
- Never persist the pattern, recovery phrase, MVK, KEK, or decrypted item names/tags.

## 2. A fresh random IV for every AES-256-GCM encryption
- Every `subtle.encrypt` call uses a new 12-byte IV from `crypto.getRandomValues` (via `randomBytes(IV_BYTES)`).
- No counters, no derived IVs, no zero/literal IVs, no IV caching, no reuse across keys or retries.
- AES-GCM only, 256-bit keys only. No CBC/CTR/ECB, no SHA-1/MD5. PBKDF2 uses `hash: 'SHA-256'` and defaults to
  600 000 iterations (lower only through the explicit `kdfIterations` option, in tests).
- Bind ciphertext to its context with AAD (namespace id, item id, envelope role). Never use `Math.random`.
- CryptoKeys are non-extractable; never call `exportKey`.

## 3. Deterministic memory zeroing
- Key material lives in a `SecureBuffer` (a `Uint8Array`) and is zeroed with `Uint8Array.fill(0)`:
  on `lock()`, `document.visibilitychange → hidden`, `window.pagehide`, idle timeout and duress.
- Transient plaintext and secret byte arrays (pattern secrets, JSON index bytes, decrypted blobs we own) are `.fill(0)`'d
  in a `finally` block as soon as they have been used.
- A wiped buffer must throw on access; never silently operate on a zeroed key.

## 4. No unencrypted global metadata
- No file, key, flag or database record outside a vault namespace container may reveal vault count, vault names,
  last-used vault, or duress configuration. There is no "settings" or "vaults.json".
- Duress configuration exists only inside an **encrypted** index; real, decoy and duress vaults must keep identical
  on-disk shape (`keys.bin` fixed size + `index.enc` + UUID-named blobs).
- Unknown patterns create empty vaults silently; `unlock()` must never expose a "wrong pattern" signal.

## Working rules
- `@vaulty/core` has **zero runtime dependencies**, performs **no network I/O** and no `console.*` logging.
- Run `npm run check:security`, `npm test` and `npm run build` in `packages/core` before declaring work done.
- Never add `.kiro` to `.gitignore`.
