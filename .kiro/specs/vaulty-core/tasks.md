# Tasks — `@vaulty/core` (Phase 1)

Legend: `[x]` = implemented **and** verified (`npm run typecheck`, `npm run check:security`, `npm test`, `npm run build`
all green in `packages/core`). Requirement IDs refer to `requirements.md`.

## 0. Workspace & agentic setup
- [x] 0.1 Root `package.json` with npm workspaces (`packages/*`), root scripts delegating to `@vaulty/core`
- [x] 0.2 `tsconfig.base.json` with `strict: true` (+ `noUncheckedIndexedAccess`, `noUnusedLocals`, `isolatedModules`)
- [x] 0.3 MIT `LICENSE`
- [x] 0.4 `.gitignore` that never ignores `/.kiro` (verified with `git check-ignore`)
- [x] 0.5 `.kiro/specs/vaulty-core/requirements.md` (EARS, R1–R13)
- [x] 0.6 `.kiro/specs/vaulty-core/design.md` (architecture, byte layouts, threat model)
- [x] 0.7 `.kiro/steering/crypto-invariants.md` (4 invariants + working rules)
- [x] 0.8 `.kiro/hooks/core-security-check.kiro.hook` (fileEdited on `packages/core/src/**/*.ts`)

## 1. Package scaffolding
- [x] 1.1 `packages/core/package.json`: ESM+CJS, subpath exports `.` and `./react`, no runtime deps, optional `react` peer (R12.1–R12.3)
- [x] 1.2 `tsup.config.ts`: dual format + `.d.ts`, `external: ['react']`, code splitting
- [x] 1.3 `vitest.config.ts` + `tests/setup.ts` (guarantees `globalThis.crypto`)
- [x] 1.4 `scripts/check-security.mjs` static hygiene checker + `npm run check:security` (R13)

## 2. SDK modules
- [x] 2.1 `src/types.ts` — `PatternNode`, `VaultMetadataEntry`, `VaultRecord<T>`, `WrappedKeyEnvelope`, `VaultArchiveHeader`, `ProgressCallback`, `StorageAdapter`, `VaultyError`
- [x] 2.2 `src/bytes.ts` — bounds-checked reader/writer, hex/UUID/UTF-8, realm-safe type guards
- [x] 2.3 `src/wordlist.ts` — canonical 2048-word BIP-39 list (hash-pinned) (R4.1)
- [x] 2.4 `src/memory.ts` — `SecureBuffer` (`fill(0)`, `isWiped`) and `SessionGuard` (visibilitychange, pagehide, idle; SSR-safe) (R6)
- [x] 2.5 `src/crypto.ts` — pattern validation/serialisation, namespace id, PBKDF2-SHA256 (600 000 default) KEK, MVK generation + pattern/recovery envelopes, 9-word phrase, `encryptBytes`/`decryptBytes` with AAD, envelope codec (R1–R5)
- [x] 2.6 `src/storage.ts` — `MemoryStorageAdapter`, `OPFSStorageAdapter` (with sync-handle fallback), `IndexedDBStorageAdapter`, `createBestStorageAdapter()` probing, `purgeEnvironment()` (R9)
- [x] 2.7 `src/vault.ts` — `VaultClient`: plausible-deniability `unlock`, duress engine (runtime + encrypted in-vault), encrypted index, file/record CRUD, `.vault` export/import with recovery-phrase and re-key (R7, R8, R10, R11)
- [x] 2.8 `src/react/index.ts` — `useVault`, accessible `PatternGrid` (pointer/touch/keyboard), geometry helpers (R12.4–R12.6)
- [x] 2.9 `src/index.ts` — public barrel (does not import `react`)

