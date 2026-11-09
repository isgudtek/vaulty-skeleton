import type { VaultRecord } from '@vaulty/core';
import type { UseVaultResult } from '@vaulty/core/react';
import { useEffect, useState } from 'react';
import type { ClipboardGuard } from '../lib/clipboard';
import { errorMessage } from '../lib/format';
import { useNow } from '../lib/hooks';
import { TAG_TOTP, type TotpEntry } from '../lib/records';
import { groupCode, isValidBase32, normalizeBase32, parseOtpauth, secondsRemaining, timeStep, totp } from '../lib/totp';
import { Button, Card, inputClass, labelClass } from './ui';

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

/** 30-second countdown ring; turns red for the last five seconds. */
function CountdownRing({ remaining, period }: { remaining: number; period: number }) {
  const urgent = remaining <= 5;
  return (
    <div className="relative h-14 w-14 shrink-0" role="img" aria-label={`${remaining} seconds until this code changes`}>
      <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
        <circle cx="28" cy="28" r={RING_R} fill="none" stroke="#D4D4D8" strokeWidth="5" />
        <circle
          cx="28"
          cy="28"
          r={RING_R}
          fill="none"
          stroke={urgent ? '#DC2626' : '#F59E0B'}
          strokeWidth="5"
          strokeLinecap="butt"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - remaining / period)}
          data-testid="totp-ring"
        />
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center font-mono text-sm font-bold ${urgent ? 'text-alert' : ''}`}
        data-testid="totp-remaining"
      >
        {remaining}
      </span>
    </div>
  );
}

function TotpCard({
  record,
  now,
  vault,
  clipboard,
}: {
  record: VaultRecord<TotpEntry>;
  now: number;
  vault: UseVaultResult;
  clipboard: ClipboardGuard;
}) {
  const { issuer, account, secret, period, digits, algorithm } = record.data;
  const step = timeStep(now, period);
  const remaining = secondsRemaining(now, period);
  const [code, setCode] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    totp(secret, step * period * 1000, { period, digits, algorithm })
      .then((c) => !cancelled && setCode(c))
      .catch(() => !cancelled && setCode(''));
    return () => {
      cancelled = true;
    };
  }, [secret, step, period, digits, algorithm]);

  return (
    <li className="flex flex-wrap items-center gap-4 rounded-lg border-2 border-carbon bg-white p-3" data-testid="totp-card">
      <CountdownRing remaining={remaining} period={period} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-black">{issuer || 'Unnamed service'}</p>
        <p className="truncate font-mono text-[11px] text-zinc-500">{account}</p>
        <p className="mt-1 font-mono text-3xl font-bold tracking-[0.12em]" aria-live="off" data-testid="totp-code">
          {code ? groupCode(code) : '······'}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          disabled={!code}
          aria-label={`Copy code for ${issuer} ${account}`}
          onClick={() =>
            void clipboard
              .copy(code)
              .then(() => setMessage('Copied.'))
              .catch((e: unknown) => setMessage(errorMessage(e)))
          }
        >
          Copy
        </Button>
        {confirming ? (
          <Button
            tone="danger"
            aria-label={`Confirm delete ${issuer} ${account}`}
            onClick={() => void vault.deleteFile(record.id).catch((e: unknown) => setMessage(errorMessage(e)))}
          >
            Confirm
          </Button>
        ) : (
          <Button tone="danger" aria-label={`Delete ${issuer} ${account}`} onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="w-full min-h-4 font-mono text-[11px] text-amber-deep">
        {message}
      </p>
    </li>
  );
}

function AddTotpForm({ vault, clock }: { vault: UseVaultResult; clock: () => number }) {
  const [source, setSource] = useState('');
  const [issuer, setIssuer] = useState('');
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setSaved('');
    setBusy(true);
    try {
      let entry: TotpEntry;
      if (source.trim().toLowerCase().startsWith('otpauth://')) {
        const p = parseOtpauth(source);
        entry = { ...p, issuer: issuer.trim() || p.issuer, account: account.trim() || p.account };
      } else {
        if (!isValidBase32(source)) throw new Error('Enter a Base32 setup key (16+ characters, A–Z and 2–7) or an otpauth:// link.');
        entry = {
          issuer: issuer.trim(),
          account: account.trim(),
          secret: normalizeBase32(source),
          digits: 6,
          period: 30,
          algorithm: 'SHA1',
        };
      }
      if (!entry.issuer && !entry.account) throw new Error('Add an issuer or an account name.');
      await totp(entry.secret, clock(), entry); // proves the secret decodes before we seal it
      await vault.putRecord<TotpEntry>(entry, {
        name: `${entry.issuer} ${entry.account}`.trim(),
        tags: [TAG_TOTP],
      });
      setSaved(`${entry.issuer || entry.account} added.`);
      setSource(''); // drop the plaintext secret from the form
      setIssuer('');
      setAccount('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-3 rounded-lg border-2 border-dashed border-carbon bg-paper p-3"
      aria-label="Add authenticator"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className={labelClass}>
        Setup key or otpauth:// link
        <input
          className={`${inputClass} font-mono`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="JBSWY3DPEHPK3PXP"
          data-testid="totp-source"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Issuer
          <input className={inputClass} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="GitHub" />
        </label>
        <label className={labelClass}>
          Account
          <input className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="you@example.com" />
        </label>
      </div>
      <p role="alert" className="min-h-4 font-mono text-[11px] text-alert">
        {error}
      </p>
      <p role="status" aria-live="polite" className="min-h-4 font-mono text-[11px] text-amber-deep">
        {saved}
      </p>
      <Button type="submit" tone="primary" disabled={busy} className="justify-self-start">
        Add authenticator
      </Button>
    </form>
  );
}

export function TotpManager({
  vault,
  codes,
  clipboard,
  clock,
}: {
  vault: UseVaultResult;
  codes: VaultRecord<TotpEntry>[];
  clipboard: ClipboardGuard;
  clock: () => number;
}) {
  const now = useNow(clock);
  return (
    <Card title="Authenticator" hint="RFC 6238 · offline">
      <AddTotpForm vault={vault} clock={clock} />
      {codes.length === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-zinc-500">No authenticators yet.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {codes.map((r) => (
            <TotpCard key={r.id} record={r} now={now} vault={vault} clipboard={clipboard} />
          ))}
        </ul>
      )}
    </Card>
  );
}
