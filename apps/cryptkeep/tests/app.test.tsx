import { MemoryStorageAdapter } from '@vaulty/core';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { REVEAL_MS } from '../src/components/SeedManager';
import { readBlobBytes } from '../src/lib/format';
import {
  NEW_PATTERN,
  PATTERN_A,
  PATTERN_B,
  type Mounted,
  buttonByText,
  chooseFile,
  click,
  draw,
  grids,
  mount,
  setNativeValue,
  settle,
  waitFor,
} from './helpers';

const FAST = 1_000;
const SEED_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let mounted: Mounted[] = [];
let objectUrls: Array<{ url: string; blob: Blob }> = [];
let clockMs = 59_000;
let clip: string[] = [];
const clipboard = { writeText: vi.fn(async (t: string) => void clip.push(t)) };

interface BootOptions {
  adapter?: MemoryStorageAdapter;
  clipboardClearMs?: number;
}

function boot({ adapter = new MemoryStorageAdapter(), clipboardClearMs }: BootOptions = {}) {
  const m = mount(
    <App
      vaultOptions={{ adapter, kdfIterations: FAST }}
      clipboard={clipboard}
      clock={() => clockMs}
      {...(clipboardClearMs ? { clipboardClearMs } : {})}
    />,
  );
  mounted.push(m);
  return { ...m, adapter };
}

const text = (m: Mounted) => m.container.textContent ?? '';
const dialog = () => document.querySelector('[role="dialog"]');
const badge = (m: Mounted) => m.container.querySelector('[data-testid="ns-fingerprint"]')?.textContent ?? '';
const tab = (m: Mounted, name: string) => click(buttonByText(m.container, name)!);

async function unlockAndConfirm(m: Mounted, pattern: number[]): Promise<string | null> {
  draw(grids(m.container)[0]!, pattern);
  await waitFor(() => dialog() || badge(m));
  const words = document.querySelector('[data-testid="recovery-words"]');
  if (!words) return null;
  const phrase = Array.from(words.querySelectorAll('li')).map((li) => li.textContent!.replace(/^\d+/, '')).join(' ');
  click(buttonByText(document.body, 'I have written this down')!);
  await settle();
  return phrase;
}

async function addSeed(m: Mounted, label: string, words: string, extra: { other?: boolean } = {}) {
  const form = m.container.querySelector<HTMLFormElement>('form[aria-label="Add seed phrase"]')!;
  setNativeValue(form.querySelector<HTMLInputElement>('input:not([type])')!, label);
  setNativeValue(form.querySelector<HTMLTextAreaElement>('[data-testid="seed-words-input"]')!, words);
  if (extra.other) click(Array.from(form.querySelectorAll('input[type="checkbox"]'))[1]!);
  click(buttonByText(form, 'Seal seed phrase')!);
}

async function addTotp(m: Mounted, source: string, issuer = '', account = '') {
  const form = m.container.querySelector<HTMLFormElement>('form[aria-label="Add authenticator"]')!;
  setNativeValue(form.querySelector<HTMLInputElement>('[data-testid="totp-source"]')!, source);
  const [iss, acc] = Array.from(form.querySelectorAll<HTMLInputElement>('input')).slice(1);
  setNativeValue(iss!, issuer);
  setNativeValue(acc!, account);
  click(buttonByText(form, 'Add authenticator')!);
}

