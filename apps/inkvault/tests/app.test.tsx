import { MemoryStorageAdapter } from '@vaulty/core';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  PATTERN_A,
  PATTERN_B,
  type Mounted,
  buttonByText,
  click,
  draw,
  grids,
  mount,
  setNativeValue,
  settle,
  waitFor,
} from './helpers';

const FAST = 1_000;
const MARKER = 'TOP-SECRET-DRAFT-5521';
const NOTE = `# Field plan\n\nMeet at **dawn**. ${MARKER}\n\n- bring map\n- [x] charge phone`;

let mounted: Mounted[] = [];
let blobs: Blob[] = [];
let downloadNames: string[] = [];

function boot(adapter = new MemoryStorageAdapter()) {
  const m = mount(<App vaultOptions={{ adapter, kdfIterations: FAST }} />);
  mounted.push(m);
  return { ...m, adapter };
}

const text = (m: Mounted) => m.container.textContent ?? '';
const dialog = () => document.querySelector('[role="dialog"]');
const editor = (m: Mounted) => m.container.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
const title = (m: Mounted) => m.container.querySelector<HTMLInputElement>('#note-title')!;
const preview = (m: Mounted) => m.container.querySelector('[data-testid="preview"]')!;
const status = (m: Mounted) => m.container.querySelector('[data-testid="status"]')!.textContent ?? '';
const btn = (root: ParentNode, label: string | RegExp) => buttonByText(root, label)!;
const lockButton = (m: Mounted) => m.container.querySelector('button[aria-label="Lock the vault and clear the editor"]');

function write(m: Mounted, value: string) {
  setNativeValue(editor(m), value);
}

async function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });
}

/** Click "Save to Encrypted Vault", draw `pattern`, and wait for the save to finish. */
async function saveWith(m: Mounted, pattern: number[]) {
  click(btn(m.container, 'Save to Encrypted Vault'));
  await waitFor(() => dialog());
  draw(grids(dialog()!)[0]!, pattern);
  await waitFor(() => /^Saved /.test(status(m)));
}

function confirmPhrase(): string | null {
  const words = document.querySelector('[data-testid="recovery-words"]');
  if (!words) return null;
  const phrase = Array.from(words.querySelectorAll('li')).map((li) => li.textContent!.replace(/^\d+/, '')).join(' ');
  click(btn(document.body, 'I have written this down'));
  return phrase;
}

