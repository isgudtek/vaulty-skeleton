import type { PatternNode } from '@vaulty/core';
import { PatternGrid, type UseVaultResult } from '@vaulty/core/react';
import { useState } from 'react';
import { GRID_SKIN, downloadBytes, errorMessage, fingerprint, readBlobBytes, timestampStamp } from '../lib/format';
import { PatternSetter } from './PatternSetter';
import { Button, Card, Modal, inputClass, labelClass } from './ui';

/** Encrypted `.vault` snapshot of every seed and 2FA record. */
export function BackupPanel({ vault, onRestore }: { vault: UseVaultResult; onRestore: () => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const exportSnapshot = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bytes = await vault.exportArchive();
      const name = `cryptkeep-${fingerprint(vault.namespaceId).replace('·', '')}-${timestampStamp()}.vault`;
      downloadBytes(bytes, name);
      setMessage(`Exported ${name}. Still fully encrypted.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Encrypted snapshot" hint=".vault">
      <p className="mb-3 text-sm text-zinc-700">
        One file containing every seed phrase and authenticator, encrypted. Safe to store on a USB drive or cloud drive —
        it opens only with your pattern or the 9-word recovery phrase.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={busy} onClick={() => void exportSnapshot()}>
          Export snapshot
        </Button>
        <Button disabled={busy} onClick={onRestore}>
          Restore snapshot
        </Button>
      </div>
      {vault.progress ? (
        <p className="mt-2 font-mono text-[11px]" aria-live="polite">
          {vault.progress.stage} · {vault.progress.percent}%
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="mt-2 min-h-4 font-mono text-[11px] text-amber-deep">
        {message}
      </p>
      <p role="alert" className="min-h-4 font-mono text-[11px] text-alert">
        {error}
      </p>
    </Card>
  );
}

/**
 * Restore a `.vault` snapshot with its pattern OR the 9-word recovery phrase. The phrase path lets the
 * user choose a brand-new 5×5 pattern for the restored vault.
 */
export function RestoreModal({
  vault,
  initialMethod,
  replacing,
  onClose,
}: {
  vault: UseVaultResult;
  initialMethod: 'pattern' | 'phrase';
  replacing: boolean;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [method, setMethod] = useState<'pattern' | 'phrase'>(initialMethod);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (secret: PatternNode[] | string, newPattern?: PatternNode[]) => {
    if (!file) {
      setError('Choose a .vault file first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const bytes = await readBlobBytes(file);
      await vault.importArchive(bytes, secret, newPattern ? { newPattern } : undefined);
      setPhrase('');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={method === 'phrase' ? 'Recover vault with 9-word phrase' : 'Restore snapshot'} wide onClose={onClose}>
      {replacing ? (
        <p className="mb-3 rounded border-2 border-amber-key bg-amber-50 p-2 text-xs">
          Restoring replaces any vault that shares the snapshot&apos;s namespace on this device.
        </p>
      ) : null}
      <label className={`${labelClass} mb-3`}>
        Snapshot file
        <input
          type="file"
          accept=".vault,application/octet-stream"
          data-testid="restore-file"
          data-autofocus
          className={`${inputClass} mt-1`}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <div role="tablist" aria-label="Unlock method" className="mb-3 flex gap-2">
        {(['phrase', 'pattern'] as const).map((m) => (
          <Button
            key={m}
            role="tab"
            aria-selected={method === m}
            tone={method === m ? 'primary' : 'ghost'}
            onClick={() => setMethod(m)}
          >
            {m === 'phrase' ? '9-word phrase' : 'Pattern'}
          </Button>
        ))}
      </div>

      {method === 'phrase' ? (
        <p className="mb-3 rounded border-2 border-carbon bg-white p-2 text-xs">
          The phrase unlocks a <code className="font-mono">.vault</code> snapshot — it cannot find data on this device by
          itself. Choose your snapshot file, enter the 9 words, then draw a <strong>new</strong> pattern twice.
        </p>
      ) : null}

      {method === 'pattern' ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-[11px] font-black uppercase tracking-wider">Draw the vault&apos;s pattern</p>
          <div className="rounded-xl border-2 border-carbon bg-carbon p-3">
            <PatternGrid
              size={240}
              {...GRID_SKIN}
              disabled={busy}
              ariaLabel="Snapshot pattern. Drag across at least six dots, or use arrow keys, Space and Enter."
              onComplete={(p) => void run(p)}
              onError={() => setError('Connect at least 6 dots.')}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <label className={`${labelClass} w-full`}>
            Recovery phrase (9 words)
            <textarea
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              rows={2}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="restore-phrase"
              className={`${inputClass} mt-1 font-mono`}
            />
          </label>
          <PatternSetter
            label="Set a NEW pattern for the recovered vault"
            disabled={busy}
            size={200}
            onSet={(p) => void run(phrase, p)}
          />
        </div>
      )}

      <p role="alert" className="mt-3 min-h-4 text-center font-mono text-[11px] text-alert">
        {error}
      </p>
    </Modal>
  );
}
