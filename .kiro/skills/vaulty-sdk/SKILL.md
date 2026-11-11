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

## 3. Building blocks (pick what the app needs)

All blocks assume `const { saveEncrypted, openEncrypted, lockVault, isUnlocked, namespaceId, VaultModal, vault } = useVaultDialog(opts);`
inside a component. Blocks 1–6 are the minimal integration; 7–14 are optional add-ons. When the user asks for "encrypted
save", start with 1, 2, 5 and the modal, then offer the rest.

| # | Block | Core call |
|---|---|---|
| 1 | Save encrypted | `saveEncrypted(name, data, mimeType?)` |
| 2 | Open encrypted | `openEncrypted(cb)` |
| 3 | Pattern lock | `<VaultModal />` or `<PatternGrid />` |
| 4 | Recovery phrase | automatic (modal) / `res.recoveryPhrase` |
| 5 | Lock + status | `lockVault()`, `isUnlocked`, `namespaceId` |
| 6 | Theme | `useVaultDialog({ title, theme })` |
| 7 | Gallery / list | `vault.entries` |
| 8 | Delete | `vault.deleteFile(id)` |
| 9 | Structured data | `vault.putRecord` / `vault.getRecord<T>` |
| 10 | Auto-lock | `idleTimeoutMs`, `lockOnHidden`, `vault.lastLockReason` |
| 11 | Ghost vaults | built in (no code) |
| 12 | Export backup | `vault.exportArchive()` |
| 13 | Import backup | `vault.importArchive(file, patternOrPhrase, { newPattern })` |
| 14 | Panic / duress | `vault.client.configureDuress(pattern)` — only on explicit request |

### 1 · Save encrypted
```tsx
// text / JSON — strings are encoded and wiped by the SDK
<button onClick={() => saveEncrypted('note.md', text)}>Save encrypted</button>
<button onClick={() => saveEncrypted('state.json', JSON.stringify(state), 'application/json')}>Save state</button>

// binary (canvas → PNG, File, audio …) — wipe the bytes you created
const saveCanvas = () => canvas.toBlob(async (blob) => {
  const bytes = new Uint8Array(await blob!.arrayBuffer());
  try { await saveEncrypted('sketch.png', bytes, 'image/png'); } finally { bytes.fill(0); }
}, 'image/png');
```
Resolves the stored `VaultMetadataEntry` (`{ id, name, mimeType, size, createdAt, updatedAt, tags }`) or `null` if cancelled.

### 2 · Open encrypted
```tsx
openEncrypted((f) => setText(f.text()));                       // text
openEncrypted((f) => setState(JSON.parse(f.text())));           // JSON
openEncrypted(async (f) => {                                    // image back onto a canvas
  try {
    const img = await createImageBitmap(new Blob([f.bytes as BlobPart], { type: f.mimeType }));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  } finally { f.bytes.fill(0); }
});
```
Resolves `true` if a file was opened, `false` if the browser was closed.

### 3 · Pattern lock
Default: render `<VaultModal />` once — it asks for the 5×5 pattern whenever a save/open needs it.
Own lock screen instead (use `useVault()` from `@vaulty/core/react`):
```tsx
<PatternGrid size={300} nodeColor="#52525B" activeColor="#F59E0B" lineColor="#F59E0B"
  onComplete={async (p) => { const res = await vault.unlock(p); /* see 4 */ }} />
```
Patterns need ≥ 6 distinct nodes (`minNodes`); `onError('too_short')` fires otherwise. Never log or store the pattern.

### 4 · Recovery phrase
The modal shows the 9-word phrase automatically for a brand-new vault and requires "I have written this down".
With your own screen: `if (res.status === 'unlocked' && res.created) showOnce(res.recoveryPhrase)` — keep it only in
component state, clear it when dismissed.

### 5 · Lock button + status
```tsx
<button onClick={lockVault} disabled={!isUnlocked}>Lock</button>
<span>{isUnlocked ? `Unlocked · ${namespaceId?.slice(0, 8)}` : 'Locked'}</span>
```
Locking wipes the key from memory. Drop any decrypted UI state (text, images) when `isUnlocked` becomes false.