beforeEach(() => {
  blobs = [];
  downloadNames = [];
  URL.createObjectURL = vi.fn((b: Blob) => (blobs.push(b), 'blob:ink/1'));
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloadNames.push(this.download);
  };
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted = [];
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('InkVault · normal mode first (zero friction)', () => {
  it('opens straight into a split-pane editor and live preview — no lock screen, no pattern grid, no dialog', () => {
    const m = boot();
    expect(editor(m)).not.toBeNull();
    expect(preview(m)).not.toBeNull();
    expect(grids(document)).toHaveLength(0);
    expect(dialog()).toBeNull();
    expect(lockButton(m)).toBeNull(); // "Lock Vault" only exists while unlocked
    const labels = Array.from(m.container.querySelectorAll('nav button')).map((b) => b.textContent);
    expect(labels).toEqual(['New Note', 'Download .md (Plaintext)', 'Save to Encrypted Vault', 'Open from Vault']);
    expect(text(m)).toContain('draft — not saved anywhere');
  });

  it('renders Markdown live as you type, with word and character counts', async () => {
    const m = boot();
    write(m, NOTE);
    await waitFor(() => preview(m).querySelector('h1')?.textContent === 'Field plan');
    expect(preview(m).querySelector('strong')?.textContent).toBe('dawn');
    expect(preview(m).querySelectorAll('li')).toHaveLength(2);
    expect(m.container.querySelector('[data-testid="counts"]')!.textContent).toMatch(/^\d+ words · \d+ chars$/);
    expect(text(m)).toContain('● unsaved changes');
  });

  it('never executes or injects HTML typed into the editor', async () => {
    const m = boot();
    write(m, '<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n![pixel](https://evil.example/p.png)');
    await waitFor(() => preview(m).textContent!.includes('[image: pixel]'));
    expect(preview(m).querySelector('img')).toBeNull();
    expect(preview(m).querySelector('a')).toBeNull();
    expect(preview(m).textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('Download .md saves the plaintext exactly as written, named from the title', async () => {
    const m = boot();
    write(m, NOTE);
    click(btn(m.container, 'Download .md (Plaintext)'));
    expect(downloadNames).toEqual(['Field plan.md']); // suggested from the first heading
    expect(await readBlobText(blobs[0]!)).toBe(NOTE);

    setNativeValue(title(m), 'My plan');
    click(btn(m.container, 'Download .md (Plaintext)'));
    expect(downloadNames.at(-1)).toBe('My plan.md');
  });

  it('never writes to web storage while writing normally', async () => {
    const m = boot();
    write(m, NOTE);
    await settle();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('refuses to save an empty note', async () => {
    const m = boot();
    expect(btn(m.container, 'Save to Encrypted Vault').disabled).toBe(true);
    write(m, '   \n  ');
    expect(btn(m.container, 'Save to Encrypted Vault').disabled).toBe(true);
    write(m, 'x');
    expect(btn(m.container, 'Save to Encrypted Vault').disabled).toBe(false);
  });

  it('guards unsaved text: New Note asks first, Cancel keeps the text, confirm clears it', async () => {
    const m = boot();
    write(m, NOTE);
    click(btn(m.container, 'New Note'));
    await waitFor(() => dialog());
    expect(dialog()!.textContent).toContain('unsaved changes');
    click(btn(dialog()!, 'Cancel'));
    await settle();
    expect(editor(m).value).toBe(NOTE);

    click(btn(m.container, 'New Note'));
    await waitFor(() => dialog());
    click(btn(dialog()!, 'Discard & start new'));
    await settle();
    expect(editor(m).value).toBe('');
    expect(dialog()).toBeNull();
  });

  it('New Note on a clean editor needs no confirmation', async () => {
    const m = boot();
    click(btn(m.container, 'New Note'));
    expect(dialog()).toBeNull();
  });

  it('warns before unload only while there are unsaved changes', async () => {
    const m = boot();
    const fire = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(false);
    write(m, 'draft');
    await settle();
    expect(fire()).toBe(true);
  });
});

describe('InkVault · Save to Encrypted Vault', () => {
  it('opens the pattern modal when locked; a 6+ node pattern creates the vault, shows the one-time phrase, and saves via putFile', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    write(m, NOTE);
    click(btn(m.container, 'Save to Encrypted Vault'));
    await waitFor(() => dialog());
    expect(dialog()!.textContent).toContain('Save to encrypted vault');
    expect(grids(dialog()!)).toHaveLength(1);
    expect(grids(dialog()!)[0]!.outerHTML).toContain('#94A3B8'); // indigo/slate skin

    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => /^Saved /.test(status(m)));
    expect(dialog()).toBeNull();
    expect(status(m)).toContain('Saved “Field plan.md”');

    // First creation: one-time 9-word banner.
    const banner = m.container.querySelector('[data-testid="recovery-banner"]')!;
    expect(banner.querySelectorAll('[data-testid="recovery-words"] li')).toHaveLength(9);
    expect(banner.textContent).toContain('shown once');

    // Now unlocked: Lock Vault + fingerprint appear; the note is marked saved.
    expect(lockButton(m)).not.toBeNull();
    expect(m.container.querySelector('[data-testid="ns-fingerprint"]')!.textContent).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
    expect(text(m)).toContain('✓ saved in vault');
    expect(title(m).value).toBe('Field plan');

    // At rest: ciphertext only.
    const needle = Buffer.from(MARKER);
    let blobsSeen = 0;
    for (const ns of await adapter.listNamespaces()) {
      for (const name of await adapter.list(ns)) {
        blobsSeen++;
        expect(Buffer.from((await adapter.get(ns, name))!).includes(needle)).toBe(false);
      }
    }
    expect(blobsSeen).toBe(3); // keys.bin + index.enc + 1 note
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('rejects a too-short pattern without unlocking anything', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    write(m, NOTE);
    click(btn(m.container, 'Save to Encrypted Vault'));
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, [0, 1, 2]);
    await waitFor(() => /at least 6 dots/.test(dialog()!.textContent!));
    expect(await adapter.listNamespaces()).toEqual([]);
    expect(lockButton(m)).toBeNull();
  });

  it('closing the pattern modal leaves normal mode untouched (text kept, nothing stored)', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    write(m, NOTE);
    click(btn(m.container, 'Save to Encrypted Vault'));
    await waitFor(() => dialog());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(editor(m).value).toBe(NOTE);
    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('Ctrl/⌘+S is a shortcut for Save to Encrypted Vault', async () => {
    const m = boot();
    write(m, NOTE);
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true); // browser "save page" suppressed
    await waitFor(() => dialog());
  });

  it('saving again while unlocked needs no pattern and updates the SAME encrypted note', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    write(m, NOTE);
    await saveWith(m, PATTERN_A);
    confirmPhrase();
    await settle();

    write(m, NOTE + '\n\nSecond paragraph.');
    expect(text(m)).toContain('● unsaved changes');
    click(btn(m.container, 'Save to Encrypted Vault'));
    expect(dialog()).toBeNull(); // no unlock prompt
    await waitFor(() => /^Saved /.test(status(m)) && text(m).includes('✓ saved in vault'));

    const [ns] = await adapter.listNamespaces();
    const noteBlobs = (await adapter.list(ns!)).filter((n) => /^[0-9a-f-]{36}$/.test(n));
    expect(noteBlobs).toHaveLength(1); // updated in place, not duplicated
  });

  it('keeps the one-time phrase out of the way once confirmed', async () => {
    const m = boot();
    write(m, NOTE);
    await saveWith(m, PATTERN_A);
    expect(m.container.querySelector('[data-testid="recovery-banner"]')).not.toBeNull();
    const phrase = confirmPhrase();
    expect(phrase!.split(' ')).toHaveLength(9);
    await settle();
    expect(m.container.querySelector('[data-testid="recovery-banner"]')).toBeNull();
    expect(text(m)).not.toContain(phrase!.split(' ')[0]! + ' ' + phrase!.split(' ')[1]!);
  });
});

describe('InkVault · Lock Vault', () => {
  it('locks immediately, wipes keys and clears the editor, preview, title and recovery phrase', async () => {
    const { adapter, ...rest } = boot();
    const m = rest as Mounted;
    write(m, NOTE);
    await saveWith(m, PATTERN_A);
    expect(m.container.querySelector('[data-testid="recovery-banner"]')).not.toBeNull(); // NOT confirmed on purpose

    click(lockButton(m)!);
    await settle();

    expect(lockButton(m)).toBeNull();
    expect(editor(m).value).toBe('');
    expect(title(m).value).toBe('');
    expect(preview(m).textContent).toContain('Your rendered note appears here.');
    expect(m.container.querySelector('[data-testid="recovery-banner"]')).toBeNull();
    expect(m.container.querySelector('[data-testid="ns-fingerprint"]')).toBeNull();
    expect(document.body.textContent).not.toContain(MARKER);
    expect(status(m)).toContain('Vault locked');
    expect(status(m)).toContain('editor cleared');
    // The vault itself is still there, encrypted, on "disk".
    expect(await adapter.listNamespaces()).toHaveLength(1);
  });

  it('locks and clears the editor when the tab is hidden', async () => {
    const m = boot();
    write(m, NOTE);
    await saveWith(m, PATTERN_A);
    expect(lockButton(m)).not.toBeNull();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();

    expect(lockButton(m)).toBeNull();
    expect(editor(m).value).toBe('');
    expect(document.body.textContent).not.toContain(MARKER);
    expect(status(m)).toContain('tab hidden');
  });

  it('does NOT clear a plaintext draft when the tab is hidden while the vault was never unlocked', async () => {
    const m = boot();
    write(m, NOTE);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(editor(m).value).toBe(NOTE); // normal mode: nothing was locked, nothing is lost
  });

  it('returns to zero-friction normal mode after locking', async () => {
    const m = boot();
    write(m, NOTE);
    await saveWith(m, PATTERN_A);
    click(lockButton(m)!);
    await settle();
    write(m, 'fresh start');
    await waitFor(() => preview(m).textContent!.includes('fresh start'));
    expect(dialog()).toBeNull();
    expect(grids(document)).toHaveLength(0);
  });
});

describe('InkVault · Open from Vault', () => {
  async function seeded() {
    const adapter = new MemoryStorageAdapter();
    const a = boot(adapter);
    const m = a as unknown as Mounted;
    write(m, NOTE);
    await saveWith(m, PATTERN_A);
    confirmPhrase();
    await settle();
    click(lockButton(m)!);
    await settle();
    return { adapter, m };
  }

  it('asks for the pattern when locked, lists saved .md notes via listEntries, and loads the chosen one via getFile', async () => {
    const { m } = await seeded();
    expect(editor(m).value).toBe('');

    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog());
    expect(dialog()!.textContent).toContain('Open from encrypted vault');
    draw(grids(dialog()!)[0]!, PATTERN_A);

    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    expect(dialog()!.textContent).toContain('Field plan');
    expect(dialog()!.querySelectorAll('[data-testid="vault-notes"] li')).toHaveLength(1);
    expect(m.container.querySelector('[data-testid="recovery-banner"]')).toBeNull(); // existing vault: no phrase again

    click(dialog()!.querySelector('button[aria-label="Open Field plan.md"]')!);
    await waitFor(() => editor(m).value === NOTE);
    expect(title(m).value).toBe('Field plan');
    expect(dialog()).toBeNull();
    expect(status(m)).toContain('Opened “Field plan.md”');
    expect(text(m)).toContain('✓ saved in vault');
    await waitFor(() => preview(m).querySelector('h1')?.textContent === 'Field plan');
    expect(lockButton(m)).not.toBeNull();
  });

  it('shows the list straight away when the vault is already unlocked', async () => {
    const { m } = await seeded();
    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    click(btn(dialog()!, 'Close'));
    await settle();

    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    expect(grids(dialog()!)).toHaveLength(0); // no second pattern prompt
  });

  it('edits to an opened note are saved back to the same encrypted note', async () => {
    const { adapter, m } = await seeded();
    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    click(dialog()!.querySelector('button[aria-label="Open Field plan.md"]')!);
    await waitFor(() => editor(m).value === NOTE);

    write(m, NOTE + '\n\nAppended offline.');
    click(btn(m.container, 'Save to Encrypted Vault'));
    await waitFor(() => /^Saved /.test(status(m)) && !text(m).includes('unsaved'));
    const [ns] = await adapter.listNamespaces();
    expect((await adapter.list(ns!)).filter((n) => /^[0-9a-f-]{36}$/.test(n))).toHaveLength(1);
  });

  it('opens a different, empty vault for a different pattern — the first vault stays private', async () => {
    const { m } = await seeded();
    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, PATTERN_B);
    await waitFor(() => dialog()?.textContent?.includes('No encrypted notes'));
    expect(dialog()!.textContent).not.toContain('Field plan');
    expect(dialog()!.textContent).not.toMatch(/incorrect|wrong|invalid/i);
  });

  it('persists across sessions: a brand-new app instance on the same storage opens the note', async () => {
    const { adapter, m } = await seeded();
    m.unmount();
    mounted = mounted.filter((x) => x !== m);

    const again = boot(adapter);
    const m2 = again as unknown as Mounted;
    click(btn(m2.container, 'Open from Vault'));
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    click(dialog()!.querySelector('button[aria-label="Open Field plan.md"]')!);
    await waitFor(() => editor(m2).value === NOTE);
  });

  it('asks before replacing unsaved text with an opened note', async () => {
    const { m } = await seeded();
    write(m, 'my current draft');
    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    click(dialog()!.querySelector('button[aria-label="Open Field plan.md"]')!);
    await waitFor(() => dialog()?.textContent?.includes('replaces your current text'));
    click(btn(dialog()!, 'Cancel'));
    await settle();
    expect(editor(m).value).toBe('my current draft');

    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    click(dialog()!.querySelector('button[aria-label="Open Field plan.md"]')!);
    await waitFor(() => dialog()?.textContent?.includes('replaces your current text'));
    click(btn(dialog()!, 'Discard & open'));
    await waitFor(() => editor(m).value === NOTE);
  });

  it('deletes a note from the vault with a two-step confirmation', async () => {
    const { adapter, m } = await seeded();
    click(btn(m.container, 'Open from Vault'));
    await waitFor(() => dialog());
    draw(grids(dialog()!)[0]!, PATTERN_A);
    await waitFor(() => dialog()?.querySelector('[data-testid="vault-notes"]'));
    click(dialog()!.querySelector('button[aria-label="Delete Field plan.md"]')!);
    click(dialog()!.querySelector('button[aria-label="Confirm delete Field plan.md"]')!);
    await waitFor(() => dialog()?.textContent?.includes('No encrypted notes'));
    const [ns] = await adapter.listNamespaces();
    expect((await adapter.list(ns!)).filter((n) => /^[0-9a-f-]{36}$/.test(n))).toHaveLength(0);
  });
});
