import type { VaultRecord } from '@vaulty/core';
import type { UseVaultResult } from '@vaulty/core/react';
import { useEffect, useRef, useState } from 'react';

/**
 * Load and decrypt every record carrying `tag` via `VaultClient.getRecord<T>()`.
 * Re-runs whenever the encrypted index changes; the decrypted list is dropped the moment the vault locks.
 */
export function useRecords<T>(vault: UseVaultResult, tag: string): VaultRecord<T>[] {
  const [items, setItems] = useState<VaultRecord<T>[]>([]);
  const getRecordRef = useRef(vault.getRecord);
  getRecordRef.current = vault.getRecord;

  const signature = vault.isUnlocked
    ? vault.entries
        .filter((e) => e.tags.includes(tag))
        .map((e) => `${e.id}:${e.updatedAt}`)
        .join('|')
    : null;

  useEffect(() => {
    if (signature === null) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const ids = signature === '' ? [] : signature.split('|').map((s) => s.split(':')[0] as string);
    void (async () => {
      const loaded: VaultRecord<T>[] = [];
      for (const id of ids) {
        try {
          loaded.push(await getRecordRef.current<T>(id));
        } catch {
          /* vault locked mid-load, or record removed: skip */
        }
        if (cancelled) return;
      }
      if (!cancelled) setItems(loaded.sort((a, b) => a.createdAt - b.createdAt));
    })();
    return () => {
      cancelled = true;
    };
  }, [signature]);

  return items;
}

/** A ticking clock. `clock` is injectable so tests can pin RFC 6238 timestamps. */
export function useNow(clock: () => number, intervalMs = 250): number {
  const [now, setNow] = useState(() => clock());
  const clockRef = useRef(clock);
  clockRef.current = clock;
  useEffect(() => {
    const t = setInterval(() => setNow(clockRef.current()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