### 6 · Theme / branding
```tsx
useVaultDialog({
  title: 'The Crypt',
  theme: { accent: '#ff7518', accentText: '#ffffff', background: '#1a1022', text: '#f5f5f5', mutedText: '#c4b5fd',
           border: '#3b1f4a', danger: '#b3001b', nodeColor: '#7c3aed', overlay: 'rgba(0,0,0,.7)',
           fontFamily: 'system-ui, sans-serif', radius: 12 },
});
```

### 7 · Gallery / list of saved items
```tsx
<ul>{vault.entries.map((e) => <li key={e.id}>{e.name} · {(e.size / 1024).toFixed(1)} kB</li>)}</ul>
```
`vault.entries` is live and empty while locked (names are encrypted at rest). Filter: `vault.refresh({ nameContains: 'sketch' })`.
To open a specific entry directly: `const { entry, data } = await vault.getFile(id)` (then `data.fill(0)` when done).

### 8 · Delete
```tsx
<button onClick={() => vault.deleteFile(e.id)}>Delete</button>   // resolves true if it existed
```
The modal's file browser already has a two-step delete.

### 9 · Structured data (typed JSON records)
```tsx
const rec = await vault.putRecord({ strokes, palette }, { name: 'drawing-1', tags: ['drawing'] });
const back = await vault.getRecord<{ strokes: Stroke[]; palette: string[] }>(rec.id);   // back.data
```
Requires an unlocked vault (e.g. after the first save/open, or your own `PatternGrid`).

### 10 · Auto-lock
```tsx
useVaultDialog({ idleTimeoutMs: 60_000, lockOnHidden: true });
// vault.lastLockReason: 'manual' | 'idle' | 'hidden' | 'pagehide' | null
{vault.lastLockReason === 'idle' && <p>Locked after inactivity.</p>}
```
Call `vault.touch()` on app activity that should count as "not idle" if the modal is not involved.

### 11 · Ghost vaults (plausible deniability)
No code. Every pattern opens its own vault; an unknown pattern silently creates an empty one. Never add a
"wrong pattern" message. Recommended copy: "Empty vault? Draw your pattern again — every pattern opens its own vault."

### 12 · Export backup (.vault)
```tsx
const exportBackup = async () => {
  const bytes = await vault.exportArchive();          // still fully encrypted
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart]));
  a.download = 'backup.vault';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
};
```
The modal's file browser also has an "Export .vault" button.

### 13 · Import / restore
```tsx
<input type="file" accept=".vault" onChange={async (ev) => {
  const file = ev.target.files?.[0]; if (!file) return;
  const res = await vault.importArchive(file, patternOrNineWords, { newPattern });   // newPattern optional
  // res = { status: 'imported', namespaceId, entryCount }; the vault is now unlocked
}} />
```
`patternOrNineWords` is the original pattern (`number[]`) or the 9-word phrase (string). Pass `newPattern` when restoring
with the phrase because the pattern was forgotten. Collect the pattern with a `<PatternGrid />`.

### 14 · Panic / duress pattern (only when explicitly requested)
```tsx
await vault.client.configureDuress(panicPattern);    // stored encrypted, looks like any other vault
// or at runtime: useVaultDialog({ duressPattern: panicPattern })
```
Drawing it wipes the key and **every vault and web storage on the origin**, then shows a normal lock screen
(`unlock()` returns `{ status: 'duress_triggered' }`). Warn the user; never use it on a shared demo origin.

### No React
```ts
import { VaultClient, createBestStorageAdapter } from '@vaulty/core';
const vault = new VaultClient({ adapter: () => createBestStorageAdapter({ rootName: 'my-app', dbName: 'my-app-vault' }) });
await vault.unlock([0, 1, 2, 3, 4, 9]);   // then putFile / getFile / putRecord / listEntries / exportArchive …
vault.lock();
```

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
