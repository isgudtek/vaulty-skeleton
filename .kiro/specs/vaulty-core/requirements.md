# Requirements — `@vaulty/core` (Phase 1)

Zero-knowledge, zero-runtime-dependency client-side vault SDK. All requirements use the
**EARS** (Easy Approach to Requirements Syntax) templates:

- Ubiquitous: `THE <system> SHALL <response>`
- Event-driven: `WHEN <trigger>, THE <system> SHALL <response>`
- State-driven: `WHILE <state>, THE <system> SHALL <response>`
- Unwanted behaviour: `IF <condition>, THEN THE <system> SHALL <response>`
- Optional feature: `WHERE <feature is included>, THE <system> SHALL <response>`

Glossary: **MVK** = Master Vault Key (random 256-bit AES-GCM key); **KEK** = key-encryption key
derived from a secret; **namespace** = `hex(PBKDF2-HMAC-SHA256("vaulty-ns:v2:" + normalizedPattern, salt = "vaulty-ns-salt:v2", kdfIterations))`;
**envelope** = an MVK wrapped under a KEK; **VaultClient** = the orchestrator in `src/vault.ts`.

---

## R1 — Pattern validation & normalisation

| ID | Requirement |
|----|-------------|
| R1.1 | THE SDK SHALL represent a pattern as an ordered sequence of integers in the range 0–24 identifying nodes of a 5×5 grid. |
| R1.2 | WHEN a pattern is supplied to any API, THE SDK SHALL reject it with `INVALID_PATTERN` IF it contains fewer than 6 nodes, more than 25 nodes, a repeated node, a non-integer, or a value outside 0–24. |
| R1.3 | THE SDK SHALL serialise a valid pattern deterministically as its nodes joined by `,` (order-sensitive). |
| R1.4 | IF a pattern is invalid, THEN THE SDK SHALL reject it before performing any storage I/O or key derivation. |

## R2 — Key derivation

| ID | Requirement |
|----|-------------|
| R2.1 | THE SDK SHALL derive every KEK with PBKDF2-HMAC-SHA256 through `globalThis.crypto.subtle`. |
| R2.2 | THE SDK SHALL default to 600 000 PBKDF2 iterations and SHALL allow the count to be overridden through options (intended for fast unit tests only). |
| R2.3 | WHEN a KEK is derived for a new envelope, THE SDK SHALL use a fresh random 16-byte salt from `crypto.getRandomValues`. |
| R2.4 | THE SDK SHALL create KEKs and MVK-derived `CryptoKey`s as non-extractable AES-256-GCM keys. |
| R2.5 | THE SDK SHALL domain-separate KDF inputs (`vaulty-pattern:v1:` for patterns, `vaulty-recovery:v1:` for phrases, `vaulty-ns:v2:` for namespace ids) from one another. |
| R2.6 | IF an envelope read from storage or an archive declares fewer than 1 or more than 10 000 000 iterations, THEN THE SDK SHALL reject it without deriving a key (CPU-exhaustion guard). |
| R2.7 | THE SDK SHALL derive every namespace id (the on-disk folder name) with PBKDF2-HMAC-SHA256 over the domain-separated pattern, using the same configured `kdfIterations` as the key envelopes (default 600 000) and a constant public domain-separated salt, so that confirming a pattern from a folder name costs at least as much as attacking the key envelope. |
| R2.8 | IF the `kdfIterations` supplied for namespace derivation is not an integer between 1 and 10 000 000, THEN THE SDK SHALL reject it with `INVALID_ARGUMENT`. |

## R3 — Master key generation & wrapping

