import { PatternGrid, type UseVaultResult } from '@vaulty/core/react';
import type { PatternNode } from '@vaulty/core';
import { GRID_SKIN } from '../lib/skin';
import { Button, StatusDot } from './ui';

export function LockScreen({
  vault,
  storeKind,
  onPattern,
  onRestore,
}: {
  vault: UseVaultResult;
  storeKind: string;
  onPattern: (pattern: PatternNode[]) => void;
  onRestore: () => void;
}) {
  const unlocking = vault.status === 'unlocking';
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-4 py-10">
      <header className="text-center">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.35em] text-slate-500">zero-knowledge field vault</p>
        <h1 className="font-mono text-3xl font-bold tracking-[0.25em] text-emerald-signal">GHOSTDROP</h1>
      </header>

      <div
        className="rounded-xl border border-line bg-panel/90 p-5 shadow-[0_0_80px_rgba(16,185,129,0.07)]"
        aria-busy={unlocking}
      >
        <div className="mb-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-slate-500">
          <span className="flex items-center gap-2">
            <StatusDot on={!unlocking} />
            {unlocking ? 'deriving keys' : 'sealed'}
          </span>
          <span>store: {storeKind}</span>
        </div>
        <PatternGrid
          size={300}
          {...GRID_SKIN}
          disabled={unlocking}
          style={{ display: 'block', margin: '0 auto' }}
          ariaLabel="Unlock pattern. Drag across at least six dots, or use the arrow keys to move, Space to select and Enter to confirm."
          onComplete={onPattern}
          onError={() => undefined}
        />
        <p className="mt-3 text-center font-mono text-[11px] text-slate-500">
          {unlocking
            ? 'PBKDF2-HMAC-SHA256 × 600,000 · AES-256-GCM'
            : 'Connect ≥ 6 dots · ←↑↓→ move · Space select · Enter confirm'}
        </p>
      </div>

      <p className="max-w-xs text-center text-xs leading-relaxed text-slate-500">
        Draw your pattern to unseal the vault.
      </p>

      <p role="alert" className="min-h-4 text-center font-mono text-xs text-rose-400">
        {vault.error ? 'Storage unavailable. Check browser permissions and try again.' : ''}
      </p>

      <Button onClick={onRestore}>Restore .vault backup</Button>
    </div>
  );
}
