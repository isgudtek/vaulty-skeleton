import type { PatternNode } from '@vaulty/core';
import { type UseVaultOptions, useVault } from '@vaulty/core/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdapter } from './lib/adapter';
import { RestoreModal } from './components/Backup';
import { RecoveryModal } from './components/identity';
import { LockScreen } from './components/LockScreen';
import { MadeWith } from './components/MadeWith';
import { VaultScreen } from './components/VaultScreen';
import { CLIPBOARD_CLEAR_MS, ClipboardGuard, type ClipboardLike } from './lib/clipboard';
import { useRecords } from './lib/hooks';
import { type SeedEntry, TAG_SEED, TAG_TOTP, type TotpEntry } from './lib/records';

/** Auto-lock after this much inactivity (a hidden tab always locks immediately). */
export const IDLE_MS = 90_000;

export interface AppProps {
  /** Test/embedding hook: override storage adapter, KDF cost, etc. */
  vaultOptions?: UseVaultOptions;
  clipboard?: ClipboardLike;
  clipboardClearMs?: number;
  /** Wall clock used for TOTP (injectable so tests can pin RFC 6238 timestamps). */
  clock?: () => number;
}

export function App({ vaultOptions, clipboard, clipboardClearMs = CLIPBOARD_CLEAR_MS, clock = Date.now }: AppProps) {
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
  const { unlock, isUnlocked } = vault;

  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const [restore, setRestore] = useState<null | 'pattern' | 'phrase'>(null);
  const [clipboardSeconds, setClipboardSeconds] = useState<number | null>(null);

  const guardRef = useRef<ClipboardGuard | null>(null);
  if (guardRef.current === null) {
    const guardOptions: ConstructorParameters<typeof ClipboardGuard>[0] = {
      clearAfterMs: clipboardClearMs,
      onTick: setClipboardSeconds,
    };
    if (clipboard) guardOptions.clipboard = clipboard;
    guardRef.current = new ClipboardGuard(guardOptions);
  }
  const guard = guardRef.current;

  useEffect(() => () => guard.dispose(), [guard]);

  useEffect(() => {
    if (!isUnlocked) {
      setRecoveryPhrase(null); // the phrase never outlives the unlocked session
      void guard.clearNow(); // and a copied secret never outlives it either
    }
  }, [isUnlocked, guard]);

  const seeds = useRecords<SeedEntry>(vault, TAG_SEED);
  const codes = useRecords<TotpEntry>(vault, TAG_TOTP);

  const onPattern = useCallback(
    async (pattern: PatternNode[]) => {
      try {
        const res = await unlock(pattern);
        if (res.status === 'unlocked' && res.created && res.recoveryPhrase) setRecoveryPhrase(res.recoveryPhrase);
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
          vault={vault}
          seeds={seeds}
          codes={codes}
          clipboard={guard}
          clipboardSeconds={clipboardSeconds}
          clock={clock}
          storeKind={storeKind}
          idleSeconds={(options.idleTimeoutMs ?? IDLE_MS) / 1000}
          onRestore={() => setRestore('pattern')}
        />
      ) : (
        <LockScreen vault={vault} storeKind={storeKind} onPattern={(p) => void onPattern(p)} onRecover={() => setRestore('phrase')} />
      )}
      {recoveryPhrase ? <RecoveryModal phrase={recoveryPhrase} onConfirm={() => setRecoveryPhrase(null)} /> : null}
      {restore ? (
        <RestoreModal vault={vault} initialMethod={restore} replacing={isUnlocked} onClose={() => setRestore(null)} />
      ) : null}
      <MadeWith />
    </main>
  );
}
