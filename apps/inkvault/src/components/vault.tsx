import type { PatternNode, VaultMetadataEntry } from '@vaulty/core';
import { PatternGrid } from '@vaulty/core/react';
import { useState } from 'react';
import { GRID_SKIN, formatBytes, formatDateTime, stripMd } from '../lib/format';
import { Button, Modal } from './ui';

/**
 * The drop-in unlock step. Normal editing never shows this: it appears only when the user asks to
 * save to — or open from — the encrypted vault.
 */
export function UnlockModal({
  intent,
  busy,
  error,
  onPattern,
  onClose,
}: {
  intent: 'save' | 'open';
  busy: boolean;
  error: string;
  onPattern: (pattern: PatternNode[]) => void;
  onClose: () => void;
}) {
  const [hint, setHint] = useState('');
  return (
    <Modal title={intent === 'save' ? 'Save to encrypted vault' : 'Open from encrypted vault'} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-soft">
        Draw a pattern connecting <strong>6 or more</strong> dots.{' '}
        {intent === 'save' ? 'Your note is encrypted on this device and saved straight away.' : 'Your saved notes will be listed next.'}
      </p>
      <div className="mx-auto flex w-fit flex-col items-center gap-2 rounded-xl border border-rule bg-white p-3" aria-busy={busy}>
        <PatternGrid
          size={240}
          {...GRID_SKIN}
          disabled={busy}
          ariaLabel="Vault pattern. Drag across at least six dots, or use the arrow keys to move, Space to select and Enter to confirm."
          onComplete={(p) => {
            setHint('');
            onPattern(p);
          }}
          onError={() => setHint('Connect at least 6 dots.')}
        />
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-5 text-center text-sm text-ink-soft">
        {busy ? 'Deriving keys… (PBKDF2 × 600,000)' : hint}
      </p>
      <p role="alert" className="min-h-5 text-center text-sm text-alert">
        {error}
      </p>
    </Modal>
  );
}

/** Lists encrypted notes (from `listEntries()`); choosing one decrypts it with `getFile()`. */
export function VaultBrowser({
  notes,
  error,
  onOpen,
  onDelete,
  onClose,
}: {
  notes: VaultMetadataEntry[];
  error: string;
  onOpen: (entry: VaultMetadataEntry) => void;
  onDelete: (entry: VaultMetadataEntry) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Modal title="Encrypted notes" wide onClose={onClose}>
      {notes.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-soft">No encrypted notes in this vault yet.</p>
      ) : (
        <ul className="divide-y divide-rule" data-testid="vault-notes">
          {notes.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-base font-semibold" title={n.name}>
                  {stripMd(n.name)}
                </p>
                <p className="text-xs text-ink-soft">
                  {formatBytes(n.size)} · updated {formatDateTime(n.updatedAt)}
                </p>
              </div>
              <Button tone="primary" data-autofocus onClick={() => onOpen(n)} aria-label={`Open ${n.name}`}>
                Open
              </Button>
              {confirming === n.id ? (
                <Button
                  tone="danger"
                  aria-label={`Confirm delete ${n.name}`}
                  onClick={() => {
                    setConfirming(null);
                    onDelete(n);
                  }}
                >
                  Confirm
                </Button>
              ) : (
                <Button tone="danger" aria-label={`Delete ${n.name}`} onClick={() => setConfirming(n.id)}>
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p role="alert" className="mt-2 min-h-5 text-sm text-alert">
        {error}
      </p>
    </Modal>
  );
}

/** One-time 9-word recovery phrase shown right after a vault is first created. Never stored. */
export function RecoveryBanner({ phrase, onConfirm }: { phrase: string; onConfirm: () => void }) {
  return (
    <section
      aria-label="Recovery phrase"
      className="border-b border-indigo-ink/30 bg-indigo-50 px-4 py-3"
      data-testid="recovery-banner"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-indigo-deep">Vault created — write down your recovery phrase (shown once)</p>
          <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm" data-testid="recovery-words">
            {phrase.split(' ').map((w, i) => (
              <li key={i}>
                <span className="mr-1 text-xs text-ink-soft">{i + 1}</span>
                {w}
              </li>
            ))}
          </ol>
          <p className="mt-1 text-xs text-ink-soft">
            It restores a <code>.vault</code> backup if you forget your pattern. It is never stored and disappears when the vault locks.
          </p>
        </div>
        <Button tone="primary" onClick={onConfirm}>
          I have written this down
        </Button>
      </div>
    </section>
  );
}
