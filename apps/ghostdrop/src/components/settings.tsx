import type { PatternNode } from '@vaulty/core';
import { PatternGrid, type UseVaultResult } from '@vaulty/core/react';
import { useState } from 'react';
import { downloadBytes, readBlobBytes } from '../lib/files';
import { fingerprint, timestampStamp } from '../lib/format';
import { GRID_SKIN, errorMessage } from '../lib/skin';
import { PatternSetter } from './PatternSetter';
import { Button, Modal, Panel } from './ui';

/** Duress pattern: stored ONLY inside an encrypted decoy-looking vault (see @vaulty/core `configureDuress`). */
export function DuressPanel({ vault }: { vault: UseVaultResult }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const arm = async (pattern: PatternNode[]) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await vault.client.configureDuress(pattern);
      setMessage('Duress pattern armed.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Duress pattern" hint="panic wipe">
      <p className="mb-3 text-xs leading-relaxed text-slate-400">
        Entering this pattern on the lock screen <strong className="text-rose-300">instantly destroys every vault</strong>,
        OPFS file, IndexedDB database, cache and web-storage entry on this device — then shows an ordinary lock screen. It
        leaves no plaintext marker: the trigger lives inside an encrypted vault that looks like any other.
      </p>
      <PatternSetter label="Draw a duress pattern" disabled={busy} size={200} onSet={(p) => void arm(p)} />
      <p role="status" aria-live="polite" className="min-h-4 text-center font-mono text-[11px] text-emerald-300">
        {message}
      </p>
      <p role="alert" className="min-h-4 text-center font-mono text-[11px] text-rose-400">
        {error}
      </p>
    </Panel>
  );
}

export function ArchivePanel({ vault, onImport }: { vault: UseVaultResult; onImport: () => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const exportArchive = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bytes = await vault.exportArchive();
      const name = `ghostdrop-${fingerprint(vault.namespaceId).replace('·', '')}-${timestampStamp()}.vault`;
      downloadBytes(bytes, name, 'application/octet-stream');
      setMessage(`Exported ${name}. Still fully encrypted.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Portable archive" hint=".vault">
      <p className="mb-3 text-xs leading-relaxed text-slate-400">
        One file with your vault&apos;s encrypted index and items. Safe to back up or upload anywhere: it opens only with
        your pattern or the 9-word phrase.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={busy} onClick={() => void exportArchive()}>
          Export .vault
        </Button>
        <Button disabled={busy} onClick={onImport}>
          Import .vault
        </Button>
      </div>
      {vault.progress ? (
        <p className="mt-2 font-mono text-[11px] text-slate-400" aria-live="polite">
          {vault.progress.stage} · {vault.progress.percent}%
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="mt-2 min-h-4 font-mono text-[11px] text-emerald-300">
        {message}
      </p>
      <p role="alert" className="min-h-4 font-mono text-[11px] text-rose-400">
        {error}
      </p>
    </Panel>
  );
}

/** Restore a `.vault` with either its pattern or the 9-word recovery phrase (+ a new pattern). */
export function RestoreModal({
  vault,
  replacing,
  onClose,
}: {
  vault: UseVaultResult;
  replacing: boolean;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [method, setMethod] = useState<'pattern' | 'phrase'>('pattern');
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
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Restore .vault archive" wide onClose={onClose}>
      {replacing ? (
        <p className="mb-3 rounded border border-amber-400/40 bg-amber-400/5 p-2 text-xs text-amber-200">
          Importing replaces any vault that shares the archive&apos;s namespace on this device.
        </p>
      ) : null}
      <label className="mb-3 block font-mono text-xs uppercase tracking-wider text-slate-400">
        Archive file
        <input
          type="file"
          accept=".vault,application/octet-stream"
          data-testid="restore-file"
          data-autofocus
          className="mt-1 block w-full rounded border border-line bg-panel p-2 text-xs text-slate-300"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <div role="tablist" aria-label="Unlock method" className="mb-3 flex gap-2">
        {(['pattern', 'phrase'] as const).map((m) => (
          <Button
            key={m}
            role="tab"
            aria-selected={method === m}
            tone={method === m ? 'primary' : 'ghost'}
            onClick={() => setMethod(m)}
          >
            {m === 'pattern' ? 'Use pattern' : 'Use 9-word phrase'}
          </Button>
        ))}
      </div>

      {method === 'pattern' ? (
        <div className="flex flex-col items-center gap-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-slate-400">Draw the vault&apos;s pattern</p>
          <PatternGrid
            size={240}
            {...GRID_SKIN}
            disabled={busy}
            ariaLabel="Archive pattern. Drag across at least six dots, or use arrow keys, Space and Enter."
            onComplete={(p) => void run(p)}
            onError={() => setError('Connect at least 6 dots.')}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <label className="w-full font-mono text-xs uppercase tracking-wider text-slate-400">
            Recovery phrase (9 words)
            <textarea
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              rows={2}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="restore-phrase"
              className="mt-1 w-full rounded border border-line bg-panel p-2 font-mono text-sm normal-case tracking-normal text-emerald-200"
            />
          </label>
          <PatternSetter
            label="Set a NEW pattern for the restored vault"
            disabled={busy}
            size={200}
            onSet={(p) => void run(phrase, p)}
          />
        </div>
      )}

      <p role="alert" className="mt-3 min-h-4 text-center font-mono text-[11px] text-rose-400">
        {error}
      </p>
    </Modal>
  );
}
