import type { VaultMetadataEntry } from '@vaulty/core';
import type { UseVaultResult } from '@vaulty/core/react';
import { useState } from 'react';
import { formatBytes } from '../lib/format';
import { EvidenceList, Previewer } from './EvidenceList';
import { NamespaceBadge } from './identity';
import { DropZone, VoiceRecorderPanel } from './intake';
import { ArchivePanel, DuressPanel } from './settings';
import { Button, Panel, StatusDot } from './ui';

export function VaultScreen({
  vault,
  storeKind,
  idleSeconds,
  onImport,
}: {
  vault: UseVaultResult;
  storeKind: string;
  idleSeconds: number;
  onImport: () => void;
}) {
  const [previewing, setPreviewing] = useState<VaultMetadataEntry | null>(null);
  // Paranoid default: closing a preview re-seals the vault. Session-only; never persisted.
  const [lockOnPreviewClose, setLockOnPreviewClose] = useState(true);
  const totalBytes = vault.entries.reduce((n, e) => n + e.size, 0);

  const closePreview = () => {
    setPreviewing(null);
    if (lockOnPreviewClose) vault.lock();
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-bold tracking-[0.25em] text-emerald-signal">GHOSTDROP</h1>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            <StatusDot /> unsealed
          </span>
          <NamespaceBadge namespaceId={vault.namespaceId} />
        </div>
        <Button tone="danger" onClick={() => vault.lock()} aria-label="Quick lock the vault now">
          ⏻ Quick Lock
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col gap-4">
          <DropZone vault={vault} />
          <VoiceRecorderPanel vault={vault} />
          <Panel title="Operational security">
            <label className="flex items-start gap-3 text-xs text-slate-300">
              <input
                type="checkbox"
                className="mt-0.5 accent-emerald-500"
                checked={lockOnPreviewClose}
                onChange={(e) => setLockOnPreviewClose(e.target.checked)}
              />
              <span>
                Lock the vault when a preview closes
                <span className="block font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  this session only · tab hide always locks
                </span>
              </span>
            </label>
          </Panel>
        </div>
        <div className="flex flex-col gap-4">
          <EvidenceList vault={vault} onPreview={setPreviewing} />
          <div className="grid items-start gap-4 md:grid-cols-2">
            <ArchivePanel vault={vault} onImport={onImport} />
            <DuressPanel vault={vault} />
          </div>
        </div>
      </div>

      <footer
        aria-label="Cryptographic telemetry"
        className="mt-6 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 font-mono text-[10px] uppercase tracking-wider text-slate-500"
        data-testid="telemetry"
      >
        <span>kdf: pbkdf2-sha256 ×600,000</span>
        <span>cipher: aes-256-gcm</span>
        <span>iv: 96-bit random / blob</span>
        <span>store: {storeKind}</span>
        <span>items: {vault.entries.length}</span>
        <span>plaintext: {formatBytes(totalBytes)}</span>
        <span>auto-lock: {idleSeconds}s idle · on hide</span>
      </footer>

      {previewing ? (
        <Previewer entry={previewing} vault={vault} lockOnClose={lockOnPreviewClose} onClose={closePreview} />
      ) : null}
    </div>
  );
}