| ID | Requirement |
|----|-------------|
| R3.1 | WHEN a vault is created, THE SDK SHALL generate a 256-bit MVK from `crypto.getRandomValues`. |
| R3.2 | THE SDK SHALL wrap the MVK with the pattern-derived KEK using AES-256-GCM and a unique random 12-byte IV, producing a `WrappedKeyEnvelope {salt, iv, wrappedKeyBytes, kdfIterations}`. |
| R3.3 | WHEN a vault is created, THE SDK SHALL additionally wrap the same MVK in an independent recovery envelope (own salt, IV and KEK). |
| R3.4 | THE SDK SHALL bind each envelope to its role (`pattern` or `recovery`) as AES-GCM additional authenticated data so that one role cannot open the other. |
| R3.5 | IF an envelope's salt, IV, wrapped bytes or iteration count have been altered, or the wrong secret is supplied, THEN THE SDK SHALL fail with `CRYPTO_FAILURE` and SHALL NOT distinguish the two causes. |

## R4 — 9-word recovery phrase

| ID | Requirement |
|----|-------------|
| R4.1 | THE SDK SHALL embed the canonical 2048-word BIP-39 English wordlist in `src/wordlist.ts` and SHALL NOT fetch it at runtime. |
| R4.2 | WHEN a vault is created, THE SDK SHALL generate a recovery phrase of exactly 9 words, each chosen uniformly (11 bits) from the wordlist using `crypto.getRandomValues`. |
| R4.3 | WHEN a vault is created, THE SDK SHALL return the phrase to the caller exactly once and SHALL NOT persist it anywhere. |
| R4.4 | WHEN a phrase is supplied for recovery, THE SDK SHALL normalise case and whitespace and SHALL reject it with `INVALID_RECOVERY_PHRASE` IF it does not consist of exactly 9 wordlist words. |

## R5 — Authenticated encryption

| ID | Requirement |
|----|-------------|
| R5.1 | THE SDK SHALL encrypt all payloads with AES-256-GCM and output `IV(12) ‖ ciphertext ‖ tag(16)`. |
| R5.2 | WHEN `encryptBytes` is called, THE SDK SHALL draw a fresh 12-byte IV from `crypto.getRandomValues` for that call and SHALL NOT reuse or derive IVs. |
| R5.3 | THE SDK SHALL bind every stored blob to its vault namespace **and** item id, and the index to its namespace, via AAD. |
| R5.4 | IF a ciphertext is altered, truncated, decrypted under a different AAD, or decrypted with a different key, THEN THE SDK SHALL fail with `CRYPTO_FAILURE` and SHALL NOT return partial plaintext. |
| R5.5 | IF a wiped key buffer is passed to an encryption or decryption helper, THEN THE SDK SHALL throw `VAULT_LOCKED` rather than operate on zeroed key bytes. |

## R6 — Volatile-memory hygiene

| ID | Requirement |
|----|-------------|
| R6.1 | THE SDK SHALL hold the MVK in a `SecureBuffer` whose `wipe()` overwrites the backing `Uint8Array` with `fill(0)` and records `isWiped`. |
| R6.2 | WHEN the vault is locked for any reason, THE SDK SHALL wipe the MVK and discard the decrypted metadata index. |
| R6.3 | WHEN `document.visibilitychange` reports the document hidden, THE SessionGuard SHALL lock the vault. |
| R6.4 | WHEN `window.pagehide` fires, THE SessionGuard SHALL lock the vault. |
| R6.5 | WHERE an idle timeout is configured, THE SessionGuard SHALL lock the vault after that many milliseconds without activity and SHALL reset the timer on user activity or `touch()`. |
| R6.6 | WHILE running without `document`/`window` (SSR, Node), THE SessionGuard SHALL construct and operate without throwing. |
| R6.7 | THE SDK SHALL NOT write plaintext, key material or the pattern to `localStorage`, `sessionStorage` or cookies. |

## R7 — Plausible-deniability routing

