---
name: vaulty-sdk
description: Install and use @vaulty/core, the zero-knowledge client-side vault SDK, to add "Save encrypted" / "Open encrypted" (pattern-locked, AES-256-GCM, OPFS/IndexedDB) to a web app. Use when asked to add encryption, an encrypted save/open, a vault, or @vaulty/core to a React (or plain TypeScript) app.
---

# Vaulty SDK (`@vaulty/core`)

Adds an encrypted, pattern-locked file store to any browser app. Everything stays on the device; the SDK has zero
runtime dependencies and does no network I/O. React entry: `@vaulty/core/react` (React 18 or 19 + `react-dom`).

## 1. Install (from GitHub — not on the npm registry)

**pnpm (fastest).** pnpm must be allowed to run the package's `prepare` build:

```bash
printf 'onlyBuiltDependencies:\n  - "@vaulty/core"\n' >> pnpm-workspace.yaml
pnpm add "github:isgudtek/vaulty-skeleton#path:/packages/core"
```

**npm / yarn (tarball).** `npm install github:isgudtek/vaulty-skeleton` does NOT work (npm cannot install a repo sub-folder):

```bash
git clone --depth 1 https://github.com/isgudtek/vaulty-skeleton.git /tmp/vaulty
(cd /tmp/vaulty && npm ci && npm pack --workspace @vaulty/core)   # → vaulty-core-0.1.0.tgz
npm install /tmp/vaulty/vaulty-core-0.1.0.tgz
```

Check: `node_modules/@vaulty/core/dist/react.js` exists. If `dist/` is missing with pnpm, the allow-list was not applied.

## 2. The 6-line integration (React)

```tsx
import { useVaultDialog } from '@vaulty/core/react';

const { saveEncrypted, openEncrypted, VaultModal } = useVaultDialog();   // inside a component
<button onClick={() => saveEncrypted('note.md', text)}>Save encrypted</button>
<button onClick={() => openEncrypted((file) => setText(file.text()))}>Open encrypted</button>
<VaultModal />                                                          // render exactly once
```

The modal handles everything: 5×5 pattern grid, one-time 9-word recovery phrase for a new vault, encrypted file browser
(delete + `.vault` export). No CSS needed.

API: `saveEncrypted(name, data: string | Uint8Array, mimeType?)` → entry or `null` (cancelled) ·
`openEncrypted(cb)` → `cb({ id, name, mimeType, size, bytes, text() })` · `lockVault()` · `isUnlocked` · `namespaceId` ·
`vault` (the full `useVault()` result).

## 3. Recipes

**Binary (canvas → PNG):**

```tsx
const save = () => canvas.toBlob(async (blob) => {
  const bytes = new Uint8Array(await blob!.arrayBuffer());
  try { await saveEncrypted('sketch.png', bytes, 'image/png'); } finally { bytes.fill(0); }
}, 'image/png');

const open = () => openEncrypted(async (f) => {
  const img = await createImageBitmap(new Blob([f.bytes as BlobPart], { type: f.mimeType }));
  f.bytes.fill(0);
  ctx.drawImage(img, 0, 0);
});
```

**JSON:** `saveEncrypted('state.json', JSON.stringify(state))` and `openEncrypted(f => setState(JSON.parse(f.text())))`,
or typed records via `vault.putRecord(obj, { name, tags })` / `vault.getRecord<T>(id)`.

**Options:** `useVaultDialog({ title, theme: { accent, background, text, mutedText, border, nodeColor, fontFamily, radius },
idleTimeoutMs, lockOnHidden, adapter, duressPattern })`.

**More (on `vault`):** `entries` (live list, cleared on lock), `deleteFile(id)`, `exportArchive()` → `.vault` bytes,
`importArchive(file, patternOrPhrase, { newPattern })`, `lastLockReason`, `client.configureDuress(pattern)` (wipes the
whole origin — only add when explicitly requested).

**Custom lock screen:** `useVault()` + `<PatternGrid onComplete={(p) => vault.unlock(p)} />`.
**No React:** `new VaultClient({ adapter: await createBestStorageAdapter({ rootName: 'my-app' }) })` from `@vaulty/core`.

## 4. Rules

- Render `<VaultModal />` once. Call hooks in a `'use client'` component on Next.js.
- `fill(0)` every `Uint8Array` you create from plaintext once it has been handed to the SDK, and the `bytes` you receive.
- Never put plaintext or patterns in `localStorage`, `sessionStorage` or cookies; never log them.
- Several apps on one origin: give each its own storage root,
  `useVaultDialog({ adapter: () => createBestStorageAdapter({ rootName: 'my-app', dbName: 'my-app-vault' }) })`.
- Never add a "wrong pattern" check: any pattern opens its own (possibly empty) vault by design. Use copy like
  "Empty vault? Draw your pattern again."
- Strict CSP needs `style-src 'self' 'unsafe-inline'` (the modal uses inline styles).

## 5. Verify

1. Typecheck (`npx tsc -b` or `npm run typecheck`).
2. Run on `http://localhost` or HTTPS — Web Crypto does not exist on plain HTTP (e.g. a LAN IP).
3. In the browser: save → enter a pattern (≥ 6 nodes) → confirm the phrase → reload → open → data is back.
4. Optional: DevTools → Application → OPFS / IndexedDB shows only unreadable bytes.
