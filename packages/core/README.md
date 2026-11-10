# @vaulty/core

Zero-knowledge, zero-runtime-dependency vault SDK for the browser: pattern-derived keys (PBKDF2-HMAC-SHA256 × 600,000),
a random AES-256-GCM master key, plausible-deniability vaults, a duress wipe, OPFS/IndexedDB storage and portable
encrypted `.vault` archives. Optional React bindings in `@vaulty/core/react`.

> Not published to the npm registry yet. See **Install** for the ways that work today.

## Install

```bash
# 1) Build a tarball from the repository (works with npm, pnpm and yarn)
git clone https://github.com/isgudtek/vaulty-skeleton.git
cd vaulty-skeleton && npm ci                      # `prepare` builds dist/
npm pack --workspace @vaulty/core                  # → vaulty-core-0.1.0.tgz

# 2) In your app
npm install /path/to/vaulty-core-0.1.0.tgz
```

`npm install github:isgudtek/vaulty-skeleton` does **not** work: npm cannot install a sub-folder of a Git repository, and the
repository root is a private monorepo. pnpm can — see the repository README for the exact command.

Requirements: a browser **secure context** (HTTPS or `http://localhost`), because Web Crypto's `crypto.subtle` is unavailable
elsewhere. For the React entry: React 18 or 19 with `react-dom` (both optional peer dependencies).

## 6-line integration (React)

```tsx
import { useVaultDialog } from '@vaulty/core/react';

const { saveEncrypted, openEncrypted, VaultModal } = useVaultDialog();
<button onClick={() => saveEncrypted('note.md', text)}>Save encrypted</button>
<button onClick={() => openEncrypted((file) => setText(file.text()))}>Open encrypted</button>
<VaultModal />
```

The modal is portalled into `document.body`, traps Tab focus, restores focus on close, is SSR-safe, and styles itself
inline — which means a strict Content-Security-Policy needs `style-src 'unsafe-inline'`.

**Next.js (App Router):** the built `@vaulty/core/react` entry starts with `"use client"`, so its components (e.g.
`<PatternGrid />`) can be rendered from Server Components. Hooks such as `useVaultDialog()` must be called inside your own
`"use client"` component, as with any React hook. `@vaulty/core` itself has no React and can be imported anywhere.

**Plausible deniability:** there is no "wrong pattern". A mistyped pattern silently opens a *different, empty* vault (and, the
first time, shows a new recovery phrase). Tell your users this, or their files will seem to have vanished.

Full documentation, security design and threat model: https://github.com/isgudtek/vaulty-skeleton

MIT licensed.
