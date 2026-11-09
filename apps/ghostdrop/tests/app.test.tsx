import { MemoryStorageAdapter } from '@vaulty/core';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { readBlobBytes } from '../src/lib/files';
import { fingerprint } from '../src/lib/format';
import {
  DURESS,
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
let mounted: Mounted[] = [];
let objectUrls: Array<{ url: string; blob: Blob }> = [];
let revoked: string[] = [];

function boot(adapter = new MemoryStorageAdapter()) {
  const m = mount(<App vaultOptions={{ adapter, kdfIterations: FAST }} />);
  mounted.push(m);
  return { ...m, adapter };
}

const text = (m: Mounted) => m.container.textContent ?? '';
const dialog = () => document.querySelector('[role="dialog"]');

async function unlockWith(m: Mounted, pattern: number[]) {
  draw(grids(m.container)[0]!, pattern);
  await waitFor(() => /Quick Lock|recovery phrase/i.test(text(m)));
}

/** Unlock; if the one-time recovery dialog appears, read the phrase and confirm it. */
async function unlockAndConfirm(m: Mounted, pattern: number[]): Promise<string | null> {
  await unlockWith(m, pattern);
  const words = document.querySelector('[data-testid="recovery-words"]');
  if (!words) return null;
  const phrase = Array.from(words.querySelectorAll('li')).map((li) => li.textContent!.replace(/^\d+/, '')).join(' ');
  click(buttonByText(document.body, 'I have written this down')!);
  await settle();
  return phrase;
}

const badge = (m: Mounted) => m.container.querySelector('[data-testid="ns-fingerprint"]')?.textContent ?? '';

async function upload(m: Mounted, ...files: File[]) {
  chooseFile(m.container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!, files);
  await waitFor(() => /sealed\./.test(text(m)));
}

const png = (name = 'photo.png') => new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], name, { type: 'image/png' });

