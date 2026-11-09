# Design — `@vaulty/core` (Phase 1)

Traceability: requirement IDs (`R*`) refer to `requirements.md`.

## 1. Goals & non-goals

**Goals** — client-side only, zero-knowledge, zero runtime dependencies, Web Crypto only, works in
browsers, workers and Node ≥ 20 (for tests/SSR), deterministic key hygiene, indistinguishable vaults.

**Non-goals** — server sync, multi-user sharing, defence against a compromised page/extension/OS,
hiding that Vaulty is installed, hiding the *number* of namespace containers on disk (see §7).

## 2. Module map

```
src/
  types.ts     domain contracts + VaultyError            (no logic besides the error class)
  bytes.ts     utf8/hex/uuid helpers, ByteWriter/ByteReader (bounds-checked), realm-safe type guards
  wordlist.ts  frozen 2048-word BIP-39 list (SHA-256 of source pinned in header + test)
  memory.ts    SecureBuffer, SessionGuard               (R6)
  crypto.ts    pattern rules, KDF, wrap/unwrap, AES-GCM (R1–R5)
  storage.ts   Memory / OPFS / IndexedDB adapters, createBestStorageAdapter, purgeEnvironment (R9)
  vault.ts     VaultClient: routing, duress, index, items, archives (R7, R8, R10, R11)
  react/index.ts  useVault, PatternGrid                  (R12)  — only file that imports `react`
  index.ts     public barrel (never imports react)
```

Dependency direction: `types ← bytes ← memory ← crypto ← storage ← vault ← react`. Nothing under
`src/` performs network I/O or logging (enforced by `scripts/check-security.mjs`, R13).

## 3. Cryptographic architecture

```
 pattern ──serialize──► "0,1,2,3,4,9"
    │                       │
    │                       ├─ PBKDF2-HMAC-SHA256("vaulty-ns:v2:" ‖ s, salt="vaulty-ns-salt:v2", 600 000)
    │                       │        ─────────────────────────────────────► namespaceId (hex, storage container)
    │                       │
    │                       └─ "vaulty-pattern:v1:" ‖ s ─┐
    │                                                    ▼
    │                     PBKDF2-HMAC-SHA256(salt₁₆, 600 000) ─► KEK_p (AES-256-GCM, non-extractable)
    │                                                    │
 MVK (32 random bytes, SecureBuffer) ── AES-GCM(KEK_p, iv₁₂, aad="vaulty-wrap:v1:pattern") ─► patternEnvelope
    │
    └────────────── AES-GCM(KEK_r, iv₁₂, aad="vaulty-wrap:v1:recovery") ─► recoveryEnvelope
                         ▲
 9 BIP-39 words ─"vaulty-recovery:v1:"‖phrase─► PBKDF2-HMAC-SHA256(salt₁₆, 600 000) ─► KEK_r

 MVK ─► AES-256-GCM  (fresh 12-byte getRandomValues IV per call)
        index.enc :  aad = "vaulty-index:v1:" ‖ namespaceId
        blob <id> :  aad = "vaulty-blob:v1:"  ‖ namespaceId ‖ ":" ‖ id
```

Design decisions

| Decision | Rationale |
|----------|-----------|
| MVK is random, not derived from the pattern | The pattern can change/re-key without re-encrypting data; the recovery phrase wraps the *same* key (R3.3). |
| MVK lives in a `Uint8Array` (SecureBuffer); a `CryptoKey` is imported per operation, non-extractable | `CryptoKey`s cannot be zeroed; the raw bytes can, so `wipe()` really ends the session (R5.5, R6). |
| Envelope role in AAD | A pattern cannot unwrap the recovery envelope, and vice-versa, even if secrets were mixed up (R3.4). |
| Blob AAD = namespace + item id | Stops cross-vault *and* intra-vault ciphertext swapping (R5.3). |
| Random 96-bit IVs | Per-key invocation limit under NIST SP 800-38D is 2³² messages — far beyond a personal vault. |
| Recovery phrase 9×11 = 99 bits | Brute force is infeasible even at the 600k KDF cost; independent salt/IV/KEK. |
| Indistinguishable wrong-secret vs tampered failures | Single `CRYPTO_FAILURE` code, no oracle (R3.5). |
| Namespace id = domain-separated PBKDF2 (same `kdfIterations`) | Folder names are visible to anyone with disk access; they must not be a cheaper pattern oracle than `keys.bin` (T3, R2.7, R7.1). See §3.1. |

