import { fingerprint } from '../lib/format';
import { Button } from './ui';

export function Toolbar({
  unlocked,
  namespaceId,
  busy,
  canSave,
  onNew,
  onDownload,
  onSave,
  onOpen,
  onLock,
}: {
  unlocked: boolean;
  namespaceId: string | null;
  busy: boolean;
  canSave: boolean;
  onNew: () => void;
  onDownload: () => void;
  onSave: () => void;
  onOpen: () => void;
  onLock: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-paper px-4 py-2.5">
      <h1 className="mr-2 font-serif text-xl font-bold tracking-tight">
        Ink<span className="text-indigo-ink">Vault</span>
      </h1>
      <nav aria-label="Note actions" className="flex flex-1 flex-wrap items-center gap-2">
        <Button onClick={onNew}>New Note</Button>
        <Button onClick={onDownload} title="Saves a readable, unencrypted .md file to your downloads">
          Download .md (Plaintext)
        </Button>
        <span className="mx-1 hidden h-5 w-px bg-rule sm:block" aria-hidden="true" />
        <Button tone="primary" disabled={busy || !canSave} onClick={onSave} title="Encrypt on this device and keep in your vault (Ctrl/⌘+S)">
          Save to Encrypted Vault
        </Button>
        <Button disabled={busy} onClick={onOpen}>
          Open from Vault
        </Button>
      </nav>
      {unlocked ? (
        <div className="flex items-center gap-2">
          <span
            className="rounded-full border border-indigo-ink/30 bg-indigo-50 px-2.5 py-0.5 font-mono text-xs text-indigo-deep"
            title="Fingerprint of the unlocked vault"
          >
            vault <span data-testid="ns-fingerprint">{fingerprint(namespaceId)}</span>
          </span>
          <Button tone="danger" onClick={onLock} aria-label="Lock the vault and clear the editor">
            Lock Vault
          </Button>
        </div>
      ) : null}
    </header>
  );
}
