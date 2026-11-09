import type { VaultRecord } from '@vaulty/core';
import type { UseVaultResult } from '@vaulty/core/react';
import { useEffect, useRef, useState } from 'react';
import type { ClipboardGuard } from '../lib/clipboard';
import { errorMessage } from '../lib/format';
import { NETWORKS, type SeedEntry, TAG_SEED, parseSeedWords, validateSeed } from '../lib/records';
import { Button, Card, inputClass, labelClass } from './ui';

/** A revealed word hides itself again after this long. */
export const REVEAL_MS = 10_000;

function AddSeedForm({ vault }: { vault: UseVaultResult }) {
  const [label, setLabel] = useState('');
  const [network, setNetwork] = useState<string>(NETWORKS[0]);
  const [wordCount, setWordCount] = useState<12 | 24>(12);
  const [words, setWords] = useState('');
  const [path, setPath] = useState("m/44'/0'/0'/0/0");
  const [notes, setNotes] = useState('');
  const [allowOther, setAllowOther] = useState(false);
  const [showWords, setShowWords] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');

  const submit = async () => {
    setSaved('');
    const list = parseSeedWords(words);
    const problems = validateSeed(list, wordCount, allowOther).errors;
    if (label.trim() === '') problems.unshift('Give this wallet a label.');
    setErrors(problems);
    if (problems.length > 0) return;
    setBusy(true);
    try {
      const entry: SeedEntry = {
        label: label.trim(),
        network,
        wordCount,
        words: list,
        derivationPath: path.trim(),
        notes: notes.trim(),
      };
      await vault.putRecord<SeedEntry>(entry, { name: entry.label, tags: [TAG_SEED] });
      setSaved(`“${entry.label}” sealed in the vault.`);
      setLabel('');
      setWords(''); // drop the plaintext words from the form immediately
      setNotes('');
    } catch (e) {
      setErrors([errorMessage(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-3 rounded-lg border-2 border-dashed border-carbon bg-paper p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="Add seed phrase"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Wallet label
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Cold wallet #1" />
        </label>
        <label className={labelClass}>
          Network
          <select className={inputClass} value={network} onChange={(e) => setNetwork(e.target.value)}>
            {NETWORKS.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="flex items-center gap-4">
        <legend className={labelClass}>Length</legend>
        {([12, 24] as const).map((n) => (
          <label key={n} className="flex items-center gap-1 text-sm font-bold">
            <input type="radio" name="wordCount" checked={wordCount === n} onChange={() => setWordCount(n)} className="accent-amber-500" />
            {n} words
          </label>
        ))}
      </fieldset>

      <label className={labelClass}>
        Seed words
        <textarea
          rows={3}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Paste or type the words, separated by spaces"
          className={`${inputClass} font-mono ${showWords ? '' : 'mask-text'}`}
          data-testid="seed-words-input"
        />
      </label>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2 font-bold">
          <input type="checkbox" checked={showWords} onChange={(e) => setShowWords(e.target.checked)} className="accent-amber-500" />
          Show while typing
        </label>
        <label className="flex items-center gap-2 font-bold">
          <input type="checkbox" checked={allowOther} onChange={(e) => setAllowOther(e.target.checked)} className="accent-amber-500" />
          Other word list (not BIP-39)
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Derivation path
          <input className={`${inputClass} font-mono`} value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        <label className={labelClass}>
          Notes
          <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Passphrase hint, location…" />
        </label>
      </div>

      {errors.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 font-mono text-[11px] text-alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <p role="status" aria-live="polite" className="min-h-4 font-mono text-[11px] text-amber-deep">
        {saved}
      </p>
      <Button type="submit" tone="primary" disabled={busy} className="justify-self-start">
        Seal seed phrase
      </Button>
    </form>
  );
}

function SeedCard({
  record,
  vault,
  clipboard,
}: {
  record: VaultRecord<SeedEntry>;
  vault: UseVaultResult;
  clipboard: ClipboardGuard;
}) {
  const { label, network, words, derivationPath, notes, wordCount } = record.data;
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t.values()) clearTimeout(id);
      t.clear();
    };
  }, []);

  const hide = (i: number) => {
    const t = timers.current.get(i);
    if (t) clearTimeout(t);
    timers.current.delete(i);
    setRevealed((prev) => {
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
  };

  const toggle = (i: number) => {
    if (revealed.has(i)) return hide(i);
    setRevealed((prev) => new Set(prev).add(i));
    timers.current.set(
      i,
      setTimeout(() => hide(i), REVEAL_MS),
    );
  };

  const hideAll = () => {
    for (const i of [...revealed]) hide(i);
  };

  const copy = async () => {
    setMessage('');
    try {
      await clipboard.copy(words.join(' '));
      setMessage('Copied. Clipboard clears automatically.');
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  return (
    <li className="rounded-lg border-2 border-carbon bg-white p-3" data-testid="seed-card">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-black">{label}</p>
          <p className="font-mono text-[11px] uppercase text-zinc-500">
            {network} · {wordCount} words · {derivationPath || 'no path'}
          </p>
        </div>
        <div className="flex gap-2">
          {revealed.size > 0 ? <Button onClick={hideAll}>Hide all</Button> : null}
          <Button onClick={() => void copy()} aria-label={`Copy seed phrase for ${label}`}>
            Copy
          </Button>
          {confirming ? (
            <Button
              tone="danger"
              aria-label={`Confirm delete ${label}`}
              onClick={() => void vault.deleteFile(record.id).catch((e: unknown) => setMessage(errorMessage(e)))}
            >
              Confirm
            </Button>
          ) : (
            <Button tone="danger" aria-label={`Delete ${label}`} onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label={`Seed words for ${label}`}>
        {words.map((w, i) => {
          const shown = revealed.has(i);
          return (
            <li key={i}>
              <button
                type="button"
                aria-pressed={shown}
                aria-label={`Word ${i + 1}: ${shown ? w : 'hidden'}. Activate to ${shown ? 'hide' : 'reveal'}.`}
                onClick={() => toggle(i)}
                className={`flex w-full items-baseline gap-2 rounded border-2 px-2 py-1 text-left font-mono text-sm ${
                  shown ? 'border-carbon bg-amber-key text-carbon' : 'border-carbon bg-carbon text-amber-key'
                }`}
              >
                <span className="w-5 text-right text-[10px] opacity-70">{i + 1}</span>
                <span data-testid={`seed-word-${i + 1}`}>{shown ? w : '•••••'}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {notes ? <p className="mt-2 text-xs text-zinc-600">Note: {notes}</p> : null}
      <p role="status" aria-live="polite" className="mt-1 min-h-4 font-mono text-[11px] text-amber-deep">
        {message}
      </p>
    </li>
  );
}

export function SeedManager({
  vault,
  seeds,
  clipboard,
}: {
  vault: UseVaultResult;
  seeds: VaultRecord<SeedEntry>[];
  clipboard: ClipboardGuard;
}) {
  return (
    <Card title="Seed phrases" hint={`${seeds.length} stored`}>
      <AddSeedForm vault={vault} />
      {seeds.length === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-zinc-500">No seed phrases yet.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {seeds.map((s) => (
            <SeedCard key={s.id} record={s} vault={vault} clipboard={clipboard} />
          ))}
        </ul>
      )}
    </Card>
  );
}
