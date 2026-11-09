import { fingerprint } from '../lib/format';
import { Button, Lcd, Modal } from './ui';

/** LCD-style fingerprint of the active vault namespace. */
export function NamespaceBadge({ namespaceId }: { namespaceId: string | null }) {
  return (
    <Lcd className="inline-flex items-center gap-2 py-1">
      <span className="text-zinc-500">VAULT</span>
      <span data-testid="ns-fingerprint" title="Fingerprint of the active vault. Each pattern opens its own isolated vault.">
        {fingerprint(namespaceId)}
      </span>
    </Lcd>
  );
}

/** One-time 9-word recovery phrase; never stored. */
export function RecoveryModal({ phrase, onConfirm }: { phrase: string; onConfirm: () => void }) {
  const words = phrase.split(' ');
  return (
    <Modal title="New vault · recovery phrase" dismissible={false}>
      <p className="mb-3 text-sm">
        A new, empty vault was created for this pattern. These <strong>9 words</strong> are the only way to restore a{' '}
        <code className="font-mono">.vault</code> snapshot if you forget the pattern.
      </p>
      <Lcd className="mb-4 p-3">
        <ol aria-label="Recovery phrase" className="grid grid-cols-3 gap-2 text-sm" data-testid="recovery-words">
          {words.map((w, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="w-4 text-right text-[10px] text-zinc-500">{i + 1}</span>
              <span>{w}</span>
            </li>
          ))}
        </ol>
      </Lcd>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-xs text-zinc-700">
        <li>Shown once. CryptKeep never stores it and cannot show it again.</li>
        <li>Write it on paper. Do not screenshot, copy or upload it.</li>
        <li>Opened this vault by mistake? It is an empty decoy — lock and carry on.</li>
      </ul>
      <Button tone="primary" className="w-full" data-autofocus onClick={onConfirm}>
        I have written this down
      </Button>
    </Modal>
  );
}
