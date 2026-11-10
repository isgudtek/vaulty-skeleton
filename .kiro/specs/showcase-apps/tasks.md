# Tasks — Showcase apps (`GhostDrop` + `CryptKeep` + `InkVault`)

Legend: `[x]` = implemented **and** verified. Verification gate (all green at completion, from the repo root):
`npm install` · `npm run typecheck` · `npm run check:security` · `npm run test:all`
(220 core + 40 GhostDrop + 92 CryptKeep + 74 InkVault = 426 tests) · `npm run build:all` · `npm run e2e` (29 real-Chrome checks).
Phase 2 originally closed at 333 tests / 20 browser checks; the numbers above are the current state.
Requirement IDs refer to `requirements.md`.

## 0. Workspace & agentic setup
- [x] 0.1 Root `package.json`: workspaces `packages/*` + `apps/*`; scripts `dev:ghostdrop`, `dev:cryptkeep`, `build:all`, `test:all`, `typecheck`, `e2e`
- [x] 0.2 `.kiro/specs/showcase-apps/{requirements,design,tasks}.md` documenting SDK reuse without duplicated crypto/storage
- [x] 0.3 `.kiro/steering/app-boundaries.md` (apps hold no security logic; zero-what-you-own; lock-screen secrecy)
- [x] 0.4 Remove temporary `REPORT.txt`; fold its key metrics into the root `README.md`
- [x] 0.5 Verify `/.kiro` is fully tracked by git (`git ls-files .kiro`, `git check-ignore` returns nothing)
- [x] 0.6 `scripts/gen-icons.mjs` — dependency-free PNG icon generator (192/512) for both apps

## 1. GhostDrop (`apps/ghostdrop`) — binary & media field vault
- [x] 1.1 Vite 8 + React 19 + Tailwind 4 scaffold, strict TS, PWA manifest + service worker, production CSP (S3)
- [x] 1.2 Cyber-noir skin: obsidian `#090D16`, emerald status, monospace telemetry footer (S3.4)
- [x] 1.3 Lock screen with skinned `<PatternGrid />`, keyboard hints, storage-backend label; no wrong-pattern/decoy wording (S2.1–S2.3, S2.10)
- [x] 1.4 Namespace fingerprint badge + one-time 9-word recovery modal with "I have written this down" (S2.4–S2.6)
- [x] 1.5 Drag-and-drop / picker binary encryption via `putFile()`, plaintext zero-filled in `finally` (G1)
- [x] 1.6 Encrypted voice-note recorder (`MediaRecorder` → memory → `putFile`) with zero-filled buffers (G2)
- [x] 1.7 Zero-leak previewer: object URL created/revoked, lock on close, revoke on tab hide, no SVG (G3)
- [x] 1.8 Duress pattern setup (draw-twice) via `configureDuress()` + clean post-wipe lock screen + Quick Lock (G4, S2.9)
- [x] 1.9 `.vault` export/import (in-vault and from lock screen; pattern or phrase + new pattern) (G5, S4)
- [x] 1.10 Tests: format/files/recorder/sealClip lib tests, architecture guard, 16 jsdom UI flows → 38 tests

## 2. CryptKeep (`apps/cryptkeep`) — structured seed & 2FA vault
- [x] 2.1 Vite 8 + React 19 + Tailwind 4 scaffold, strict TS, PWA manifest + service worker, production CSP (S3)
- [x] 2.2 Industrial light/amber skin: `#F8FAFC` / `#18181B` / `#F59E0B`, LCD strips, hardware-keypad grid (S3.4)
- [x] 2.3 Lock screen with amber/carbon `<PatternGrid />`, visible `kbd` keyboard hints (S2.1–S2.3)
- [x] 2.4 "Recover Vault with 9-Word Phrase" flow: snapshot + phrase + new pattern (drawn twice) → `importArchive(..., {newPattern})` (C4)
- [x] 2.5 Seed manager: `putRecord<SeedEntry>`, 12/24-word + BIP-39 validation, masked words, per-word reveal, 10 s re-hide (C1)
- [x] 2.6 Clipboard guard: copy with visible countdown, auto-clear at exactly 15 s, Clear-now, clear on lock (C2)
- [x] 2.7 Live offline TOTP: `putRecord<TotpEntry>`, otpauth parsing, RFC 6238 via native HMAC, 30 s countdown ring (C3)
- [x] 2.8 Encrypted `.vault` snapshot export/restore of all records (C4.3, S4)
- [x] 2.9 Tests: RFC 4226/6238 vectors (+ independent SHA-256/512 reference), clipboard timing, records, architecture guard, 20 jsdom UI flows → 90 tests

