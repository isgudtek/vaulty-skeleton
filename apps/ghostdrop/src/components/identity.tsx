import { fingerprint } from '../lib/format';
import { Button, Modal } from './ui';

/** Short fingerprint of the active vault namespace. Different patterns ⇒ different, isolated vaults. */
export function NamespaceBadge({ namespaceId }: { namespaceId: string | null }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded border border-emerald-signal/30 bg-emerald-signal/5 px-2 py-1 font-mono text-[11px] tracking-wider text-emerald-300"
      title="Active vault namespace fingerprint. Every pattern opens its own completely isolated vault."
    >
      <span className="text-slate-500">NS▸</span>
      <span data-testid="ns-fingerprint">{fingerprint(namespaceId)}</span>
    </span>
  );
}

/** One-time 9-word recovery phrase. It is never stored: closing this dialog discards it for good. */
export function RecoveryModal({ phrase, onConfirm }: { phrase: string; onConfirm: () => void }) {
  const words = phrase.split(' ');
  return (
    <Modal title="New vault · recovery phrase" dismissible={false}>
      <p className="mb-3 text-sm text-slate-300">
        A new, empty vault was created for this pattern. These <strong>9 words</strong> are the only way to restore a{' '}
        <code className="font-mono text-emerald-300">.vault</code> backup if you forget the pattern.
      </p>
      <ol
        aria-label="Recovery phrase"
        className="mb-4 grid grid-cols-3 gap-2 rounded-md border border-emerald-signal/30 bg-panel p-3 font-mono text-sm"
        data-testid="recovery-words"
      >
        {words.map((w, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="w-4 text-right text-[10px] text-slate-500">{i + 1}</span>
            <span className="text-emerald-300">{w}</span>
          </li>
        ))}
      </ol>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-xs text-slate-400">
        <li>Shown once. GhostDrop does not store it anywhere and cannot show it again.</li>
        <li>Write it on paper. Do not screenshot, copy or upload it.</li>
        <li>Opened this vault by mistake? It is just an empty decoy — lock and carry on.</li>
      </ul>
      <Button tone="primary" className="w-full" data-autofocus onClick={onConfirm}>
        I have written this down
      </Button>
    </Modal>
  );
}
