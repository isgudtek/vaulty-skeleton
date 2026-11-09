# Requirements — Showcase apps (`GhostDrop` + `CryptKeep`)

Two functionally distinct PWAs that prove `@vaulty/core` is a reusable zero-knowledge SDK. Requirements use the
**EARS** templates (`THE … SHALL`, `WHEN …`, `WHILE …`, `IF … THEN …`, `WHERE …`) and build on
`.kiro/specs/vaulty-core/requirements.md` (referred to as `core R*`).

- **GhostDrop** (`apps/ghostdrop`) — binary & media field vault for journalists and whistleblowers. Proves: binary
  files, voice notes, decoy vaults, duress wipe, `.vault` archives.
- **CryptKeep** (`apps/cryptkeep`) — structured seed-phrase and TOTP 2FA vault. Proves: reactive typed JSON records,
  deterministic secrets (RFC 6238), clipboard hygiene, 9-word recovery.

---

## S — Shared requirements (both apps)

| ID | Requirement |
|----|-------------|
| S1.1 | THE apps SHALL import SDK functionality only from `@vaulty/core` and `@vaulty/core/react`. |
| S1.2 | THE apps SHALL NOT implement vault encryption, key derivation, key wrapping, secure randomness, archive formats, or storage adapters; all of that SHALL be delegated to `@vaulty/core`. |
| S1.3 | THE apps SHALL declare only `@vaulty/core`, `react` and `react-dom` as runtime dependencies. |
| S1.4 | THE apps SHALL NOT read or write `localStorage`, `sessionStorage`, cookies, or perform any network request for user data; the only network traffic SHALL be loading the static app shell. |
| S1.5 | THE apps SHALL NOT use `console.*` or `Math.random`. |
| S1.6 | THE architecture rules in S1.1–S1.5 SHALL be enforced by an automated test in each app (`tests/architecture.test.ts`). |
| S2.1 | THE apps SHALL render `<PatternGrid />` from `@vaulty/core/react` as the only unlock control, skinned through its `nodeColor` / `activeColor` / `lineColor` / `className` props. |
| S2.2 | THE lock screen SHALL NOT show any "wrong pattern", "incorrect" or "invalid password" message, and SHALL NOT describe the decoy, isolation or duress mechanisms; every valid pattern SHALL open a vault (core R7.2). A test asserts this on the rendered lock screen. |
| S2.3 | THE lock screen SHALL be operable by keyboard (arrow keys, Space, Backspace, Enter, Escape) and SHALL describe those controls in text. |
| S2.4 | WHILE a vault is open, THE apps SHALL show a truncated fingerprint of the active vault namespace. |
| S2.5 | WHEN `unlock` reports `created: true`, THE apps SHALL show the 9-word recovery phrase once, in a modal that cannot be dismissed except by the explicit action "I have written this down". |
| S2.6 | THE apps SHALL discard the recovery phrase from memory state when the modal is confirmed or when the vault locks. |
| S2.7 | WHEN the vault locks for any reason, THE apps SHALL remove all decrypted data (item lists, records, previews, form contents) from the UI. |
| S2.8 | THE apps SHALL auto-lock after an idle timeout and whenever the tab becomes hidden, using the SDK's `SessionGuard` (core R6). |
| S2.9 | THE apps SHALL offer a visible control that locks the vault immediately. |
| S2.10 | THE apps SHALL display the detected storage backend (OPFS, IndexedDB or memory) as chosen by `createBestStorageAdapter()`. |
| S3.1 | THE apps SHALL be installable PWAs: web app manifest with 192 px and 512 px PNG icons, `display: standalone`, and a service worker that caches the static app shell for offline use. |
| S3.2 | THE service worker SHALL cache only same-origin static GET responses and SHALL NOT handle `blob:` URLs or user data. |
| S3.3 | THE production build SHALL inject a Content-Security-Policy with `default-src 'self'`, no `unsafe-eval`, no remote origins, and `blob:` allowed only for media/image/frame/object (decrypted previews). |
| S3.4 | THE apps SHALL be visually distinct: GhostDrop dark cyber-noir (`#090D16`, emerald), CryptKeep light industrial (`#F8FAFC` / `#18181B`, amber `#F59E0B`). |
| S4.1 | THE apps SHALL support exporting a `.vault` archive with `exportArchive()` and restoring one with `importArchive()` using either the pattern or the 9-word phrase. |
| S4.2 | WHEN restoring with the phrase, THE apps SHALL require the user to draw a new pattern twice and SHALL pass it as `newPattern` (core R11.4). |
| S4.3 | IF the archive cannot be opened with the supplied pattern or phrase, THEN THE apps SHALL show the SDK's error and SHALL leave storage unchanged (core R11.5–R11.6). |

## G — GhostDrop