| ID | Requirement |
|----|-------------|
| R7.1 | WHEN `unlock(pattern)` is called, THE VaultClient SHALL compute the namespace id from the normalised pattern per R2.7 and attempt to unwrap the key envelope stored in that namespace. |
| R7.2 | IF the namespace does not exist, or its envelope or index cannot be decrypted, THEN THE VaultClient SHALL silently create a fresh empty vault under that namespace and report `status: 'unlocked'`, and SHALL NOT raise any "invalid pattern" or "wrong password" error. |
| R7.3 | THE VaultClient SHALL give vaults under different patterns disjoint keys, indexes and blobs, such that unlocking one reveals nothing about another. |
| R7.4 | THE SDK SHALL give real vaults, decoy vaults and duress vaults an identical on-disk shape (`keys.bin` of constant length and `index.enc`, plus UUID-named blobs). |
| R7.5 | WHEN a new vault is created by `unlock`, THE VaultClient SHALL return its recovery phrase in the result. |

## R8 — Duress engine

| ID | Requirement |
|----|-------------|
| R8.1 | WHERE a `duressPattern` runtime option is supplied, THE VaultClient SHALL, WHEN `unlock` receives that pattern, perform the duress wipe before reading any vault data or deriving any key. |
| R8.2 | THE VaultClient SHALL allow a duress pattern to be registered from an unlocked vault by creating a vault under the duress pattern's namespace whose **encrypted** index carries the duress flag. |
| R8.3 | THE SDK SHALL NOT write any plaintext marker, file, flag or key that identifies a duress configuration. |
| R8.4 | WHEN `unlock` opens a vault whose encrypted index carries the duress flag, THE VaultClient SHALL perform the duress wipe. |
| R8.5 | WHEN the duress wipe runs, THE VaultClient SHALL, in this order: wipe the active key buffer and metadata synchronously; then purge all storage-adapter namespaces, the OPFS root, all IndexedDB databases, all Cache API entries, `localStorage` and `sessionStorage`; then return `{ status: 'duress_triggered' }`. |
| R8.6 | IF one purge step fails, THEN THE VaultClient SHALL still attempt every other step (fail-open). |
| R8.7 | THE VaultClient SHALL refuse to register a duress pattern equal to the active vault's pattern, and SHALL refuse to overwrite an existing vault unless `overwrite: true` is passed. |
| R8.8 | THE VaultClient SHALL provide `removeDuress(pattern)` that deletes a duress vault and SHALL NOT delete a non-duress vault. |

## R9 — Storage adapters

| ID | Requirement |
|----|-------------|
| R9.1 | THE SDK SHALL define a `StorageAdapter` contract (`put/get/delete/list/hasNamespace/listNamespaces/deleteNamespace/purgeAll`) that handles only ciphertext and public envelopes. |
| R9.2 | THE OPFSStorageAdapter SHALL store each blob as a file under `<root>/<namespace>/<name>` using `navigator.storage.getDirectory()`, with item names being `crypto.randomUUID()` values. |
| R9.3 | WHERE `createWritable` is unavailable, THE OPFSStorageAdapter SHALL fall back to `createSyncAccessHandle`. |
| R9.4 | THE IndexedDBStorageAdapter SHALL provide the same contract over raw IndexedDB and SHALL tolerate its database being deleted by another context. |
| R9.5 | THE MemoryStorageAdapter SHALL provide the same contract in volatile memory for tests and ephemeral sessions. |
| R9.6 | WHEN `createBestStorageAdapter()` is called, THE SDK SHALL probe OPFS with a real write/read/delete and fall back to IndexedDB, then to memory, without throwing. |
| R9.7 | IF a namespace or object name is not `[A-Za-z0-9._-]{1,128}` or is `.`/`..`, THEN every adapter SHALL reject it with `INVALID_ARGUMENT`. |
| R9.8 | THE SDK SHALL NOT write any unencrypted global metadata file, index or flag (vault list, vault names, duress configuration, last-used vault) to any store. The mere existence of one opaque namespace container per vault is an accepted residual (see design.md §7, T4). |

## R10 — Encrypted metadata index & item API

