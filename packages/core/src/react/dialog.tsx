/**
 * Plug-and-play "Save As Encrypted" / "Open Encrypted" for any React app.
 *
 *   const { saveEncrypted, openEncrypted, VaultModal } = useVaultDialog();
 *   <button onClick={() => saveEncrypted('note.md', text)}>Save encrypted</button>
 *   <button onClick={() => openEncrypted((f) => setText(f.text()))}>Open encrypted</button>
 *   <VaultModal />
 *
 * The modal is self-contained: inline styles only (no Tailwind, no CSS file), accessible (labelled dialog,
 * Escape to cancel, focus moved into the dialog), and themeable. All cryptography stays in VaultClient.
 */
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PatternNode, VaultMetadataEntry } from '../types';
import { PatternGrid, type UseVaultOptions, type UseVaultResult, useVault } from './core';

/* ------------------------------------------------------------------------------------------ */
/* Public types                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface VaultModalTheme {
  overlay: string;
  background: string;
  text: string;
  mutedText: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  nodeColor: string;
  fontFamily: string;
  monoFamily: string;
  radius: number;
}

export const DEFAULT_VAULT_MODAL_THEME: VaultModalTheme = {
  overlay: 'rgba(15, 23, 42, 0.55)',
  background: '#ffffff',
  text: '#0f172a',
  mutedText: '#64748b',
  border: '#e2e8f0',
  accent: '#4f46e5',
  accentText: '#ffffff',
  danger: '#b91c1c',
  nodeColor: '#94a3b8',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  monoFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  radius: 14,
};

export interface UseVaultDialogOptions extends UseVaultOptions {
  /** Heading shown in the modal. Default "Encrypted vault". */
  title?: string;
  /** Override any colour/font of the built-in modal. */
  theme?: Partial<VaultModalTheme>;
}

/** What `openEncrypted` hands to your callback. `bytes` belongs to you (wipe it with `fill(0)` when done). */
export interface OpenedVaultFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  /** Decode `bytes` as UTF-8. */
  text: () => string;
}

export interface UseVaultDialogResult {
  /**
   * Encrypt and store `data` as `filename`. If the vault is locked, the modal asks for a pattern first (and, for a
   * brand-new vault, shows the one-time 9-word recovery phrase). Resolves with the stored entry, or `null` if the
   * user cancelled (or the vault locked before saving).
   */
  saveEncrypted: (filename: string, data: Uint8Array | string, mimeType?: string) => Promise<VaultMetadataEntry | null>;
  /**
   * Show the encrypted file browser (asking for a pattern first if locked). Choosing a file decrypts it and calls
   * `onSelect`. Resolves `true` if a file was opened, `false` if the user closed the browser.
   */
  openEncrypted: (onSelect: (file: OpenedVaultFile) => void | Promise<void>) => Promise<boolean>;
  /** Lock now: wipes the key from memory and closes the modal. */
  lockVault: () => void;
  isUnlocked: boolean;
  namespaceId: string | null;
  /** Render this once anywhere in your tree. It is stable across renders. */
  VaultModal: () => ReactNode;
  /** The underlying `useVault()` result, for anything more advanced. */
  vault: UseVaultResult;
}

/* ------------------------------------------------------------------------------------------ */
/* Internal state                                                                             */
/* ------------------------------------------------------------------------------------------ */

type Intent = 'save' | 'open';

type View =
  | { kind: 'closed' }
  | { kind: 'unlock'; intent: Intent; busy: boolean; error: string; hint: string }
  | { kind: 'recovery'; phrase: string }
  | { kind: 'saving'; name: string; error: string }
  | { kind: 'browse'; entries: VaultMetadataEntry[]; busy: boolean; error: string; notice: string; confirmDelete: string | null };

type Pending =
  | { kind: 'save'; name: string; bytes: Uint8Array; mimeType: string; resolve: (e: VaultMetadataEntry | null) => void }
  | { kind: 'open'; onSelect: (file: OpenedVaultFile) => void | Promise<void>; resolve: (opened: boolean) => void };