| ID | Requirement |
|----|-------------|
| G1.1 | WHEN files are dropped or chosen, THE app SHALL read each file into a `Uint8Array`, encrypt it with `putFile()` (tagged `evidence`), and zero-fill the plaintext array as soon as `putFile` settles, whether it succeeds or fails. |
| G1.2 | THE app SHALL reject files larger than 512 MiB with a visible message instead of attempting to encrypt them. |
| G2.1 | WHEN the user starts a voice note, THE app SHALL record from the microphone with `MediaRecorder` and keep the audio only in memory. |
| G2.2 | WHEN the user stops recording, THE app SHALL concatenate the chunks into one `Uint8Array`, encrypt it with `putFile()` (tagged `voice`), and zero-fill every intermediate and final array whether encryption succeeds or fails. |
| G2.3 | THE app SHALL release the microphone tracks immediately on stop or cancel, and SHALL abort and discard any recording when the vault locks or the screen unmounts. |
| G3.1 | WHEN the user previews an image, PDF, audio or video item, THE app SHALL decrypt it with `getFile()`, copy it into a `Blob`, zero-fill the decrypted array, and display it through `URL.createObjectURL()`. |
| G3.2 | THE app SHALL revoke the object URL when the preview closes, when the component unmounts (including vault lock), and when the tab becomes hidden. |
| G3.3 | WHERE "lock when a preview closes" is enabled (default on, session-only), THE app SHALL lock the vault when the preview closes. |
| G3.4 | THE app SHALL NOT preview SVG (it can carry script) and SHALL offer "Save" (decrypted download) for types without inline preview. |
| G4.1 | WHILE unlocked, THE app SHALL let the user draw a duress pattern twice and register it with `configureDuress()`; no plaintext marker SHALL be created (core R8.2–R8.3). |
| G4.2 | WHEN the duress pattern is entered on the lock screen, THE app SHALL return to a clean lock screen that shows no wording about duress, wiping or destruction, and SHALL reset all local UI state. |
| G4.3 | IF the duress pattern equals the active pattern or an existing vault's pattern, THEN THE app SHALL show the SDK's refusal message (core R8.7). |
| G4.4 | THE app SHALL describe plainly, next to the duress control, that entering the pattern destroys every vault, OPFS file, IndexedDB database, cache and web-storage entry on the device. |
| G5.1 | THE app SHALL offer Export / Import `.vault` both inside the vault and from the lock screen ("Restore .vault backup"). |
| G5.2 | WHEN importing inside an unlocked vault, THE app SHALL warn that a vault sharing the archive's namespace will be replaced. |

## C — CryptKeep

| ID | Requirement |
|----|-------------|
| C1.1 | THE app SHALL store each seed phrase as `VaultRecord<SeedEntry>` with `putRecord<SeedEntry>()` (tag `seed`) holding label, network, 12 or 24 words, derivation path and notes. |
| C1.2 | THE app SHALL validate that the word count equals the chosen length (12 or 24) and that every word is in the BIP-39 list exported by `@vaulty/core`, unless the user ticks "other word list". |
| C1.3 | THE app SHALL mask every seed word by default, SHALL NOT place hidden words in the DOM, and SHALL reveal words individually on click or keyboard activation. |
| C1.4 | THE app SHALL re-hide a revealed word after 10 seconds. |
| C1.5 | WHEN seed words are sealed, THE app SHALL clear the words and notes fields of the form. |
| C1.6 | THE seed words input SHALL be visually masked while typing unless the user chooses "Show while typing". |
| C2.1 | WHEN the user copies a secret (seed phrase or TOTP code), THE app SHALL write it to the clipboard and show a visible countdown starting at 15 seconds. |
| C2.2 | WHEN the countdown reaches zero, THE app SHALL overwrite the clipboard with an empty string and remove the countdown. |
| C2.3 | THE app SHALL provide a "Clear now" control, SHALL restart the countdown on a new copy, and SHALL clear a pending secret immediately when the vault locks. |
| C3.1 | THE app SHALL store each authenticator as `VaultRecord<TotpEntry>` with `putRecord<TotpEntry>()` (tag `totp`) holding issuer, account, Base32 secret, digits, period and algorithm. |
| C3.2 | THE app SHALL accept a Base32 setup key (16+ characters) or an `otpauth://totp/…` link, with typed issuer/account overriding the link. |
| C3.3 | THE app SHALL compute codes per RFC 4226 / RFC 6238 using only the native Web Crypto `HMAC` primitive (`importKey` + `sign`), default HMAC-SHA1, 6 digits, 30-second period, and SHALL support SHA-256/SHA-512, 8 digits and other periods from `otpauth://` links. |
| C3.4 | THE app SHALL pass the RFC 4226 Appendix D and RFC 6238 Appendix B test vectors. |
| C3.5 | THE app SHALL show each code with a live countdown ring for the remaining seconds, switching to a warning colour for the last 5 seconds, and SHALL recompute the code when the time step changes. |
| C3.6 | THE app SHALL verify that a secret decodes and produces a code before storing it, and SHALL clear the secret field after saving. |
| C4.1 | THE lock screen SHALL provide "Recover Vault with 9-Word Phrase" which takes a `.vault` snapshot, the phrase, and a new pattern (drawn twice) and imports/unlocks the vault (S4.1–S4.2). |
| C4.2 | THE app SHALL explain that recovery needs the snapshot file, because the phrase alone cannot locate a vault whose pattern is forgotten (core design §5). |
| C4.3 | THE app SHALL export a snapshot of all seed and 2FA records as one `.vault` file and SHALL NOT include plaintext in it. |
| C5.1 | THE app SHALL use an idle auto-lock shorter than GhostDrop's (90 s vs 120 s) reflecting its higher-value secrets. |
