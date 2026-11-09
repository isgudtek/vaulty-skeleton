import { PatternGrid } from '@vaulty/core/react';
import type { PatternNode } from '@vaulty/core';
import { useState } from 'react';
import { GRID_SKIN, samePattern } from '../lib/skin';

/**
 * Draw-twice pattern entry used to *set* a pattern (duress, recovery re-key).
 * The first drawing is held only in component state and dropped as soon as it is confirmed or rejected.
 */
export function PatternSetter({
  label,
  disabled = false,
  onSet,
  size = 220,
}: {
  label: string;
  disabled?: boolean;
  onSet: (pattern: PatternNode[]) => void;
  size?: number;
}) {
  const [first, setFirst] = useState<PatternNode[] | null>(null);
  const [message, setMessage] = useState<string>('');

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="font-mono text-[11px] uppercase tracking-wider text-slate-400">
        {first ? 'Draw it again to confirm' : label}
      </p>
      <PatternGrid
        size={size}
        {...GRID_SKIN}
        disabled={disabled}
        ariaLabel={`${label}. Drag across at least six dots, or use arrow keys, Space and Enter.`}
        onError={() => setMessage('Connect at least 6 dots.')}
        onComplete={(pattern) => {
          if (!first) {
            setFirst(pattern);
            setMessage('');
            return;
          }
          if (samePattern(first, pattern)) {
            setFirst(null);
            setMessage('');
            onSet(pattern);
          } else {
            setFirst(null);
            setMessage('Patterns did not match. Start again.');
          }
        }}
      />
      <p role="status" aria-live="polite" className="min-h-4 font-mono text-[11px] text-amber-300">
        {message}
      </p>
    </div>
  );
}
