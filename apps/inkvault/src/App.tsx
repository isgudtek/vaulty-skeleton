import type { PatternNode, VaultMetadataEntry } from '@vaulty/core';
import { type UseVaultOptions, useVault } from '@vaulty/core/react';
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Preview } from './components/Preview';
import { Toolbar } from './components/Toolbar';
import { ConfirmModal } from './components/ui';
import { RecoveryBanner, UnlockModal, VaultBrowser } from './components/vault';
import { getAdapter } from './lib/adapter';
import {
  NOTE_MIME,
  NOTE_TAG,
  downloadText,
  errorMessage,
  formatBytes,
  fromUtf8,
  noteFileName,
  stripMd,
  suggestTitle,
  utf8,
  wordCount,
} from './lib/format';

/** Auto-lock after this much inactivity while the vault is unlocked (a hidden tab always locks immediately). */
export const IDLE_MS = 300_000;

export interface AppProps {
  /** Test/embedding hook: override storage adapter, KDF cost, etc. */
  vaultOptions?: UseVaultOptions;
}

interface Doc {
  name: string;
  text: string;
  /** What is currently saved/opened — used to detect unsaved changes. */
  savedName: string;
  savedText: string;
  /** Vault entry this document came from / was saved as. `null` until it has been saved to the vault. */
  entryId: string | null;
}

const blankDoc = (): Doc => ({ name: '', text: '', savedName: '', savedText: '', entryId: null });

type Modal =
  | null
  | { kind: 'unlock'; intent: 'save' | 'open' }
  | { kind: 'browse' }
  | { kind: 'confirm'; message: string; label: string; run: () => void };

type Status = { tone: 'info' | 'error'; text: string } | null;

