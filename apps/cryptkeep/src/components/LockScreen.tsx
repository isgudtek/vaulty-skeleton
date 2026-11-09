import type { PatternNode } from '@vaulty/core';
import { PatternGrid, type UseVaultResult } from '@vaulty/core/react';
import { GRID_SKIN } from '../lib/format';
import { Button, Lcd, Led } from './ui';

export function LockScreen({
  vault,
  storeKind,
  onPattern,
  onRecover,
}: {
  vault: UseVaultResult;
  storeKind: string;
  onPattern: (pattern: PatternNode[]) => void;
  onRecover: () => void;
}) {
  const unlocking = vault.status === 'unlocking';
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-5 px-4 py-8">
      <header className="w-full text-center">
        <p className="mb-1 text-[10px] font-black uppercase tracking-[0.4em] text-zinc-500">air-gapped style vault</p>
        <h1 className="text-3xl font-black tracking-[0.2em]">CRYPTKEEP</h1>
      </header>

      <div
        className="w-full rounded-2xl border-2 border-carbon bg-white p-4 shadow-[8px_8px_0_0_#18181b]"
        aria-busy={unlocking}
      >
        <Lcd className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Led on={unlocking} />
            {unlocking ? 'DERIVING KEYS…' : 'LOCKED · ENTER PATTERN'}
          </span>
          <span className="text-zinc-500">{storeKind.toUpperCase()}</span>
        </Lcd>

        <div className="mx-auto w-fit rounded-xl border-2 border-carbon bg-carbon p-4">
          <PatternGrid
            size={280}
            {...GRID_SKIN}
            disabled={unlocking}
            ariaLabel="Unlock pattern. Drag across at least six dots, or use the arrow keys to move, Space to select and Enter to confirm."
            onComplete={onPattern}
            onError={() => undefined}
          />
        </div>

        <ul className="mt-3 flex flex-wrap justify-center gap-2 font-mono text-[11px]" aria-label="Keyboard controls">
          {[
            ['←↑↓→', 'move'],
            ['SPACE', 'select'],
            ['⌫', 'undo'],
            ['ENTER', 'confirm'],
            ['ESC', 'clear'],
          ].map(([key, what]) => (
            <li key={key} className="flex items-center gap-1">
              <kbd className="rounded border-2 border-carbon bg-paper px-1.5 py-0.5 font-bold">{key}</kbd>
              <span className="text-zinc-600">{what}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-center font-mono text-[11px] text-zinc-500">
          {unlocking ? 'PBKDF2-HMAC-SHA256 × 600,000 · AES-256-GCM' : 'Connect at least 6 dots'}
        </p>
      </div>

      <p className="max-w-xs text-center text-xs leading-relaxed text-zinc-600">Draw your pattern to unlock the vault.</p>

      <p role="alert" className="min-h-4 text-center font-mono text-xs text-alert">
        {vault.error ? 'Storage unavailable. Check browser permissions and try again.' : ''}
      </p>

      <Button tone="primary" onClick={onRecover}>
        Recover Vault with 9-Word Phrase
      </Button>
    </div>
  );
}