beforeEach(() => {
  clockMs = 59_000;
  clip = [];
  clipboard.writeText.mockClear();
  objectUrls = [];
  let n = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:cryptkeep/${++n}`;
    objectUrls.push({ url, blob });
    return url;
  });
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  for (const m of mounted) m.unmount();
  mounted = [];
  document.body.innerHTML = '';
});

describe('CryptKeep · unlock, recovery entry points, accessibility', () => {
  it('renders an amber/carbon hardware-style lock screen with keyboard hints and a recovery entry point', () => {
    const m = boot();
    expect(text(m)).toContain('CRYPTKEEP');
    const svg = grids(m.container)[0]!;
    expect(svg.outerHTML).toContain('#52525B'); // carbon keypad skin
    expect(svg.getAttribute('aria-label')).toMatch(/arrow keys/i);
    expect(svg.tabIndex).toBe(0);
    const hints = Array.from(m.container.querySelectorAll('kbd')).map((k) => k.textContent);
    expect(hints).toEqual(['←↑↓→', 'SPACE', '⌫', 'ENTER', 'ESC']);
    expect(buttonByText(m.container, 'Recover Vault with 9-Word Phrase')).toBeDefined();
    // App-boundaries rule 6: the lock screen never hints at wrong patterns, decoys or duress.
    expect(text(m)).not.toMatch(/wrong|incorrect|invalid|isolated|decoy|duress|wipe|destroy|deniab/i);
  });

  it('creates a vault silently, shows the one-time phrase, then an LCD fingerprint', async () => {
    const m = boot();
    draw(grids(m.container)[0]!, PATTERN_A);
    await waitFor(() => dialog());
    expect(dialog()!.querySelectorAll('[data-testid="recovery-words"] li')).toHaveLength(9);
    click(buttonByText(document.body, 'I have written this down')!);
    await settle();
    expect(dialog()).toBeNull();
    expect(badge(m)).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
  });

  it('opens isolated vaults per pattern with no wrong-pattern errors', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    const badgeA = badge(m);
    await addSeed(m, 'Isolated wallet', SEED_12);
    await waitFor(() => text(m).includes('Isolated wallet'));
    click(buttonByText(m.container, /Lock$/)!);
    await settle();

    expect(await unlockAndConfirm(m, PATTERN_B)).not.toBeNull();
    expect(badge(m)).not.toBe(badgeA);
    expect(text(m)).not.toContain('Isolated wallet');
    expect(text(m)).toContain('No seed phrases yet');
    click(buttonByText(m.container, /Lock$/)!);
    await settle();
    expect(await unlockAndConfirm(m, PATTERN_A)).toBeNull();
    await waitFor(() => text(m).includes('Isolated wallet'));
  });
});

describe('CryptKeep · encrypted seed phrase manager', () => {
  it('stores a seed as an encrypted record, masks every word, and reveals words one at a time', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    await addSeed(m, 'Cold wallet #1', SEED_12);
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));

    // Masked by default: no seed word appears anywhere in the DOM.
    expect(m.container.querySelectorAll('[data-testid^="seed-word-"]')).toHaveLength(12);
    expect(text(m)).not.toContain('abandon');
    expect(text(m)).not.toContain('about');
    expect((m.container.querySelector('[data-testid="seed-words-input"]') as HTMLTextAreaElement).value).toBe('');
    expect(text(m)).toContain('Cold wallet #1');

    const word12 = m.container.querySelector('[data-testid="seed-word-12"]')!;
    click(word12.closest('button')!);
    expect(word12.textContent).toBe('about');
    expect(word12.closest('button')!.getAttribute('aria-pressed')).toBe('true');
    expect(m.container.querySelector('[data-testid="seed-word-1"]')!.textContent).toBe('•••••'); // others stay hidden

    click(word12.closest('button')!); // click again hides
    expect(m.container.querySelector('[data-testid="seed-word-12"]')!.textContent).toBe('•••••');

    // At rest it is ciphertext only.
    for (const ns of await adapter.listNamespaces()) {
      for (const name of await adapter.list(ns)) {
        const data = Buffer.from((await adapter.get(ns, name))!);
        expect(data.includes(Buffer.from('abandon'))).toBe(false);
        expect(data.includes(Buffer.from('Cold wallet'))).toBe(false);
      }
    }
  });

  it('auto-hides a revealed word after the timeout', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    await addSeed(m, 'Timer wallet', SEED_12);
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    click(m.container.querySelector('[data-testid="seed-word-3"]')!.closest('button')!);
    expect(m.container.querySelector('[data-testid="seed-word-3"]')!.textContent).toBe('abandon');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVEAL_MS - 1);
    });
    expect(m.container.querySelector('[data-testid="seed-word-3"]')!.textContent).toBe('abandon');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(m.container.querySelector('[data-testid="seed-word-3"]')!.textContent).toBe('•••••');
  });

  it('validates word count, BIP-39 membership and the label before sealing', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);

    await addSeed(m, 'Short', 'abandon about');
    await waitFor(() => /exactly 12 words \(found 2\)/.test(text(m)));
    expect(m.container.querySelector('[data-testid="seed-card"]')).toBeNull();

    await addSeed(m, 'Typos', SEED_12.replace('about', 'zzzzzz'));
    await waitFor(() => /not in the BIP-39 list/.test(text(m)));
    expect(m.container.querySelector('[data-testid="seed-card"]')).toBeNull();

    await addSeed(m, 'Other list', SEED_12.replace('about', 'zzzzzz'), { other: true });
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));
  });

  it('copies a seed phrase and shows the 15-second clipboard countdown with a Clear-now control', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    await addSeed(m, 'Copy me', SEED_12);
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));

    click(m.container.querySelector('button[aria-label="Copy seed phrase for Copy me"]')!);
    await waitFor(() => m.container.querySelector('[data-testid="clipboard-banner"]'));
    expect(clip).toEqual([SEED_12]);
    expect(m.container.querySelector('[data-testid="clipboard-seconds"]')!.textContent).toBe('15');

    click(buttonByText(m.container, 'Clear now')!);
    await settle();
    expect(clip).toEqual([SEED_12, '']);
    expect(m.container.querySelector('[data-testid="clipboard-banner"]')).toBeNull();
  });

  it('overwrites the clipboard automatically when the countdown ends', async () => {
    const m = boot({ clipboardClearMs: 2_000 });
    await unlockAndConfirm(m, PATTERN_A);
    await addSeed(m, 'Auto clear', SEED_12);
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));
    click(m.container.querySelector('button[aria-label="Copy seed phrase for Auto clear"]')!);
    await waitFor(() => clip.length === 1);
    await waitFor(() => clip.length === 2, 4_000);
    expect(clip).toEqual([SEED_12, '']);
    expect(m.container.querySelector('[data-testid="clipboard-banner"]')).toBeNull();
  });

  it('clears a pending clipboard secret the moment the vault locks', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    await addSeed(m, 'Lock clears', SEED_12);
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));
    click(m.container.querySelector('button[aria-label="Copy seed phrase for Lock clears"]')!);
    await waitFor(() => clip.length === 1);
    click(buttonByText(m.container, /Lock$/)!);
    await waitFor(() => clip.length === 2);
    expect(clip[1]).toBe('');
  });

  it('deletes a seed with two-step confirmation', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    await addSeed(m, 'Doomed', SEED_12);
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));
    click(m.container.querySelector('button[aria-label="Delete Doomed"]')!);
    click(m.container.querySelector('button[aria-label="Confirm delete Doomed"]')!);
    await waitFor(() => text(m).includes('No seed phrases yet'));
  });
});

describe('CryptKeep · live offline TOTP authenticator', () => {
  it('shows RFC 6238 codes computed with Web Crypto and a live 30-second countdown ring', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    tab(m, 'Authenticator');
    await addTotp(m, RFC_SECRET, 'ACME', 'me@example.com');
    await waitFor(() => m.container.querySelector('[data-testid="totp-card"]'));

    // RFC 6238 Appendix B: T=59s → 94287082 → 6-digit 287082
    await waitFor(() => m.container.querySelector('[data-testid="totp-code"]')?.textContent === '287 082');
    expect(m.container.querySelector('[data-testid="totp-remaining"]')!.textContent).toBe('1');
    expect(m.container.querySelector('[data-testid="totp-ring"]')!.getAttribute('stroke')).toBe('#DC2626'); // urgent ≤ 5s
    expect(text(m)).toContain('ACME');
    expect(text(m)).toContain('me@example.com');

    // The clock moves on; the ring and the code follow (T=1111111111 → 14050471 → 050471, 29s left, not urgent).
    clockMs = 1_111_111_111_000;
    await waitFor(() => m.container.querySelector('[data-testid="totp-code"]')?.textContent === '050 471', 3_000);
    expect(m.container.querySelector('[data-testid="totp-remaining"]')!.textContent).toBe('29');
    expect(m.container.querySelector('[data-testid="totp-ring"]')!.getAttribute('stroke')).toBe('#F59E0B');
  });

  it('accepts an otpauth:// link and lets typed issuer/account override it', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    tab(m, 'Authenticator');
    await addTotp(m, `otpauth://totp/Example:alice@x.org?secret=${RFC_SECRET}&issuer=Example`);
    await waitFor(() => text(m).includes('alice@x.org'));
    expect(text(m)).toContain('Example');
    await addTotp(m, `otpauth://totp/Example:bob@x.org?secret=${RFC_SECRET}`, 'Override Inc', '');
    await waitFor(() => m.container.querySelectorAll('[data-testid="totp-card"]').length === 2);
    expect(text(m)).toContain('Override Inc');
    expect(text(m)).toContain('bob@x.org');
  });

  it('rejects malformed setup keys and keys without a name', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    tab(m, 'Authenticator');
    await addTotp(m, 'not base32!!', 'X', 'y');
    await waitFor(() => /Base32 setup key/.test(text(m)));
    await addTotp(m, RFC_SECRET, '', '');
    await waitFor(() => /issuer or an account/.test(text(m)));
    expect(m.container.querySelector('[data-testid="totp-card"]')).toBeNull();
  });

  it('copies the code (without the display space) and starts the clipboard countdown', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    tab(m, 'Authenticator');
    await addTotp(m, RFC_SECRET, 'ACME', 'me');
    await waitFor(() => m.container.querySelector('[data-testid="totp-code"]')?.textContent === '287 082');
    click(m.container.querySelector('button[aria-label="Copy code for ACME me"]')!);
    await waitFor(() => clip.length === 1);
    expect(clip[0]).toBe('287082');
    await waitFor(() => m.container.querySelector('[data-testid="clipboard-banner"]'));
  });

  it('stores TOTP secrets only as ciphertext and drops them from the form', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    tab(m, 'Authenticator');
    await addTotp(m, RFC_SECRET, 'ACME', 'me');
    await waitFor(() => m.container.querySelector('[data-testid="totp-card"]'));
    expect((m.container.querySelector('[data-testid="totp-source"]') as HTMLInputElement).value).toBe('');
    for (const ns of await adapter.listNamespaces()) {
      for (const name of await adapter.list(ns)) {
        const data = Buffer.from((await adapter.get(ns, name))!);
        expect(data.includes(Buffer.from(RFC_SECRET))).toBe(false);
        expect(data.includes(Buffer.from('ACME'))).toBe(false);
      }
    }
  });

  it('removes decrypted secrets from the DOM when the vault locks', async () => {
    const m = boot();
    await unlockAndConfirm(m, PATTERN_A);
    tab(m, 'Authenticator');
    await addTotp(m, RFC_SECRET, 'ACME', 'me');
    await waitFor(() => m.container.querySelector('[data-testid="totp-code"]')?.textContent === '287 082');
    click(buttonByText(m.container, /Lock$/)!);
    await settle();
    expect(text(m)).not.toContain('287');
    expect(text(m)).not.toContain('ACME');
  });
});