beforeEach(() => {
  objectUrls = [];
  revoked = [];
  let n = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:ghostdrop/${++n}`;
    objectUrls.push({ url, blob });
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted = [];
  document.body.innerHTML = '';
  localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('GhostDrop · unlock & plausible deniability', () => {
  it('shows a tactical lock screen with a skinned pattern grid and no password prompts', () => {
    const m = boot();
    expect(text(m)).toContain('GHOSTDROP');
    expect(grids(m.container)).toHaveLength(1);
    expect(grids(m.container)[0]!.outerHTML).toContain('#334155'); // slate node skin from GRID_SKIN
    expect(grids(m.container)[0]!.getAttribute('aria-label')).toMatch(/arrow keys/i);
    // App-boundaries rule 6: the lock screen never hints at wrong patterns, decoys or duress.
    expect(text(m)).not.toMatch(/wrong|incorrect|invalid|isolated|decoy|duress|wipe|destroy|deniab/i);
  });

  it('creates a vault silently, shows the one-time 9-word phrase, then the namespace badge', async () => {
    const { adapter, ...m } = boot();
    draw(grids(m.container)[0]!, PATTERN_A);
    await waitFor(() => dialog());
    expect(dialog()!.textContent).toContain('recovery phrase');
    const words = dialog()!.querySelectorAll('[data-testid="recovery-words"] li');
    expect(words).toHaveLength(9);
    expect(dialog()!.textContent).toContain('Shown once');

    click(buttonByText(document.body, 'I have written this down')!);
    await settle();
    expect(dialog()).toBeNull();
    expect(badge(m as Mounted)).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
    const [ns] = await adapter.listNamespaces();
    expect(badge(m as Mounted)).toBe(fingerprint(ns!));
    expect(text(m as Mounted)).toContain('kdf: pbkdf2-sha256 ×600,000');
  });

  it('opens fully isolated vaults per pattern, never reporting a wrong pattern', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    const badgeA = badge(m);
    await upload(m, new File(['classified'], 'secret-a.txt', { type: 'text/plain' }));
    expect(text(m)).toContain('secret-a.txt');

    click(buttonByText(m.container, /Quick Lock/)!);
    await settle();
    expect(grids(m.container)).toHaveLength(1); // back on the lock screen

    // A pattern nobody has used: silently becomes a brand-new, empty, different vault.
    const phraseB = await unlockAndConfirm(m, PATTERN_B);
    expect(phraseB!.split(' ')).toHaveLength(9);
    expect(badge(m)).not.toBe(badgeA);
    expect(text(m)).not.toContain('secret-a.txt');
    expect(text(m)).toContain('Vault is empty');
    expect(text(m)).not.toMatch(/incorrect|invalid|wrong/i);
    expect(await adapter.listNamespaces()).toHaveLength(2);

    click(buttonByText(m.container, /Quick Lock/)!);
    await settle();
    const again = await unlockAndConfirm(m, PATTERN_A);
    expect(again).toBeNull(); // existing vault: no recovery dialog
    expect(badge(m)).toBe(badgeA);
    expect(text(m)).toContain('secret-a.txt');
  });

  it('discards the recovery phrase when the vault locks without confirmation', async () => {
    const m = boot() as Mounted & { adapter: MemoryStorageAdapter };
    draw(grids(m.container)[0]!, PATTERN_A);
    await waitFor(() => dialog());
    const lock = m.container.querySelector('button[aria-label="Quick lock the vault now"]');
    click(lock!);
    await settle();
    expect(dialog()).toBeNull();
  });
});

describe('GhostDrop · encrypted binary intake', () => {
  it('encrypts dropped files into storage — only ciphertext is ever persisted', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    const marker = 'TOP-SECRET-MARKER-31337';
    await upload(m, new File([`payload ${marker}`], `${marker}.txt`, { type: 'text/plain' }), png());
    expect(m.container.querySelectorAll('[data-testid="evidence-list"] li')).toHaveLength(2);

    const needle = Buffer.from(marker);
    let blobs = 0;
    for (const ns of await adapter.listNamespaces()) {
      for (const name of await adapter.list(ns)) {
        const data = (await adapter.get(ns, name))!;
        blobs++;
        expect(Buffer.from(data).includes(needle)).toBe(false);
      }
    }
    expect(blobs).toBeGreaterThanOrEqual(4); // keys.bin + index.enc + 2 items
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('deletes items with a two-step confirmation', async () => {
    const m = boot() as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    await upload(m, png('gone.png'));
    click(m.container.querySelector('button[aria-label="Delete gone.png"]')!);
    click(m.container.querySelector('button[aria-label="Confirm delete gone.png"]')!);
    await waitFor(() => text(m).includes('Vault is empty'));
  });

  it('reports recording as unsupported when the browser has no MediaRecorder', async () => {
    const m = boot() as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    expect(text(m)).toContain('no microphone recording support');
    expect(buttonByText(m.container, /Record/)!.disabled).toBe(true);
  });
});

describe('GhostDrop · zero-leak previewer', () => {
  it('decrypts into an object URL, revokes it on close, and locks the vault', async () => {
    const m = boot() as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    await upload(m, png());

    click(m.container.querySelector('button[aria-label="Preview photo.png"]')!);
    const img = await waitFor(() => document.querySelector<HTMLImageElement>('[role="dialog"] img'));
    expect(img.getAttribute('src')).toMatch(/^blob:ghostdrop\//);
    const shown = objectUrls.at(-1)!;
    expect(Array.from((await readBlobBytes(shown.blob)).slice(0, 4))).toEqual([137, 80, 78, 71]);

    click(buttonByText(document.body, /Close & lock/)!);
    await settle();
    expect(revoked).toContain(shown.url);
    expect(dialog()).toBeNull();
    expect(grids(m.container)).toHaveLength(1); // vault re-sealed → lock screen
    expect(m.container.querySelector('[data-testid="ns-fingerprint"]')).toBeNull();
  });

  it('can keep the vault open after closing when the lock-on-close option is off', async () => {
    const m = boot() as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    await upload(m, png());
    click(m.container.querySelector('input[type="checkbox"]')!);
    click(m.container.querySelector('button[aria-label="Preview photo.png"]')!);
    await waitFor(() => document.querySelector('[role="dialog"] img'));
    const url = objectUrls.at(-1)!.url;
    click(buttonByText(document.body, /^Close$/)!);
    await settle();
    expect(revoked).toContain(url);
    expect(m.container.querySelector('[data-testid="ns-fingerprint"]')).not.toBeNull();
  });

  it('revokes the URL and locks the vault when the tab becomes hidden', async () => {
    const m = boot() as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    await upload(m, png());
    click(m.container.querySelector('button[aria-label="Preview photo.png"]')!);
    await waitFor(() => document.querySelector('[role="dialog"] img'));
    const url = objectUrls.at(-1)!.url;

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(revoked).toContain(url);
    expect(m.container.querySelector('[data-testid="ns-fingerprint"]')).toBeNull(); // locked
  });
});

describe('GhostDrop · duress pattern & panic wipe', () => {
  it('arms a duress pattern in the encrypted vault, then wipes everything when it is entered', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    await upload(m, png());
    localStorage.setItem('leftover', 'x'); // must be purged too

    const panel = Array.from(m.container.querySelectorAll('section')).find((s) => s.textContent!.includes('Duress pattern'))!;
    const grid = panel.querySelector('svg[role="application"]')!;
    draw(grid, DURESS);
    await settle();
    expect(panel.textContent).toContain('Draw it again to confirm');
    draw(panel.querySelector('svg[role="application"]')!, DURESS);
    await waitFor(() => panel.textContent!.includes('Duress pattern armed.'));
    expect(await adapter.listNamespaces()).toHaveLength(2); // real vault + encrypted duress vault

    click(buttonByText(m.container, /Quick Lock/)!);
    await settle();

    // Entering the duress pattern: everything is destroyed and a clean lock screen remains.
    draw(grids(m.container)[0]!, DURESS);
    await settle(150);
    expect(await adapter.listNamespaces()).toEqual([]);
    expect(localStorage.length).toBe(0);
    expect(grids(m.container)).toHaveLength(1);
    expect(m.container.querySelector('[data-testid="ns-fingerprint"]')).toBeNull();
    expect(text(m)).not.toMatch(/duress|wipe|destroy/i);
    expect(dialog()).toBeNull();

    // The device behaves like a fresh install: the original pattern now yields a new empty vault.
    const phrase = await unlockAndConfirm(m, PATTERN_A);
    expect(phrase).not.toBeNull();
    expect(text(m)).toContain('Vault is empty');
  });

  it('refuses to arm the active vault’s own pattern as duress', async () => {
    const m = boot() as Mounted;
    await unlockAndConfirm(m, PATTERN_A);
    const panel = Array.from(m.container.querySelectorAll('section')).find((s) => s.textContent!.includes('Duress pattern'))!;
    draw(panel.querySelector('svg[role="application"]')!, PATTERN_A);
    await settle();
    draw(panel.querySelector('svg[role="application"]')!, PATTERN_A);
    await waitFor(() => /must differ/.test(panel.textContent!));
  });
});

describe('GhostDrop · portable .vault archives', () => {
  async function exportFrom(m: Mounted): Promise<Uint8Array> {
    click(buttonByText(m.container, 'Export .vault')!);
    await waitFor(() => /Exported ghostdrop-/.test(text(m)));
    const blob = objectUrls.at(-1)!.blob;
    return readBlobBytes(blob);
  }

  it('exports a ciphertext-only bundle and restores it on a clean device with the pattern', async () => {
    const a = boot() as Mounted;
    await unlockAndConfirm(a, PATTERN_A);
    await upload(a, new File(['ARCHIVE-PLAINTEXT-MARK'], 'notes.txt', { type: 'text/plain' }));
    const badgeA = badge(a);
    const archive = await exportFrom(a);
    expect(new TextDecoder().decode(archive.subarray(0, 4))).toBe('VLT1');
    expect(Buffer.from(archive).includes(Buffer.from('ARCHIVE-PLAINTEXT-MARK'))).toBe(false);
    expect(Buffer.from(archive).includes(Buffer.from('notes.txt'))).toBe(false);

    const b = boot() as Mounted; // brand-new device
    click(buttonByText(b.container, 'Restore .vault backup')!);
    await waitFor(() => dialog());
    chooseFile(document.querySelector<HTMLInputElement>('[data-testid="restore-file"]')!, [
      new File([archive as BlobPart], 'backup.vault'),
    ]);
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => badge(b) !== '');
    expect(badge(b)).toBe(badgeA);
    expect(text(b)).toContain('notes.txt');
    expect(dialog()).toBeNull();
  });

  it('restores from the 9-word phrase and sets a brand-new pattern', async () => {
    const a = boot() as Mounted;
    const phrase = await unlockAndConfirm(a, PATTERN_A);
    await upload(a, png('evidence.png'));
    const archive = await exportFrom(a);

    const b = boot() as Mounted;
    click(buttonByText(b.container, 'Restore .vault backup')!);
    await waitFor(() => dialog());
    chooseFile(document.querySelector<HTMLInputElement>('[data-testid="restore-file"]')!, [
      new File([archive as BlobPart], 'backup.vault'),
    ]);
    click(buttonByText(dialog()!, 'Use 9-word phrase')!);
    setNativeValue(document.querySelector<HTMLTextAreaElement>('[data-testid="restore-phrase"]')!, phrase!);
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await settle();
    draw(grids(dialog()!)[0]!, NEW_PATTERN);
    await waitFor(() => badge(b) !== '');
    expect(text(b)).toContain('evidence.png');

    // The new pattern now opens the restored vault on this device.
    click(buttonByText(b.container, /Quick Lock/)!);
    await settle();
    const again = await unlockAndConfirm(b, NEW_PATTERN);
    expect(again).toBeNull();
    expect(text(b)).toContain('evidence.png');
  });

  it('shows an error (and imports nothing) for the wrong pattern', async () => {
    const a = boot() as Mounted;
    await unlockAndConfirm(a, PATTERN_A);
    const archive = await exportFrom(a);

    const { adapter, ...rest } = boot();
    const b = rest as Mounted;
    click(buttonByText(b.container, 'Restore .vault backup')!);
    await waitFor(() => dialog());
    chooseFile(document.querySelector<HTMLInputElement>('[data-testid="restore-file"]')!, [
      new File([archive as BlobPart], 'backup.vault'),
    ]);
    draw(grids(dialog()!)[0]!, PATTERN_B);
    await waitFor(() => /Unable to open archive/.test(dialog()?.textContent ?? ''));
    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('asks for a file before importing', async () => {
    const b = boot() as Mounted;
    click(buttonByText(b.container, 'Restore .vault backup')!);
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => /Choose a \.vault file first/.test(dialog()?.textContent ?? ''));
  });
});