### 3.1 Namespace id derivation (hardened T3)

```
namespaceId = hex( PBKDF2-HMAC-SHA256(
                     password   = UTF-8("vaulty-ns:v2:" ‖ serializePattern(pattern)),
                     salt       = UTF-8("vaulty-ns-salt:v2"),      // public, constant
                     iterations = kdfIterations,                   // same option as the envelopes; default 600 000
                     dkLen      = 32 bytes ) )                     // 64 lowercase hex chars (same shape as before)
```

* **Cost parity.** Confirming a guessed pattern from a folder name now takes the same 600 000-iteration PBKDF2 as
  attacking the wrapped key in `keys.bin`; the folder name is never a cheaper path (previously: one SHA-256).
* **Domain separation.** The password prefix (`vaulty-ns:v2:` vs `vaulty-pattern:v1:` / `vaulty-recovery:v1:`) and the
  salt (constant label vs the envelope's random 16 bytes) both differ from KEK derivation, so the folder name is an
  independent PBKDF2 output and gives no information about the KEK or MVK. A distinct version tag (`v2`) also keeps it
  from colliding with the retired `SHA-256("vaulty-ns:"‖s)` scheme.
* **Why the salt is constant.** The id must be computable from the pattern alone (no global file, no stored salt),
  otherwise a global metadata file would be needed (R9.8) and archives could not be addressed on another device.
* **`kdfIterations` is part of a vault's address.** A client configured with a different iteration count derives a
  different folder name and will *not* find vaults created with another value (it silently starts a new empty vault, per
  R7.2). Treat `kdfIterations` as a fixed per-deployment constant; to change it, export, then `importArchive(…, {newPattern})`.
  Envelope iteration counts remain self-describing, so existing envelopes always unwrap with the count they were created with.
* **Cost to the user.** One additional PBKDF2 per `unlock` (open: 2 derivations, create: 3), per `configureDuress`/
  `removeDuress`, and per `importArchive` with `newPattern`. A runtime-option duress match still performs no KDF.
* **Compatibility.** Archives are unchanged (`namespaceId` is still 32 raw bytes, format version 1). Vaults created by
  pre-hardening development builds (single SHA-256 folder names) are not discovered by this version; restore them via
  their `.vault` archive with `importArchive(bundle, patternOrPhrase, undefined, { newPattern })`. No in-place migration is
  provided because 0.1.0 has not been released.

## 4. Byte-level binary layouts

All integers big-endian. `‖` = concatenation.

### 4.1 AES-GCM payload (`encryptBytes` output; used for `index.enc` and every blob)

```
offset  size  field
0       12    IV            (crypto.getRandomValues, unique per encryption)
12      n     ciphertext    (n = plaintext length)
12+n    16    GCM tag
```
Overhead is exactly 28 bytes; minimum valid payload is 28 bytes.

### 4.2 Wrapped key envelope — 82 bytes

```
offset  size  field
0       16    salt              PBKDF2 salt
16      12    iv                AES-GCM IV for the wrap
28      4     kdfIterations     u32 (1 … 10 000 000 accepted)
32      2     wrappedLen        u16, MUST equal 48
34      48    wrappedKeyBytes   AES-GCM(KEK, MVK): 32 ciphertext ‖ 16 tag
```

### 4.3 `keys.bin` (per namespace) — 165 bytes, constant for every vault kind

```
offset  size  field
0       1     version           = 1
1       82    patternEnvelope
83      82    recoveryEnvelope
```
Written **last** during creation/import; a namespace without `keys.bin` is incomplete (R11.7).
Duress and decoy vaults have a recovery envelope too (phrase discarded) so shapes are identical (R7.4).

### 4.4 `index.enc` plaintext (before §4.1 encryption) — UTF-8 JSON

```jsonc
{ "v": 1, "createdAt": 1700000000000,
  "entries": { "<uuid>": { "id", "name", "mimeType", "size", "createdAt", "updatedAt", "tags": [] } },
  "flags": { "duress": true }          // key present ONLY in a duress vault's encrypted index
}
```
Strictly validated on load (UUID keys, types); any violation is treated as corruption.
Structured records (`putRecord`) are ordinary blobs with MIME `application/vnd.vaulty.record+json`.

### 4.5 `.vault` archive

```
offset  size   field
0       4      magic "VLT1" (0x56 0x4C 0x54 0x31)
4       1      version            = 1
5       1      flags              = 0 (reserved)
6       32     namespaceId        raw 32 bytes (hex-decoded PBKDF2 namespace id, §3.1)
38      2      patternEnvLen      u16 (= 82)
40      82     patternEnvelope
122     2      recoveryEnvLen     u16 (= 82)
124     82     recoveryEnvelope
206     4      indexLength        u32
210     L      index.enc          §4.1 payload, AAD = namespaceId
210+L   4      blobCount          u32
…       …      blob × blobCount:  uuid(16 raw) ‖ len u32 ‖ payload §4.1 (AAD = namespaceId ‖ id)
end−32  32     SHA-256 over every preceding byte
```
Parsing order: size → magic → checksum → version/flags → fields (every read bounds-checked, counts
sanity-checked against remaining bytes) → unwrap → authenticate **all** blobs → only then touch storage (R11.5).

### 4.6 Storage layout

```
OPFS    <root "vaulty">/<namespaceId>/keys.bin
                                    /index.enc
                                    /<crypto.randomUUID()>          one file per item
IDB     db "vaulty-store" / store "blobs" / key "<namespaceId>/<name>"
Memory  Map<namespaceId, Map<name, Uint8Array>>
```
No file outside a namespace container exists (R9.8).

## 5. Key flows

**unlock(pattern)** — validate → *(runtime duress match? ⇒ wipe, return `duress_triggered`; no KDF)* → `ns = PBKDF2_ns(pattern, kdfIterations)` (§3.1) →
read `keys.bin` → unwrap MVK → decrypt/validate `index.enc` →
* ok & `flags.duress` ⇒ wipe all, `duress_triggered`
* ok ⇒ session active, `created:false`
* missing / crypto failure ⇒ delete container, create vault: MVK, pattern envelope, recovery envelope+phrase,
  empty index → write `index.enc`, then `keys.bin`; `created:true`, phrase returned once.
Storage I/O errors (not crypto errors) propagate and are never converted into silent re-creation.

**configureDuress(D)** — requires session; `ns(D) ≠ active`; refuse to clobber unless `overwrite`; create a normal vault at
`ns(D)` whose index has `flags.duress`; wipe its transient MVK immediately.

**Duress wipe** — (1) synchronous: wipe MVK, drop index, stop guard, emit lock; (2) `Promise.allSettled` of
`adapter.purgeAll()` and `purgeEnvironment()` (Cache API, localStorage, sessionStorage, every IndexedDB database
incl. `indexedDB.databases()`, whole OPFS root); (3) return `{status:'duress_triggered'}`.

**exportArchive** — serialised with writes; copies ciphertext only (no decryption); progress `preparing 0 → exporting 5…95 → done 100`.

**importArchive** — parse+checksum → unwrap via pattern or phrase → decrypt index → authenticate every blob
(re-encrypting under the new AAD if `newPattern`) → commit: delete target container, write blobs, `index.enc`, `keys.bin` last →
activate session. Nothing is written if any step before commit fails.

## 6. Concurrency & lifecycle

* All mutating operations and `unlock`/`import`/`export` run through a single promise queue (`#exclusive`).
* `SessionGuard` owns visibility/pagehide/idle triggers; a lock wipes registered buffers *before* notifying.
* In-flight operations that outlive a lock fail with `VAULT_LOCKED` because `SecureBuffer.bytes` throws once wiped.
* The React hook unsubscribes and locks an owned client on unmount; supplied clients are untouched.

## 7. Threat model

| # | Adversary / scenario | Protection | Residual risk / limits |
|---|----------------------|-----------|------------------------|
| T1 | Steals device storage (OPFS/IDB dump), offline | Everything is AES-256-GCM; keys never stored; per-vault random MVK | Envelopes allow **offline guessing of the pattern**. Space for 6 distinct ordered nodes is 25·24·23·22·21·20 ≈ 1.3×10⁸ (≈2²⁷); at 600k PBKDF2 iterations that is ≈7.6×10¹³ HMAC-SHA-256 evaluations — expensive but feasible for a well-resourced attacker. Patterns are inherently low-entropy; the 99-bit recovery phrase is the strong secret. |
| T2 | Same, but attacker also holds an exported `.vault` file | Archive is as strong as T1; contains no plaintext metadata; its `namespaceId` is a PBKDF2 output (T3) | Same offline guessing; file reveals namespace id and blob count/sizes. |
| T3 | **Folder name (namespace id) as a pattern-confirmation oracle** — *hardened*. Previously `SHA-256("vaulty-ns:"+pattern)` let anyone listing folder names (or reading an archive header) confirm a short pattern with one hash, bypassing the 600k KDF (≤8 nodes ≈ 4.7×10¹⁰ candidates ⇒ minutes on a GPU). | Namespace id is now domain-separated PBKDF2-HMAC-SHA256 with the configured `kdfIterations` (default 600 000), §3.1. Per-guess cost from a folder name = per-guess cost from `keys.bin`; the folder name is no longer the weakest link (R2.7, R7.1). | (a) Pattern entropy itself is unchanged (T1): ≈2²⁷ for 6 nodes × 600k iterations is still feasible for a well-resourced attacker. (b) The salt is a **public constant**, so an attacker can pay once to precompute folder names for the most likely patterns and reuse that table against every user/install; the envelope's random salt does not allow this. A per-install salt would close it but needs a non-secret global file and breaks cross-device addressing — deferred. (c) `kdfIterations` is part of the vault address (§3.1). (d) One extra PBKDF2 on unlock (≈ +1 derivation latency). |
| T4 | Forensic examiner counts containers | Names are opaque PBKDF2 outputs; shapes are identical across real, decoy and duress vaults; no global index (R9.8) | Number of containers is observable and includes every pattern ever tried (decoys) and duress containers. File sizes/blob counts/timestamps leak coarse activity. |
| T5 | Coercion ("unlock it") | Unknown patterns open empty decoys with no error (R7.2); duress pattern wipes everything | Examiner who knows the product can demand *all* patterns. A runtime-option duress match returns faster (no KDF) than an in-vault duress or normal unlock — a timing difference visible to a local observer. Prefer in-vault duress where timing matters. |
| T6 | Memory inspection after lock / tab hide | MVK `fill(0)` on lock/hidden/pagehide/idle; per-op non-extractable CryptoKeys | JS strings (item names, decrypted JSON), GC copies, JIT, swap and `CryptoKey` internals cannot be zeroed. Bytes returned to the caller are the caller's responsibility. |
| T7 | Tampering / swapping ciphertext | GCM tags + AAD (namespace + id), archive checksum, strict parsers, iteration cap | A deliberate attacker with write access can delete or corrupt data (availability is not protected). |
| T8 | Corrupt namespace | Per R7.2 a namespace that fails authentication is silently re-created | **Data loss on corruption**: the old container is deleted. Mitigation: export archives regularly. |
| T9 | XSS / malicious extension / compromised OS / keylogger | Out of scope | Any script in the page can call the API after unlock. Serve with a strict CSP; the core performs no network I/O. |
| T10 | Cross-origin / other apps | Origin-private storage (OPFS/IDB are origin-scoped) | `purgeEnvironment` clears the whole origin's Cache/localStorage/sessionStorage/IDB/OPFS — by design destructive. |

## 8. Error model

`VaultyError.code` ∈ `INVALID_PATTERN | INVALID_RECOVERY_PHRASE | CRYPTO_FAILURE | VAULT_LOCKED | NOT_FOUND |
ARCHIVE_INVALID | STORAGE_ERROR | INVALID_ARGUMENT`. Messages never contain secrets, patterns or plaintext.
`unlock()` never throws `CRYPTO_FAILURE` for a wrong pattern (R7.2).

## 9. Testing strategy

Vitest (`environment: node`, jsdom for React) with `kdfIterations: 1000` in tests (dedicated tests assert the
600 000 default for envelopes **and** namespace ids, and cross-check namespace ids against Node's independent `pbkdf2Sync`). Suites: `crypto`, `vault`, `memory`, `storage` (contract suite × Memory/IndexedDB(fake-indexeddb)/OPFS mock),
`react`, and `security-check` (proves the static checker catches each violation class and that `src/` is clean).
