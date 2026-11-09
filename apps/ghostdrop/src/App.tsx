import type { PatternNode } from '@vaulty/core';
import { type UseVaultOptions, useVault } from '@vaulty/core/react';
import { useCallback, useEffect, useState } from 'react';
import { getAdapter } from './lib/adapter';
import { RecoveryModal } from './components/identity';
import { LockScreen } from './components/LockScreen';
import { RestoreModal } from './components/settings';
import { VaultScreen } from './components/VaultScreen';

/** Auto-lock after this much inactivity (the tab being hidden always locks immediately). */
export const IDLE_MS = 120_000;

export interface AppProps {
  /** Test/embedding hook: override storage adapter, KDF cost, etc. */
  vaultOptions?: UseVaultOptions;
}

export function App({ vaultOptions }: AppProps) {
  const [storeKind, setStoreKind] = useState(() => {
    const a = vaultOptions?.adapter;
    return a && typeof a === 'object' ? a.kind : 'probing';
  });
  const [options] = useState<UseVaultOptions>(() => ({
    idleTimeoutMs: IDLE_MS,
    ...vaultOptions,
    adapter: vaultOptions?.adapter ?? getAdapter, // OPFS → IndexedDB → memory
  }));
  const vault = useVault(options);

  // Show the detected storage backend on the lock screen, before the first unlock.
  const injectedAdapter = vaultOptions?.adapter;
  useEffect(() => {
    if (injectedAdapter) return;
    let alive = true;
    void getAdapter().then((a) => alive && setStoreKind(a.kind));
    return () => {
      alive = false;
    };
  }, [injectedAdapter]);

  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Bumped after a duress wipe so every screen remounts with clean local state.
  const [epoch, setEpoch] = useState(0);

  const { unlock, isUnlocked } = vault;

  useEffect(() => {
    if (!isUnlocked) setRecoveryPhrase(null); // the phrase never outlives the unlocked session
  }, [isUnlocked]);

  const onPattern = useCallback(
    async (pattern: PatternNode[]) => {
      try {
        const res = await unlock(pattern);
        if (res.status === 'duress_triggered') {
          setRecoveryPhrase(null);
          setRestoreOpen(false);
          setEpoch((e) => e + 1);
        } else if (res.created && res.recoveryPhrase) {
          setRecoveryPhrase(res.recoveryPhrase);
        }
      } catch {
        /* surfaced through vault.error */
      }
    },
    [unlock],
  );

  return (
    <main>
      {isUnlocked ? (
        <VaultScreen
          key={`vault-${epoch}`}
          vault={vault}
          storeKind={storeKind}
          idleSeconds={(options.idleTimeoutMs ?? IDLE_MS) / 1000}
          onImport={() => setRestoreOpen(true)}
        />
      ) : (
        <LockScreen
          key={`lock-${epoch}`}
          vault={vault}
          storeKind={storeKind}
          onPattern={(p) => void onPattern(p)}
          onRestore={() => setRestoreOpen(true)}
        />
      )}
      {recoveryPhrase ? <RecoveryModal phrase={recoveryPhrase} onConfirm={() => setRecoveryPhrase(null)} /> : null}
      {restoreOpen ? (
        <RestoreModal vault={vault} replacing={isUnlocked} onClose={() => setRestoreOpen(false)} />
      ) : null}
    </main>
  );
}