## 3. Test milestones
- [x] 3.1 `tests/crypto.test.ts` — PBKDF2 wrap/unwrap, 9-word phrase unwrap, unique IVs over 100 encryptions (+ `getRandomValues` spy), AAD tamper/swap rejection, bit-flip rejection, envelope codec, `SecureBuffer.wipe()` zero-fill
- [x] 3.2 `tests/vault.test.ts` — multi-vault plausible-deniability isolation, silent init of unknown pattern, encrypted file + JSON record CRUD, `.vault` round-trip (pattern **and** 9-word phrase, with re-key), corrupt/tampered archive rejection, duress purge (adapter, IndexedDB, OPFS, Cache API, localStorage, sessionStorage), in-vault encrypted duress on a cold client, zero-leak storage layout scan
- [x] 3.3 `tests/memory.test.ts` — `SessionGuard` hidden/pagehide/idle/activity/SSR
- [x] 3.4 `tests/storage.test.ts` — shared adapter contract × Memory / IndexedDB (fake-indexeddb) / OPFS mock, name-safety, probing/fallback, `purgeEnvironment`
- [x] 3.5 `tests/react.test.ts` — SSR render, pointer + keyboard pattern entry, `useVault` lifecycle (jsdom)
- [x] 3.6 `tests/security-check.test.ts` — checker catches every violation class; real `src/` is clean

## 4. Verification gate
- [x] 4.1 `npm run typecheck` — 0 errors under `strict`
- [x] 4.2 `npm run check:security` — clean
- [x] 4.3 `npm test` — all suites green
- [x] 4.4 `npm run build` — ESM + CJS + d.ts for `.` and `./react`; `react` not bundled
- [x] 4.5 Built-artifact smoke test (ESM and CJS) with production 600 000-iteration defaults

## 6. Plug-and-play dialog (`useVaultDialog`, R12.7–R12.12)
- [x] 6.1 Split `src/react/index.ts` → `core.ts` (useVault, PatternGrid) + `dialog.tsx`, re-exported from `index.ts` (no circular import)
- [x] 6.2 `useVaultDialog()` with stable `<VaultModal />` fed by a tiny external store (`useSyncExternalStore`)
- [x] 6.3 Steps: unlock grid → one-time recovery phrase (blocks Escape) → save; file browser with delete + `.vault` export
- [x] 6.4 Inline-styles-only, themeable modal; `react/jsx-runtime` kept external in the build; `check:security` + Kiro hook cover `.tsx`
- [x] 6.5 15 tests in `tests/react.test.ts` (save/recovery/open/delete/export/cancel/lock-abort/duress/theme/unmount/render-loop) → core 220 tests
- [x] 6.6 The README's 6-line snippet built as a throwaway app and driven in real Chrome (save → recovery → OPFS ciphertext → open)

## 7. External installability & dialog hardening (R12.13–R12.16, R14)
- [x] 7.1 `prepare: npm run build`; repository metadata; package `README.md` + `LICENSE`; `react-dom` optional peer (R14.1–R14.3)
- [x] 7.2 `'use client'` in source; post-build re-insertion into `dist/react.{js,cjs}` with source maps shifted one line; idempotent (R12.15)
- [x] 7.3 Portal into `document.body` (SSR-guarded); Tab/Shift+Tab trap; focus containment; grid-first initial focus; focus restore (R12.13–R12.14)
- [x] 7.4 Tests: portal, 4 focus-management tests, 3 SSR tests in a DOM-less Node environment → core 228; portal / trap / restore each mutation-checked
- [x] 7.5 `scripts/verify-pack.mjs` (`npm run verify:pack -- --all`): 47/47 — tarball audit; standalone Vite + React 19 / React 18 and Next.js 16 projects; strict typecheck; Node ESM+CJS; builds; real Chrome (R14.4)
- [x] 7.6 Git installs verified: fresh clone + `npm ci` runs `prepare`; pnpm 10 `#path:/packages/core` install works with the `onlyBuiltDependencies` allow-list (the public `github:` form verified after push)
- [x] 7.7 README install / requirements / CSP / Next.js / empty-vault guidance (R14.5)

## 5. Known limitations carried to later phases (see design.md §7)
- [x] 5.0 T3 hardened: namespace id = domain-separated PBKDF2-HMAC-SHA256 with the configured `kdfIterations` (default 600 000) — R2.7/R2.8, design §3.1; tests cross-check against Node `pbkdf2Sync` and assert iteration counts
- Residual after T3: the namespace salt is a public constant (precomputation across installs is possible) → candidate hardening: per-install salt (needs a non-secret global file; breaks cross-device addressing)
- `kdfIterations` is now part of the vault address; changing it requires export + import with `newPattern`
- Silent re-creation of an undecryptable namespace deletes the old container (T8) → regular `.vault` exports recommended
- Coverage is high but not 100% (branches around defensive error paths); no mutation testing yet
