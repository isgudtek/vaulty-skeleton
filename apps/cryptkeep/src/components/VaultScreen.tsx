import type { VaultRecord } from '@vaulty/core';
import type { UseVaultResult } from '@vaulty/core/react';
import { useState } from 'react';
import type { ClipboardGuard } from '../lib/clipboard';
import type { SeedEntry, TotpEntry } from '../lib/records';
import { BackupPanel } from './Backup';
import { NamespaceBadge } from './identity';
import { SeedManager } from './SeedManager';
import { TotpManager } from './TotpManager';
import { Button, Lcd, Led } from './ui';

type Tab = 'seeds' | 'totp' | 'backup';

const TABS: Array<[Tab, string]> = [
  ['seeds', 'Seed phrases'],
  ['totp', 'Authenticator'],
  ['backup', 'Snapshot'],
];

export function VaultScreen({
  vault,
  seeds,
  codes,
  clipboard,
  clipboardSeconds,
  clock,
  storeKind,
  idleSeconds,
  onRestore,
}: {
  vault: UseVaultResult;
  seeds: VaultRecord<SeedEntry>[];
  codes: VaultRecord<TotpEntry>[];
  clipboard: ClipboardGuard;
  clipboardSeconds: number | null;
  clock: () => number;
  storeKind: string;
  idleSeconds: number;
  onRestore: () => void;
}) {
  const [tab, setTab] = useState<Tab>('seeds');

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-carbon bg-carbon p-3 text-paper">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-black tracking-[0.2em]">CRYPTKEEP</h1>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-amber-key">
            <Led /> unsealed
          </span>
          <NamespaceBadge namespaceId={vault.namespaceId} />
        </div>
        <Button tone="primary" onClick={() => vault.lock()} aria-label="Lock the vault now">
          ⏻ Lock
        </Button>
      </header>

      {clipboardSeconds !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border-2 border-carbon bg-amber-key px-3 py-2 text-sm font-bold"
          data-testid="clipboard-banner"
        >
          <span>
            Secret on clipboard — clearing in <span data-testid="clipboard-seconds">{clipboardSeconds}</span>s
          </span>
          <Button onClick={() => void clipboard.clearNow()}>Clear now</Button>
        </div>
      ) : null}

      <div role="tablist" aria-label="Vault sections" className="mb-4 flex flex-wrap gap-2">
        {TABS.map(([id, label]) => (
          <Button
            key={id}
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tone={tab === id ? 'primary' : 'ghost'}
            onClick={() => setTab(id)}
          >
            {label}
          </Button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'seeds' ? <SeedManager vault={vault} seeds={seeds} clipboard={clipboard} /> : null}
        {tab === 'totp' ? <TotpManager vault={vault} codes={codes} clipboard={clipboard} clock={clock} /> : null}
        {tab === 'backup' ? <BackupPanel vault={vault} onRestore={onRestore} /> : null}
      </div>

      <Lcd className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-[10px] uppercase tracking-wider" aria-label="Cryptographic telemetry">
        <span>kdf pbkdf2-sha256 ×600,000</span>
        <span>aes-256-gcm</span>
        <span>store {storeKind}</span>
        <span>seeds {seeds.length}</span>
        <span>2fa {codes.length}</span>
        <span>auto-lock {idleSeconds}s</span>
      </Lcd>
    </div>
  );
}
