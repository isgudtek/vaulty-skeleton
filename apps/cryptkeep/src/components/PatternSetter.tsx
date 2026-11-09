import type { PatternNode } from '@vaulty/core';
import { PatternGrid } from '@vaulty/core/react';
import { useState } from 'react';
import { GRID_SKIN, samePattern } from '../lib/format';

/** Draw-twice entry used to SET a new pattern (vault recovery). The first drawing is dropped once checked. */
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
  const [message, setMessage] = useState('');

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-center text-[11px] font-black uppercase tracking-wider">
        {first ? 'Draw it again to confirm' : label}
      </p>
      <div className="rounded-xl border-2 border-carbon bg-carbon p-3">
        <PatternGrid
          size={size}
          {...GRID_SKIN}
          disabled={disabled}
          ariaLabel={`${label}. Drag across at least six dots, or use arrow keys to move, Space to select, Enter to confirm.`}
          onError={() => setMessage('Connect at least 6 dots.')}
          onComplete={(pattern) => {
            if (!first) {
              setFirst(pattern);
              setMessage('');
            } else if (samePattern(first, pattern)) {
              setFirst(null);
              setMessage('');
              onSet(pattern);
            } else {
              setFirst(null);
              setMessage('Patterns did not match. Start again.');
            }
          }}
        />
      </div>
      <p role="status" aria-live="polite" className="min-h-4 text-center font-mono text-[11px] text-amber-deep">
        {message}
      </p>
    </div>
  );
}
