# App boundaries for the Vaulty showcase apps

These rules apply to everything under `apps/`. They complement `crypto-invariants.md` (which still applies in full).

1. **The SDK does the security.** `apps/ghostdrop` and `apps/cryptkeep` import only from `@vaulty/core` and
   `@vaulty/core/react` (plus `react`, `react-dom`, and local files). If a feature seems to need encryption, key handling,
   randomness, storage, or an archive format, add it to `packages/core` — never to an app.
2. **No new runtime dependencies in apps.** Runtime deps stay at `@vaulty/core`, `react`, `react-dom`. Tooling is devDependencies only.
3. **Only one app-side crypto primitive is allowed:** HMAC `sign` for RFC 6238 in `apps/cryptkeep/src/lib/totp.ts`.
4. **No web storage, no network I/O for user data, no `console.*`, no `Math.random`** in app code.
5. **Zero what you own.** Any `Uint8Array` an app creates from plaintext (file bytes, audio, decrypted blobs) is `.fill(0)`'d in a
   `finally` once it has been handed on. Decrypted UI state is dropped when the vault locks.
6. **Never leak vault existence.** The lock screen must not show "wrong pattern" wording, and after a duress wipe it must show no
   wording about duress or destruction.
7. **Keep the guard tests green.** `tests/architecture.test.ts` in each app encodes rules 1–4; do not weaken it to make a change pass.
8. Before declaring work done: `npm run typecheck`, `npm run test:all`, `npm run build:all` from the repo root; run `npm run e2e` when UI,
   storage, or lock behaviour changed.