describe('CryptKeep · encrypted .vault snapshot and 9-word recovery', () => {
  async function seededSnapshot() {
    const a = boot();
    const m = a as Mounted;
    const phrase = await unlockAndConfirm(m, PATTERN_A);
    await addSeed(m, 'Snapshot wallet', SEED_12);
    await waitFor(() => m.container.querySelector('[data-testid="seed-card"]'));
    tab(m, 'Authenticator');
    await addTotp(m, RFC_SECRET, 'ACME', 'me');
    await waitFor(() => m.container.querySelector('[data-testid="totp-card"]'));
    tab(m, 'Snapshot');
    click(buttonByText(m.container, 'Export snapshot')!);
    await waitFor(() => /Exported cryptkeep-/.test(text(m)));
    const archive = await readBlobBytes(objectUrls.at(-1)!.blob);
    return { phrase: phrase!, archive };
  }

  it('exports a ciphertext-only snapshot with the VLT1 header', async () => {
    const { archive } = await seededSnapshot();
    expect(new TextDecoder().decode(archive.subarray(0, 4))).toBe('VLT1');
    for (const secret of ['abandon', 'Snapshot wallet', RFC_SECRET, 'ACME']) {
      expect(Buffer.from(archive).includes(Buffer.from(secret)), secret).toBe(false);
    }
  });

  it('recovers everything with the 9-word phrase on a clean device and sets a new pattern', async () => {
    const { phrase, archive } = await seededSnapshot();

    const b = boot() as Mounted; // brand-new device, empty storage
    click(buttonByText(b.container, 'Recover Vault with 9-Word Phrase')!);
    await waitFor(() => dialog());
    expect(dialog()!.textContent).toContain('Recover vault with 9-word phrase');
    chooseFile(document.querySelector<HTMLInputElement>('[data-testid="restore-file"]')!, [
      new File([archive as BlobPart], 'cryptkeep.vault'),
    ]);
    setNativeValue(document.querySelector<HTMLTextAreaElement>('[data-testid="restore-phrase"]')!, phrase.toUpperCase());
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await settle();
    expect(dialog()!.textContent).toContain('Draw it again to confirm');
    draw(grids(dialog()!)[0]!, NEW_PATTERN);

    await waitFor(() => badge(b) !== '');
    expect(dialog()).toBeNull();
    await waitFor(() => text(b).includes('Snapshot wallet'));
    tab(b, 'Authenticator');
    await waitFor(() => b.container.querySelector('[data-testid="totp-code"]')?.textContent === '287 082');
    expect(text(b)).toContain('ACME');

    // The NEW pattern now unlocks the recovered vault; no recovery dialog because it already exists.
    click(buttonByText(b.container, /Lock$/)!);
    await settle();
    expect(await unlockAndConfirm(b, NEW_PATTERN)).toBeNull();
    await waitFor(() => text(b).includes('Snapshot wallet'));
  });

  it('rejects a wrong recovery phrase, a malformed phrase and a missing file — importing nothing', async () => {
    const { archive } = await seededSnapshot();
    const { adapter, ...rest } = boot();
    const b = rest as Mounted;
    click(buttonByText(b.container, 'Recover Vault with 9-Word Phrase')!);
    await waitFor(() => dialog());

    setNativeValue(document.querySelector<HTMLTextAreaElement>('[data-testid="restore-phrase"]')!, 'abandon '.repeat(8) + 'zoo');
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await settle();
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await waitFor(() => /Choose a \.vault file first/.test(dialog()!.textContent!));

    chooseFile(document.querySelector<HTMLInputElement>('[data-testid="restore-file"]')!, [
      new File([archive as BlobPart], 'cryptkeep.vault'),
    ]);
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await settle();
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await waitFor(() => /Unable to open archive/.test(dialog()!.textContent!));

    setNativeValue(document.querySelector<HTMLTextAreaElement>('[data-testid="restore-phrase"]')!, 'only three words');
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await settle();
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await waitFor(() => /exactly 9 valid words/.test(dialog()!.textContent!));
    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('restores a snapshot with its pattern from inside an unlocked vault', async () => {
    const { archive } = await seededSnapshot();
    const b = boot() as Mounted;
    await unlockAndConfirm(b, PATTERN_B);
    tab(b, 'Snapshot');
    click(buttonByText(b.container, 'Restore snapshot')!);
    await waitFor(() => dialog());
    chooseFile(document.querySelector<HTMLInputElement>('[data-testid="restore-file"]')!, [
      new File([archive as BlobPart], 'cryptkeep.vault'),
    ]);
    click(buttonByText(dialog()!, 'Pattern')!);
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => dialog() === null);
    tab(b, 'Seed phrases');
    await waitFor(() => text(b).includes('Snapshot wallet'));
  });
});
