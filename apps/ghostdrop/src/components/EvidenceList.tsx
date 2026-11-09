import type { VaultMetadataEntry } from '@vaulty/core';
import type { UseVaultResult } from '@vaulty/core/react';
import { useEffect, useRef, useState } from 'react';
import { downloadBytes } from '../lib/files';
import { formatBytes, formatDateTime, kindGlyph, previewKind } from '../lib/format';
import { errorMessage } from '../lib/skin';
import { Button, Modal, Panel } from './ui';

export function EvidenceList({
  vault,
  onPreview,
}: {
  vault: UseVaultResult;
  onPreview: (entry: VaultMetadataEntry) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState('');

  const download = async (entry: VaultMetadataEntry) => {
    setError('');
    try {
      const { data } = await vault.getFile(entry.id);
      downloadBytes(data, entry.name, entry.mimeType);
      data.fill(0);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Panel title="Sealed items" hint={`${vault.entries.length} item${vault.entries.length === 1 ? '' : 's'}`}>
      {vault.entries.length === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-slate-500">Vault is empty. Drop a file or record a note.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="evidence-list">
          {vault.entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="w-10 shrink-0 rounded border border-line bg-obsidian px-1 py-1 text-center font-mono text-[10px] text-emerald-300">
                {kindGlyph(entry.mimeType)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm text-slate-200" title={entry.name}>
                  {entry.name}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  {formatBytes(entry.size)} · {entry.mimeType} · {formatDateTime(entry.createdAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={previewKind(entry.mimeType) === 'none'}
                  onClick={() => onPreview(entry)}
                  aria-label={`Preview ${entry.name}`}
                >
                  Preview
                </Button>
                <Button onClick={() => void download(entry)} aria-label={`Download decrypted ${entry.name}`}>
                  Save
                </Button>
                {confirming === entry.id ? (
                  <Button
                    tone="danger"
                    aria-label={`Confirm delete ${entry.name}`}
                    onClick={() => {
                      setConfirming(null);
                      void vault.deleteFile(entry.id).catch((e: unknown) => setError(errorMessage(e)));
                    }}
                  >
                    Confirm
                  </Button>
                ) : (
                  <Button tone="danger" aria-label={`Delete ${entry.name}`} onClick={() => setConfirming(entry.id)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p role="alert" className="mt-2 min-h-4 font-mono text-[11px] text-rose-400">
        {error}
      </p>
    </Panel>
  );
}

/**
 * Zero-leak previewer. The file is decrypted into memory, copied into a Blob (the decrypted array is
 * zero-filled immediately), shown through a `blob:` URL, and the URL is revoked when the modal closes,
 * unmounts (e.g. the vault locks) or the tab becomes hidden.
 */
export function Previewer({
  entry,
  vault,
  lockOnClose,
  onClose,
}: {
  entry: VaultMetadataEntry;
  vault: UseVaultResult;
  lockOnClose: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const kind = previewKind(entry.mimeType);
  const getFileRef = useRef(vault.getFile);
  getFileRef.current = vault.getFile;

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    const revoke = () => {
      if (created) {
        URL.revokeObjectURL(created);
        created = null;
      }
    };
    void (async () => {
      try {
        const { data } = await getFileRef.current(entry.id);
        try {
          if (cancelled || kind === 'none') return;
          created = URL.createObjectURL(new Blob([data as BlobPart], { type: entry.mimeType }));
          setUrl(created);
        } finally {
          data.fill(0);
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        revoke();
        setUrl(null);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      revoke();
    };
  }, [entry.id, entry.mimeType, kind]);

  return (
    <Modal title="Decrypted preview" wide onClose={onClose}>
      <p className="mb-1 truncate font-mono text-sm text-slate-200">{entry.name}</p>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-slate-500">
        {formatBytes(entry.size)} · {entry.mimeType}
      </p>
      <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-md border border-line bg-black/60">
        {error ? (
          <p role="alert" className="p-4 font-mono text-xs text-rose-400">
            {error}
          </p>
        ) : !url ? (
          <p className="p-4 font-mono text-xs text-slate-500">{kind === 'none' ? 'No inline preview for this type.' : 'Decrypting…'}</p>
        ) : kind === 'image' ? (
          <img src={url} alt={entry.name} className="max-h-[60vh] max-w-full object-contain" />
        ) : kind === 'pdf' ? (
          <iframe title={entry.name} src={url} className="h-[60vh] w-full" />
        ) : kind === 'audio' ? (
          <audio controls src={url} className="w-full p-4" />
        ) : (
          <video controls src={url} className="max-h-[60vh] max-w-full" />
        )}
      </div>
      <p className="mt-3 font-mono text-[11px] text-slate-500">
        In-memory only. Closing revokes the object URL
        {lockOnClose ? ' and locks the vault' : ''}; switching tabs locks it too.
      </p>
      <div className="mt-3 flex justify-end">
        <Button tone="primary" onClick={onClose}>
          Close{lockOnClose ? ' & lock' : ''}
        </Button>
      </div>
    </Modal>
  );
}