## 3. Root README & verification
- [x] 3.1 `README.md` for Kiroween Skeleton Crew judges: overview, Mermaid architecture, security summary, honest limits, 5-minute quickstart, metrics
- [x] 3.2 `e2e/browser-check.mjs` + `npm run e2e`: 20 real-Chrome checks (OPFS plaintext scan, real PBKDF2, CSP, SW, microphone, clipboard, duress wipe, recovery)
- [x] 3.3 Screenshots captured from the real-browser run into `docs/screenshots/`
- [x] 3.4 `npm install`, `npm run typecheck`, `npm run test:all`, `npm run build:all` pass across `packages/core`, `apps/ghostdrop`, `apps/cryptkeep`
- [x] 3.5 Commit and push to `origin main`

## 4. Known limitations (see design.md §6)
- Whole-file in-memory encryption (SDK takes a `Uint8Array`); GhostDrop caps files at 512 MiB — chunked/streaming AEAD is future core work
- Decrypted strings (seed words, TOTP secrets, file names) cannot be zeroed in JS; byte arrays the apps own are
- `MediaRecorder` chunks are browser-owned `Blob`s: dropped, not zeroed
- Clipboard overwrite cannot detect whether the clipboard still holds the secret; OS clipboard history may retain it
- Phrase recovery needs the `.vault` file; the phrase alone cannot find a vault whose pattern is forgotten
- Real-browser coverage is Chrome only; Safari/Firefox (OPFS write paths, MediaRecorder codecs) are untested

## 5. InkVault (`apps/inkvault`) — drop-in "Save As Encrypted" Markdown scratchpad
- [x] 5.1 Vite + React + Tailwind scaffold matching GhostDrop/CryptKeep conventions (strict TS, architecture test, PWA, CSP); `base: process.env.VITE_BASE_PATH || '/'` (I5.1); root `dev:inkvault` script
- [x] 5.2 Editorial paper/slate/indigo skin (`#FAF9F6` / `#1E293B` / `#4F46E5`) and icon (S3.4)
- [x] 5.3 Normal mode first: split-pane editor + live preview, no lock screen; unload warning while dirty (I1.1–I1.3)
- [x] 5.4 Dependency-free, XSS-safe Markdown parser rendered to React elements (I1.4)
- [x] 5.5 Save to Encrypted Vault: pattern modal → one-time phrase banner → `putFile`; in-place updates; Ctrl/⌘+S (I2)
- [x] 5.6 Open from Vault: pattern → `listEntries()` browser → `getFile()` into the editor; delete; unsaved-change guard (I3)
- [x] 5.7 Lock Vault / tab hide / idle clears editor, preview, phrase in the same frame (I4) — real-browser bug fixed (deferred preview)
- [x] 5.8 Tests: 74 (architecture 13 · helpers 6 · Markdown 29 · lifecycle 26) + mutation checks; 9 real-Chrome checks incl. sub-path build
- Note: no ESLint config exists in GhostDrop/CryptKeep, so none was added; "conventions" = strict TS + architecture test + Vite/Tailwind layout

## 6. Shared-origin hardening & GitHub Pages
- [x] 6.1 Per-app storage roots `ghostdrop` / `cryptkeep` / `inkvault` (S1.7), guarded by architecture tests
- [x] 6.2 `base: process.env.VITE_BASE_PATH || '/'` in all three Vite configs, guarded by architecture tests (P1.1)
- [x] 6.3 `site/index.html` switch landing page: three launch cards, repo link, shared-origin/duress caveat, strict CSP (P2)
- [x] 6.4 `.github/workflows/deploy-pages.yml` (P1.2–P1.4) — its `run:` steps executed verbatim locally; `_site` served under `/vaulty-skeleton/` and checked in Chrome
- [x] 6.5 README: live demo links, three-app table and Mermaid diagram, `useVaultDialog()` 6-line quickstart first in Developer integration
- [x] 6.6 Live deployment verified on `https://isgudtek.github.io/vaulty-skeleton/`: workflow run green (build + deploy), every page/asset HTTP 200, and 15 real-Chrome checks on the live origin (service-worker scopes, 600k-PBKDF2 unlock in GhostDrop/CryptKeep with per-app OPFS roots, InkVault save → lock → open with no plaintext in OPFS)