export function App({ vaultOptions }: AppProps) {
  const [options] = useState<UseVaultOptions>(() => ({
    idleTimeoutMs: IDLE_MS,
    ...vaultOptions,
    adapter: vaultOptions?.adapter ?? getAdapter, // OPFS → IndexedDB → memory
  }));
  const vault = useVault(options);
  const { isUnlocked, unlock, lastLockReason } = vault;

  const [doc, setDoc] = useState<Doc>(blankDoc);
  const [modal, setModal] = useState<Modal>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [modalError, setModalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pane, setPane] = useState<'write' | 'preview'>('write');

  const dirty = doc.text !== doc.savedText || doc.name !== doc.savedName;
  // Deferred so typing stays smooth on long notes — but an EMPTY buffer (lock, New Note) bypasses the deferral,
  // otherwise the previous (decrypted) note would linger in the preview for a few frames after locking.
  const deferredText = useDeferredValue(doc.text);
  const previewSource = doc.text === '' ? '' : deferredText;

  /* ---------------------------- lock lifecycle ---------------------------- */

  // When the vault locks (button, idle, tab hidden): wipe the keys (SDK) and clear everything decrypted here.
  // useLayoutEffect (not useEffect) so the clear is committed before the browser paints — the plaintext is
  // never visible for even one frame after the vault reports "locked".
  const wasUnlocked = useRef(false);
  useLayoutEffect(() => {
    if (isUnlocked) {
      wasUnlocked.current = true;
      return;
    }
    if (!wasUnlocked.current) return;
    wasUnlocked.current = false;
    setDoc(blankDoc());
    setModal(null);
    setPhrase(null); // the recovery phrase never outlives the unlocked session
    setModalError('');
    const why = lastLockReason === 'hidden' || lastLockReason === 'pagehide' ? ' (tab hidden)' : lastLockReason === 'idle' ? ' (idle)' : '';
    setStatus({ tone: 'info', text: `Vault locked${why}. Keys wiped and editor cleared.` });
  }, [isUnlocked, lastLockReason]);

  // Warn before a reload/close discards an unsaved draft. (Nothing is persisted outside the vault.)
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /* ------------------------------- actions -------------------------------- */

  const fileName = noteFileName(doc.name || suggestTitle(doc.text));

  const saveNow = useCallback(
    async (snapshot: Doc): Promise<void> => {
      const bytes = utf8(snapshot.text);
      const name = noteFileName(snapshot.name || suggestTitle(snapshot.text));
      try {
        const entry = await vault.putFile(bytes, {
          name,
          mimeType: NOTE_MIME,
          tags: [NOTE_TAG],
          ...(snapshot.entryId ? { id: snapshot.entryId } : {}),
        });
        setDoc((d) => ({ ...d, name: d.name || stripMd(name), savedName: d.name || stripMd(name), savedText: snapshot.text, entryId: entry.id }));
        setStatus({ tone: 'info', text: `Saved “${entry.name}” to the encrypted vault (${formatBytes(entry.size)}).` });
      } catch (e) {
        setStatus({ tone: 'error', text: `Could not save: ${errorMessage(e)}` });
      } finally {
        bytes.fill(0); // plaintext bytes never linger after encryption
      }
    },
    [vault],
  );

  const onSave = useCallback(() => {
    if (doc.text.trim() === '') {
      setStatus({ tone: 'error', text: 'Nothing to save yet — write something first.' });
      return;
    }
    if (!isUnlocked) {
      setModalError('');
      setModal({ kind: 'unlock', intent: 'save' });
      return;
    }
    void saveNow(doc);
  }, [doc, isUnlocked, saveNow]);

  // Ctrl/⌘+S = "Save to Encrypted Vault" (instead of the browser's save-page dialog).
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSaveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onOpen = useCallback(() => {
    setModalError('');
    setModal(isUnlocked ? { kind: 'browse' } : { kind: 'unlock', intent: 'open' });
  }, [isUnlocked]);

  const onPattern = useCallback(
    async (pattern: PatternNode[], intent: 'save' | 'open') => {
      setBusy(true);
      setModalError('');
      try {
        const res = await unlock(pattern);
        if (res.status === 'duress_triggered') {
          setDoc(blankDoc());
          setModal(null);
          return;
        }
        if (res.created && res.recoveryPhrase) setPhrase(res.recoveryPhrase);
        if (intent === 'save') {
          setModal(null);
          await saveNow(doc);
        } else {
          setModal({ kind: 'browse' });
        }
      } catch (e) {
        setModalError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [doc, saveNow, unlock],
  );

  const guardDiscard = useCallback(
    (message: string, label: string, run: () => void) => {
      if (!dirty) run();
      else setModal({ kind: 'confirm', message, label, run });
    },
    [dirty],
  );

  const onNew = useCallback(() => {
    guardDiscard('Your current note has unsaved changes. Start a new note and discard them?', 'Discard & start new', () => {
      setDoc(blankDoc());
      setModal(null);
      setStatus(null);
    });
  }, [guardDiscard]);

  const loadFromVault = useCallback(
    async (entry: VaultMetadataEntry) => {
      try {
        const { data } = await vault.getFile(entry.id);
        const text = fromUtf8(data);
        data.fill(0);
        setDoc({ name: stripMd(entry.name), text, savedName: stripMd(entry.name), savedText: text, entryId: entry.id });
        setModal(null);
        setStatus({ tone: 'info', text: `Opened “${entry.name}” from the encrypted vault.` });
      } catch (e) {
        setModalError(errorMessage(e));
        setModal({ kind: 'browse' });
      }
    },
    [vault],
  );

  const onChooseNote = useCallback(
    (entry: VaultMetadataEntry) => {
      guardDiscard('Opening this note replaces your current text, which has unsaved changes. Continue?', 'Discard & open', () => {
        void loadFromVault(entry);
      });
    },
    [guardDiscard, loadFromVault],
  );

  const onDeleteNote = useCallback(
    async (entry: VaultMetadataEntry) => {
      try {
        await vault.deleteFile(entry.id);
        setDoc((d) => (d.entryId === entry.id ? { ...d, entryId: null, savedText: '', savedName: '' } : d));
        setModalError('');
      } catch (e) {
        setModalError(errorMessage(e));
      }
    },
    [vault],
  );

  // Encrypted notes, listed with the SDK's `listEntries()` (re-read whenever the encrypted index changes).
  const notes = useMemo<VaultMetadataEntry[]>(() => {
    if (!isUnlocked) return [];
    try {
      return vault.client.listEntries({ mimeType: NOTE_MIME });
    } catch {
      return [];
    }
    // `vault.entries` changes whenever the encrypted index does.
  }, [isUnlocked, vault.entries, vault.client]);

  /* -------------------------------- render -------------------------------- */

  return (
    <main className="flex h-full min-h-screen flex-col">
      <Toolbar
        unlocked={isUnlocked}
        namespaceId={vault.namespaceId}
        busy={busy}
        canSave={doc.text.trim() !== ''}
        onNew={onNew}
        onDownload={() => downloadText(doc.text, fileName)}
        onSave={onSave}
        onOpen={onOpen}
        onLock={() => vault.lock()}
      />

      {phrase ? <RecoveryBanner phrase={phrase} onConfirm={() => setPhrase(null)} /> : null}

      <div className="flex items-center gap-3 border-b border-rule px-4 py-2">
        <label className="sr-only" htmlFor="note-title">
          Note title
        </label>
        <input
          id="note-title"
          value={doc.name}
          onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))}
          placeholder={suggestTitle(doc.text) || 'Untitled note'}
          className="min-w-0 flex-1 bg-transparent font-serif text-lg font-semibold placeholder:text-ink-soft/60 focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        <div role="tablist" aria-label="Pane" className="flex gap-1 lg:hidden">
          {(['write', 'preview'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${pane === p ? 'bg-ink text-white' : 'text-ink-soft'}`}
            >
              {p === 'write' ? 'Write' : 'Preview'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-2">
        <section aria-label="Markdown editor" className={`${pane === 'write' ? 'block' : 'hidden'} min-h-[50vh] border-rule lg:block lg:border-r`}>
          <textarea
            value={doc.text}
            onChange={(e) => setDoc((d) => ({ ...d, text: e.target.value }))}
            placeholder={'# Start writing…\n\nMarkdown works as you type. Nothing is stored until you choose to save to the encrypted vault.'}
            aria-label="Markdown source"
            spellCheck
            className="h-full min-h-[50vh] w-full resize-none bg-paper p-5 font-mono text-[0.95rem] leading-7 text-ink placeholder:text-ink-soft/60 focus:outline-none"
            data-testid="editor"
          />
        </section>
        <section aria-label="Preview" className={`${pane === 'preview' ? 'block' : 'hidden'} overflow-y-auto bg-white p-6 lg:block`}>
          <Preview source={previewSource} />
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule bg-paper px-4 py-2 text-xs text-ink-soft">
        <span data-testid="counts">
          {wordCount(doc.text)} words · {doc.text.length} chars
        </span>
        <span>{dirty ? '● unsaved changes' : doc.entryId ? '✓ saved in vault' : 'draft — not saved anywhere'}</span>
        <span
          role="status"
          aria-live="polite"
          data-testid="status"
          className={`min-h-4 flex-1 ${status?.tone === 'error' ? 'text-alert' : 'text-indigo-deep'}`}
        >
          {status?.text ?? ''}
        </span>
        <span className="font-mono">PBKDF2 ×600,000 · AES-256-GCM</span>
      </footer>

      {modal?.kind === 'unlock' ? (
        <UnlockModal
          intent={modal.intent}
          busy={busy}
          error={modalError}
          onPattern={(p) => void onPattern(p, modal.intent)}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal?.kind === 'browse' ? (
        <VaultBrowser
          notes={notes}
          error={modalError}
          onOpen={onChooseNote}
          onDelete={(n) => void onDeleteNote(n)}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal?.kind === 'confirm' ? (
        <ConfirmModal
          message={modal.message}
          confirmLabel={modal.label}
          onConfirm={() => {
            const run = modal.run;
            setModal(null);
            run();
          }}
          onCancel={() => setModal(null)}
        />
      ) : null}
    </main>
  );
}