interface Actions {
  close: () => void;
  submitPattern: (pattern: PatternNode[]) => void;
  setHint: (hint: string) => void;
  confirmRecovery: () => void;
  retrySave: () => void;
  openEntry: (entry: VaultMetadataEntry) => void;
  askDelete: (id: string | null) => void;
  deleteEntry: (entry: VaultMetadataEntry) => void;
  exportArchive: () => void;
}

interface Snapshot {
  view: View;
  theme: VaultModalTheme;
  title: string;
  actions: Actions;
}

const CLOSED: View = { kind: 'closed' };

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
};

function guessMime(filename: string, data: Uint8Array | string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? (typeof data === 'string' ? 'text/plain' : 'application/octet-stream');
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function downloadBytes(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------------------------------ */
/* Hook                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export function useVaultDialog(options: UseVaultDialogOptions = {}): UseVaultDialogResult {
  const { title = 'Encrypted vault', theme: themeOverride, ...vaultOptions } = options;
  const vault = useVault(vaultOptions);
  const { client, isUnlocked } = vault;

  const [view, setView] = useState<View>(CLOSED);
  const pending = useRef<Pending | null>(null);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  /** Resolve whatever is waiting as "cancelled" and wipe any plaintext we copied. */
  const cancelPending = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    if (p.kind === 'save') {
      p.bytes.fill(0);
      p.resolve(null);
    } else {
      p.resolve(false);
    }
  }, []);

  const close = useCallback(() => {
    cancelPending();
    setView(CLOSED);
  }, [cancelPending]);

  const showBrowser = useCallback((notice = '') => {
    let entries: VaultMetadataEntry[] = [];
    let error = '';
    try {
      entries = vaultRef.current.client.listEntries();
    } catch (e) {
      error = errorText(e);
    }
    setView({ kind: 'browse', entries, busy: false, error, notice, confirmDelete: null });
  }, []);

  const commitSave = useCallback(async () => {
    const p = pending.current;
    if (!p || p.kind !== 'save') return;
    setView({ kind: 'saving', name: p.name, error: '' });
    try {
      const entry = await vaultRef.current.putFile(p.bytes, { name: p.name, mimeType: p.mimeType });
      if (pending.current !== p) return; // cancelled meanwhile
      pending.current = null;
      p.bytes.fill(0);
      setView(CLOSED);
      p.resolve(entry);
    } catch (e) {
      if (pending.current === p) setView({ kind: 'saving', name: p.name, error: errorText(e) });
    }
  }, []);

  const continueAfterUnlock = useCallback(() => {
    const p = pending.current;
    if (!p) setView(CLOSED);
    else if (p.kind === 'save') void commitSave();
    else showBrowser();
  }, [commitSave, showBrowser]);

  const submitPattern = useCallback(
    async (pattern: PatternNode[]) => {
      setView((v) => (v.kind === 'unlock' ? { ...v, busy: true, error: '', hint: '' } : v));
      try {
        const res = await vaultRef.current.unlock(pattern);
        if (res.status === 'duress_triggered') {
          close();
          return;
        }
        if (res.created && res.recoveryPhrase) {
          setView({ kind: 'recovery', phrase: res.recoveryPhrase });
          return;
        }
        continueAfterUnlock();
      } catch (e) {
        setView((v) => (v.kind === 'unlock' ? { ...v, busy: false, error: errorText(e) } : v));
      }
    },
    [close, continueAfterUnlock],
  );

  const openEntry = useCallback(
    async (entry: VaultMetadataEntry) => {
      const p = pending.current;
      if (!p || p.kind !== 'open') return;
      setView((v) => (v.kind === 'browse' ? { ...v, busy: true, error: '' } : v));
      try {
        const { data } = await vaultRef.current.getFile(entry.id);
        await p.onSelect({
          id: entry.id,
          name: entry.name,
          mimeType: entry.mimeType,
          size: entry.size,
          bytes: data,
          text: () => new TextDecoder().decode(data),
        });
        if (pending.current === p) pending.current = null;
        setView(CLOSED);
        p.resolve(true);
      } catch (e) {
        setView((v) => (v.kind === 'browse' ? { ...v, busy: false, error: errorText(e) } : v));
      }
    },
    [],
  );

  const deleteEntry = useCallback(
    async (entry: VaultMetadataEntry) => {
      try {
        await vaultRef.current.deleteFile(entry.id);
        showBrowser(`Deleted “${entry.name}”.`);
      } catch (e) {
        setView((v) => (v.kind === 'browse' ? { ...v, error: errorText(e), confirmDelete: null } : v));
      }
    },
    [showBrowser],
  );

  const exportArchive = useCallback(async () => {
    setView((v) => (v.kind === 'browse' ? { ...v, busy: true, error: '', notice: '' } : v));
    try {
      const bytes = await vaultRef.current.exportArchive();
      const d = new Date();
      const p = (x: number) => String(x).padStart(2, '0');
      const name = `vault-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.vault`;
      downloadBytes(bytes, name);
      setView((v) => (v.kind === 'browse' ? { ...v, busy: false, notice: `Exported ${name} (still encrypted).` } : v));
    } catch (e) {
      setView((v) => (v.kind === 'browse' ? { ...v, busy: false, error: errorText(e) } : v));
    }
  }, []);

  // If the vault locks while the modal is past the unlock step (idle, hidden tab, lockVault), abort and close.
  useEffect(() => {
    if (!isUnlocked && (view.kind === 'recovery' || view.kind === 'browse' || view.kind === 'saving')) close();
  }, [isUnlocked, view.kind, close]);

  // Never leave a promise hanging if the host component unmounts.
  useEffect(() => cancelPending, [cancelPending]);

  const saveEncrypted = useCallback<UseVaultDialogResult['saveEncrypted']>(
    (filename, data, mimeType) =>
      new Promise<VaultMetadataEntry | null>((resolve, reject) => {
        cancelPending();
        // Always work on our own copy, so we can wipe it without touching the caller's array.
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
        const job: Pending = { kind: 'save', name: filename, bytes, mimeType: mimeType ?? guessMime(filename, data), resolve };
        if (client.isUnlocked) {
          // Already unlocked: save directly, no modal.
          vaultRef.current
            .putFile(bytes, { name: filename, mimeType: job.mimeType })
            .then(resolve, reject)
            .finally(() => bytes.fill(0));
          return;
        }
        pending.current = job;
        setView({ kind: 'unlock', intent: 'save', busy: false, error: '', hint: '' });
      }),
    [cancelPending, client],
  );

  const openEncrypted = useCallback<UseVaultDialogResult['openEncrypted']>(
    (onSelect) =>
      new Promise<boolean>((resolve) => {
        cancelPending();
        pending.current = { kind: 'open', onSelect, resolve };
        if (client.isUnlocked) showBrowser();
        else setView({ kind: 'unlock', intent: 'open', busy: false, error: '', hint: '' });
      }),
    [cancelPending, client, showBrowser],
  );

  const lockVault = useCallback(() => {
    close();
    vaultRef.current.lock();
  }, [close]);

  /* ---------------- stable <VaultModal /> fed through a tiny external store ---------------- */

  const actionsRef = useRef<Actions | null>(null);
  actionsRef.current = {
    close,
    submitPattern: (p) => void submitPattern(p),
    setHint: (hint) => setView((v) => (v.kind === 'unlock' ? { ...v, hint } : v)),
    confirmRecovery: continueAfterUnlock,
    retrySave: () => void commitSave(),
    openEntry: (e) => void openEntry(e),
    askDelete: (id) => setView((v) => (v.kind === 'browse' ? { ...v, confirmDelete: id } : v)),
    deleteEntry: (e) => void deleteEntry(e),
    exportArchive: () => void exportArchive(),
  };
  const stableActions = useRef<Actions>({
    close: () => actionsRef.current?.close(),
    submitPattern: (p) => actionsRef.current?.submitPattern(p),
    setHint: (h) => actionsRef.current?.setHint(h),
    confirmRecovery: () => actionsRef.current?.confirmRecovery(),
    retrySave: () => actionsRef.current?.retrySave(),
    openEntry: (e) => actionsRef.current?.openEntry(e),
    askDelete: (id) => actionsRef.current?.askDelete(id),
    deleteEntry: (e) => actionsRef.current?.deleteEntry(e),
    exportArchive: () => actionsRef.current?.exportArchive(),
  }).current;

  const theme = { ...DEFAULT_VAULT_MODAL_THEME, ...themeOverride };
  const themeKey = JSON.stringify(theme);

  const store = useRef<{ snapshot: Snapshot; listeners: Set<() => void> } | null>(null);
  if (store.current === null) {
    store.current = { snapshot: { view, theme, title, actions: stableActions }, listeners: new Set() };
  }
  const s = store.current;
  if (s.snapshot.view !== view || JSON.stringify(s.snapshot.theme) !== themeKey || s.snapshot.title !== title) {
    s.snapshot = { view, theme, title, actions: stableActions };
  }
  useLayoutEffect(() => {
    for (const l of [...s.listeners]) l();
  });

  const VaultModalRef = useRef<(() => ReactNode) | null>(null);
  if (VaultModalRef.current === null) {
    const subscribe = (l: () => void) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    };
    const get = () => s.snapshot;
    VaultModalRef.current = function VaultModal() {
      const snap = useSyncExternalStore(subscribe, get, get);
      return <VaultModalView snapshot={snap} />;
    };
  }

  return {
    saveEncrypted,
    openEncrypted,
    lockVault,
    isUnlocked,
    namespaceId: vault.namespaceId,
    VaultModal: VaultModalRef.current,
    vault,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* View (inline styles only)                                                                  */
/* ------------------------------------------------------------------------------------------ */

function VaultModalView({ snapshot }: { snapshot: Snapshot }) {
  const { view, theme: t, title, actions } = snapshot;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const busy = (view.kind === 'unlock' && view.busy) || (view.kind === 'browse' && view.busy) || (view.kind === 'saving' && !view.error);

  // Move focus into the dialog whenever the step changes.
  useEffect(() => {
    if (view.kind === 'closed') return;
    const target =
      panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      panelRef.current?.querySelector<HTMLElement>('svg[role="application"], button');
    target?.focus();
  }, [view.kind]);

  useEffect(() => {
    if (view.kind === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      // The one-time recovery phrase can only be left via the explicit "I have written this down" button.
      if (e.key === 'Escape' && !busy && view.kind !== 'recovery') actions.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view.kind, busy, actions]);

  if (view.kind === 'closed') return null;

  const button = (tone: 'primary' | 'ghost' | 'danger'): CSSProperties => ({
    font: `600 14px/1.2 ${t.fontFamily}`,
    padding: '9px 14px',
    borderRadius: 8,
    cursor: 'pointer',
    border: `1px solid ${tone === 'primary' ? t.accent : tone === 'danger' ? t.danger : t.border}`,
    background: tone === 'primary' ? t.accent : 'transparent',
    color: tone === 'primary' ? t.accentText : tone === 'danger' ? t.danger : t.text,
  });
  const muted: CSSProperties = { color: t.mutedText, fontSize: 13, lineHeight: 1.5, margin: 0 };
  const errorStyle: CSSProperties = { color: t.danger, fontSize: 13, minHeight: 18, margin: '10px 0 0', textAlign: 'center' };

  let body: ReactNode;
  let heading = title;

  if (view.kind === 'unlock') {
    heading = view.intent === 'save' ? 'Save encrypted' : 'Open encrypted';
    body = (
      <>
        <p style={muted}>
          Draw a pattern connecting <strong>6 or more</strong> dots.{' '}
          {view.intent === 'save' ? 'Your file is encrypted on this device.' : 'Your encrypted files are listed next.'}
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', margin: '16px 0 4px' }} aria-busy={view.busy}>
          <PatternGrid
            size={260}
            nodeColor={t.nodeColor}
            activeColor={t.accent}
            lineColor={t.accent}
            disabled={view.busy}
            ariaLabel="Vault pattern. Drag across at least six dots, or use the arrow keys to move, Space to select and Enter to confirm."
            onComplete={(p) => actions.submitPattern(p)}
            onError={() => actions.setHint('Connect at least 6 dots.')}
          />
        </div>
        <p role="status" aria-live="polite" style={{ ...muted, textAlign: 'center', minHeight: 20 }}>
          {view.busy ? 'Deriving keys…' : view.hint}
        </p>
        <p role="alert" style={errorStyle}>
          {view.error}
        </p>
      </>
    );
  } else if (view.kind === 'recovery') {
    heading = 'Your recovery phrase';
    body = (
      <>
        <p style={muted}>
          A new vault was created. Write these <strong>9 words</strong> down — they restore a <code>.vault</code> backup if you
          forget your pattern. They are shown <strong>once</strong> and never stored.
        </p>
        <ol
          data-testid="vault-modal-recovery-words"
          aria-label="Recovery phrase"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '8px 12px',
            listStyle: 'none',
            margin: '16px 0',
            padding: 14,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            font: `500 15px/1.4 ${t.monoFamily}`,
          }}
        >
          {view.phrase.split(' ').map((w, i) => (
            <li key={i}>
              <span style={{ color: t.mutedText, fontSize: 11, marginRight: 6 }}>{i + 1}</span>
              {w}
            </li>
          ))}
        </ol>
        <button type="button" data-autofocus style={{ ...button('primary'), width: '100%' }} onClick={actions.confirmRecovery}>
          I have written this down
        </button>
      </>
    );
  } else if (view.kind === 'saving') {
    heading = 'Save encrypted';
    body = view.error ? (
      <>
        <p role="alert" style={{ ...errorStyle, textAlign: 'left' }}>
          Could not save “{view.name}”: {view.error}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" style={button('ghost')} onClick={actions.close}>
            Cancel
          </button>
          <button type="button" data-autofocus style={button('primary')} onClick={actions.retrySave}>
            Try again
          </button>
        </div>
      </>
    ) : (
      <p role="status" aria-live="polite" style={{ ...muted, textAlign: 'center', padding: '24px 0' }}>
        Encrypting “{view.name}”…
      </p>
    );
  } else {
    heading = 'Encrypted files';
    body = (
      <>
        {view.entries.length === 0 ? (
          <p style={{ ...muted, textAlign: 'center', padding: '24px 0' }}>This vault has no files yet.</p>
        ) : (
          <ul data-testid="vault-modal-files" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '50vh', overflowY: 'auto' }}>
            {view.entries.map((e) => (
              <li
                key={e.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderTop: `1px solid ${t.border}` }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.name}>
                    {e.name}
                  </p>
                  <p style={{ ...muted, fontSize: 12 }}>
                    {formatBytes(e.size)} · {formatDate(e.updatedAt)}
                  </p>
                </div>
                <button type="button" disabled={view.busy} style={button('primary')} aria-label={`Open ${e.name}`} onClick={() => actions.openEntry(e)}>
                  Open
                </button>
                {view.confirmDelete === e.id ? (
                  <button type="button" disabled={view.busy} style={button('danger')} aria-label={`Confirm delete ${e.name}`} onClick={() => actions.deleteEntry(e)}>
                    Confirm
                  </button>
                ) : (
                  <button type="button" disabled={view.busy} style={button('danger')} aria-label={`Delete ${e.name}`} onClick={() => actions.askDelete(e.id)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>
          <p role="status" aria-live="polite" style={{ ...muted, flex: 1 }}>
            {view.notice}
          </p>
          <button type="button" disabled={view.busy} style={button('ghost')} onClick={actions.exportArchive}>
            Export .vault
          </button>
        </div>
        <p role="alert" style={errorStyle}>
          {view.error}
        </p>
      </>
    );
  }

  return (
    <div
      role="presentation"
      data-vaulty-modal=""
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: t.overlay,
        fontFamily: t.fontFamily,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          maxWidth: view.kind === 'browse' ? 560 : 380,
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: 22,
          background: t.background,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <h2 id={titleId} style={{ margin: 0, font: `700 18px/1.3 ${t.fontFamily}` }}>
            {heading}
          </h2>
          {view.kind !== 'recovery' ? (
            <button type="button" disabled={busy} style={button('ghost')} aria-label="Close dialog" onClick={actions.close}>
              Close
            </button>
          ) : null}
        </div>
        {body}
      </div>
    </div>
  );
}