| ID | Requirement |
|----|-------------|
| R10.1 | THE VaultClient SHALL keep a per-vault `index.enc` (AES-256-GCM, namespace-bound AAD) mapping UUIDs to `VaultMetadataEntry` values. |
| R10.2 | THE VaultClient SHALL provide `putFile`, `getFile`, `deleteFile`, `putRecord<T>`, `getRecord<T>` and `listEntries`. |
| R10.3 | WHEN an item is overwritten by id, THE VaultClient SHALL preserve `createdAt`, update `updatedAt` and re-encrypt with a fresh IV. |
| R10.4 | WHILE the vault is locked, THE VaultClient SHALL reject every item operation with `VAULT_LOCKED`. |
| R10.5 | THE VaultClient SHALL serialise mutations so concurrent writes cannot lose index updates. |
| R10.6 | IF a caller supplies an item id that is not a lowercase UUID, THEN THE VaultClient SHALL reject it with `INVALID_ARGUMENT` (path-traversal guard). |

## R11 — Portable `.vault` archives

| ID | Requirement |
|----|-------------|
| R11.1 | WHEN `exportArchive(onProgress?)` is called on an unlocked vault, THE VaultClient SHALL return a self-contained binary starting with magic `VLT1`, a version byte, both wrapped envelopes, the encrypted index, the encrypted blobs and a trailing SHA-256 checksum. |
| R11.2 | THE archive SHALL contain no plaintext file names, tags, MIME types or contents. |
| R11.3 | WHEN `importArchive(bundle, patternOrPhrase, onProgress?)` is called, THE VaultClient SHALL open the archive with either the vault's pattern or its 9-word recovery phrase. |
| R11.4 | WHERE `newPattern` is supplied to `importArchive`, THE VaultClient SHALL re-key the imported vault into the namespace of the new pattern, re-encrypting blobs and index under the new AAD. |
| R11.5 | IF the archive has a bad magic, unsupported version, checksum mismatch, truncation, or any blob/index that fails authentication, THEN THE VaultClient SHALL reject it with `ARCHIVE_INVALID` before writing anything to storage. |
| R11.6 | IF the supplied pattern or phrase cannot open the archive, THEN THE VaultClient SHALL fail with `CRYPTO_FAILURE` before writing anything to storage. |
| R11.7 | WHEN an import succeeds, THE VaultClient SHALL leave the client unlocked on the imported vault and SHALL write `keys.bin` last. |
| R11.8 | THE VaultClient SHALL report progress through `ProgressCallback(stage, percent)` with non-decreasing percentages ending at 100. |

## R12 — Packaging & React bindings

| ID | Requirement |
|----|-------------|
| R12.1 | THE package SHALL have no runtime `dependencies`. |
| R12.2 | THE package SHALL ship ESM, CJS and `.d.ts` outputs with exports `"."` and `"./react"`. |
| R12.3 | THE package SHALL declare `react` as an optional peer dependency and the build SHALL keep `react` external. |
| R12.4 | THE `./react` entry SHALL provide `useVault(options)` (lock state, auto-lock, progress, CRUD helpers), an accessible, responsive 5×5 SVG `<PatternGrid />` skinnable via `size`, `nodeColor`, `activeColor`, `lineColor` and `className`, and the plug-and-play `useVaultDialog()` (R12.7–R12.12). |
| R12.5 | WHEN the vault locks, `useVault` SHALL clear decrypted metadata from React state. |
| R12.6 | THE `<PatternGrid />` SHALL be operable by pointer, touch and keyboard, and its live region SHALL announce only the number of selected nodes. |
| R12.7 | THE `./react` entry SHALL provide `useVaultDialog(options?)` returning `{ saveEncrypted, openEncrypted, lockVault, isUnlocked, namespaceId, VaultModal, vault }`, where `VaultModal` is a component identity that is stable across renders. |
| R12.8 | WHEN `saveEncrypted(filename, data, mimeType?)` is called while locked, THE dialog SHALL show `<PatternGrid />`; WHEN that unlock creates a new vault, THE dialog SHALL show the 9-word recovery phrase and SHALL NOT encrypt until the user confirms it; THEN it SHALL store the data with `putFile()` and close. WHILE unlocked it SHALL store immediately without showing the modal. |
| R12.9 | WHEN `openEncrypted(onSelect)` is called, THE dialog SHALL (after unlocking if needed) list entries via `listEntries()` with a two-step delete and an "Export .vault" action; WHEN the user picks an entry it SHALL decrypt it with `getFile()`, call `onSelect({ id, name, mimeType, size, bytes, text })`, and close. |
| R12.10 | THE dialog SHALL never mutate the caller's `Uint8Array`; it SHALL encrypt its own copy and zero-fill that copy once stored or cancelled. |
| R12.11 | IF the user cancels, the vault locks while the modal is past the unlock step, the duress pattern is entered, or the host unmounts, THEN the pending promise SHALL settle (`null` / `false`) and nothing SHALL be stored. Escape SHALL cancel on every step except the recovery-phrase step. |
| R12.12 | THE `<VaultModal />` SHALL use inline styles only (no CSS classes, no stylesheet, no CSS framework), SHALL be a labelled `aria-modal` dialog that moves focus inside, and SHALL be themeable via `options.theme`. |
| R12.13 | THE `<VaultModal />` SHALL render through `createPortal(…, document.body)` and SHALL render inline only WHERE `document` is undefined (SSR). |
| R12.14 | WHILE the modal is open, THE dialog SHALL trap Tab / Shift+Tab inside the panel (wrapping at both ends), SHALL pull focus back if it moves outside, SHALL focus the pattern grid (or the step's primary control) first, and SHALL restore focus to the previously focused element WHEN it closes. |
| R12.15 | THE source of `src/react/index.ts` and `src/react/dialog.tsx` SHALL begin with `'use client'`, AND THE built `dist/react.js` / `dist/react.cjs` SHALL begin with `"use client";` (re-inserted after bundling, with source maps shifted accordingly), so the entry works with Next.js App Router Server Components. |
| R12.16 | `@vaulty/core/react` SHALL server-render (Node, no DOM) without throwing or logging errors. |

## R14 — Installability outside the monorepo

| ID | Requirement |
|----|-------------|
| R14.1 | THE package SHALL define `"prepare": "npm run build"` so that `npm pack`, workspace installs and Git-based installs produce `dist/` automatically, with `tsup` and `typescript` pinned in `devDependencies`. |
| R14.2 | THE packed tarball SHALL contain only `package.json`, `README.md`, `LICENSE` and `dist/` (no source, tests, scripts or configs). |
| R14.3 | THE package SHALL declare `react` and `react-dom` (≥ 18) as optional peer dependencies and SHALL keep them external in the build. |
| R14.4 | `npm run verify:pack` SHALL install the tarball into standalone projects outside the repository (Vite + React 19; optionally React 18 and Next.js App Router), type-check them strictly, build them, and exercise the 6-line `useVaultDialog()` integration in a real browser where available. |
| R14.5 | THE documentation SHALL state only install methods that have been verified, and SHALL state that `npm install github:…` cannot install a sub-folder of this repository. |

## R13 — Tooling guard

| ID | Requirement |
|----|-------------|
| R13.1 | THE repository SHALL provide `npm run check:security`, which statically rejects storage reads/writes via `localStorage`/`sessionStorage`, cookies, `Math.random`, weak algorithms, `exportKey`, extractable keys, literal/zero IVs, `console.*`, `eval`, and network I/O in `packages/core/src`. |
| R13.2 | WHEN a file matching `packages/core/src/**/*.ts` is saved, THE Kiro hook `core-security-check` SHALL cause that check to run on the file. |
