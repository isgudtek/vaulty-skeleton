// @vitest-environment jsdom
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatternGrid, nearestNode, nodeCenter, useVault, useVaultDialog, type UseVaultDialogResult, type UseVaultResult, type VaultModalTheme } from '../src/react';
import { MemoryStorageAdapter } from '../src/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('grid geometry', () => {
  it('lays 25 nodes on a 5×5 grid in a 0–100 viewBox', () => {
    expect(nodeCenter(0)).toEqual({ x: 10, y: 10 });
    expect(nodeCenter(4)).toEqual({ x: 90, y: 10 });
    expect(nodeCenter(12)).toEqual({ x: 50, y: 50 });
    expect(nodeCenter(24)).toEqual({ x: 90, y: 90 });
  });

  it('hit-tests the nearest node within the hit radius only', () => {
    expect(nearestNode(10, 10)).toBe(0);
    expect(nearestNode(12, 11)).toBe(0);
    expect(nearestNode(52, 48)).toBe(12);
    expect(nearestNode(20, 20)).toBeNull(); // between nodes, outside the radius
    expect(nearestNode(20, 10, 11)).not.toBeNull();
    expect(nearestNode(-50, -50)).toBeNull();
  });
});

describe('<PatternGrid /> rendering', () => {
  it('server-renders 25 nodes with accessible semantics and skinning props', () => {
    const html = renderToString(
      h(PatternGrid, { size: 320, nodeColor: '#ff00aa', activeColor: '#00ffaa', lineColor: '#123456', className: 'my-grid' }),
    );
    expect(html.match(/data-node=/g)).toHaveLength(25);
    expect(html).toContain('role="application"');
    expect(html).toContain('aria-label=');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="my-grid"');
    expect(html).toContain('#ff00aa');
    expect(html).toContain('max-width:320px');
    expect(html).toContain('touch-action:none');
    expect(html).toContain('0 nodes selected');
  });

  it('can be disabled', () => {
    const html = renderToString(h(PatternGrid, { disabled: true }));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('tabindex="-1"');
  });
});

function svgOf(): SVGSVGElement {
  const svg = container.querySelector('svg') as SVGSVGElement;
  // jsdom has no layout: pretend the grid is exactly 100×100 so clientX/Y == viewBox units.
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  return svg;
}

function pointer(el: Element, type: string, node: number | null, raw?: { x: number; y: number }) {
  const c = raw ?? (node === null ? { x: 0, y: 0 } : nodeCenter(node));
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: c.x, clientY: c.y }));
  });
}

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

describe('<PatternGrid /> interaction', () => {
  it('reports the ordered pattern drawn with the pointer', () => {
    const onComplete = vi.fn();
    const onChange = vi.fn();
    act(() => root.render(h(PatternGrid, { onComplete, onChange })));
    const svg = svgOf();
    const drawn = [0, 1, 2, 3, 4, 9];
    pointer(svg, 'pointerdown', drawn[0]!);
    for (const n of drawn.slice(1)) pointer(svg, 'pointermove', n);
    pointer(svg, 'pointermove', 9); // revisiting the same node does not duplicate it
    expect(container.querySelectorAll('[data-active="true"]')).toHaveLength(6);
    expect(container.querySelector('polyline')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('6 nodes selected');
    pointer(svg, 'pointerup', 9);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(drawn);
    expect(onChange).toHaveBeenCalled();
    // The pattern is cleared from component state right after completion.
    expect(container.querySelectorAll('[data-active="true"]')).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('0 nodes selected');
  });

  it('reports too-short patterns through onError instead of onComplete', () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    act(() => root.render(h(PatternGrid, { onComplete, onError })));
    const svg = svgOf();
    pointer(svg, 'pointerdown', 0);
    pointer(svg, 'pointermove', 1);
    pointer(svg, 'pointerup', 1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith('too_short', [0, 1]);
  });

  it('honours a custom minNodes and ignores moves when not drawing or when disabled', () => {
    const onComplete = vi.fn();
    act(() => root.render(h(PatternGrid, { onComplete, minNodes: 2 })));
    let svg = svgOf();
    pointer(svg, 'pointermove', 5); // not drawing
    pointer(svg, 'pointerdown', 5);
    pointer(svg, 'pointermove', 6);
    pointer(svg, 'pointerup', 6);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith([5, 6]);

    onComplete.mockClear();
    act(() => root.render(h(PatternGrid, { onComplete, minNodes: 2, disabled: true })));
    svg = svgOf();
    pointer(svg, 'pointerdown', 5);
    pointer(svg, 'pointermove', 6);
    pointer(svg, 'pointerup', 6);
    key(svg, ' ');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ignores presses that start between nodes and releases with nothing selected', () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    act(() => root.render(h(PatternGrid, { onComplete, onError })));
    const svg = svgOf();
    pointer(svg, 'pointerdown', null, { x: 20, y: 20 });
    pointer(svg, 'pointerup', null, { x: 20, y: 20 });
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('is fully operable from the keyboard (arrows, Space, Backspace, Escape, Enter)', () => {
    const onComplete = vi.fn();
    act(() => root.render(h(PatternGrid, { onComplete })));
    const svg = svgOf();
    act(() => svg.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    act(() => svg.focus());

    // Focus starts on the centre node 12.
    key(svg, ' '); // select 12
    key(svg, 'ArrowRight'); // 13
    key(svg, ' ');
    key(svg, 'ArrowRight'); // 14
    key(svg, ' ');
    key(svg, 'ArrowRight'); // edge: stays on 14
    key(svg, 'ArrowDown'); // 19
    key(svg, ' ');
    key(svg, 'ArrowLeft'); // 18
    key(svg, ' ');
    key(svg, 'ArrowUp'); // 13 (already selected) → space is ignored for duplicates
    key(svg, ' ');
    key(svg, 'ArrowLeft'); // 12 (already selected)
    key(svg, 'ArrowDown'); // 17
    key(svg, ' ');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('6 nodes selected');

    key(svg, 'Backspace');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('5 nodes selected');
    key(svg, ' ');
    key(svg, 'Escape');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('0 nodes selected');

    for (const k of ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']) key(svg, k); // clamp at top
    for (const k of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']) key(svg, k); // clamp left
    key(svg, 'Enter'); // nothing selected → nothing happens
    expect(onComplete).not.toHaveBeenCalled();
    key(svg, 'x'); // unrelated key is ignored

    // Build [12,13,14,19,18,17] again and confirm with Enter.
    key(svg, 'Escape');
  });

  it('completes via Enter after keyboard selection', () => {
    const onComplete = vi.fn();
    act(() => root.render(h(PatternGrid, { onComplete, minNodes: 3 })));
    const svg = svgOf();
    act(() => svg.focus());
    key(svg, ' ');
    key(svg, 'ArrowRight');
    key(svg, ' ');
    key(svg, 'ArrowDown');
    key(svg, ' ');
    key(svg, 'Enter');
    expect(onComplete).toHaveBeenCalledExactlyOnceWith([12, 13, 18]);
  });
});

describe('useVault()', () => {
  let latest: UseVaultResult;
  const PATTERN = [0, 1, 2, 3, 4, 9];

  function Probe(props: { adapter: MemoryStorageAdapter }) {
    latest = useVault({ adapter: props.adapter, kdfIterations: 1_000 });
    return null;
  }

  it('manages lock state, entries, progress and cleans decrypted metadata on lock', async () => {
    const adapter = new MemoryStorageAdapter();
    await act(async () => root.render(h(Probe, { adapter })));
    expect(latest.status).toBe('locked');
    expect(latest.isUnlocked).toBe(false);
    expect(latest.entries).toEqual([]);

    let result: Awaited<ReturnType<UseVaultResult['unlock']>> | undefined;
    await act(async () => {
      result = await latest.unlock(PATTERN);
    });
    expect(result?.status).toBe('unlocked');
    expect(latest.status).toBe('unlocked');
    expect(latest.namespaceId).toMatch(/^[0-9a-f]{64}$/);

    let recordId = '';
    await act(async () => {
      const rec = await latest.putRecord({ hello: 'world' }, { name: 'greeting' });
      recordId = rec.id;
      await latest.putFile(new TextEncoder().encode('bytes'), { name: 'f.bin' });
    });
    expect(latest.entries.map((e) => e.name).sort()).toEqual(['f.bin', 'greeting']);
    await act(async () => {
      expect((await latest.getRecord<{ hello: string }>(recordId)).data.hello).toBe('world');
    });

    let archive: Uint8Array = new Uint8Array();
    await act(async () => {
      archive = await latest.exportArchive();
    });
    expect(new TextDecoder().decode(archive.subarray(0, 4))).toBe('VLT1');
    expect(latest.progress).toBeNull();

    await act(async () => {
      expect(await latest.deleteFile(recordId)).toBe(true);
    });
    expect(latest.entries.map((e) => e.name)).toEqual(['f.bin']);

    act(() => latest.lock());
    expect(latest.status).toBe('locked');
    expect(latest.entries).toEqual([]); // decrypted metadata dropped from React state
    expect(latest.lastLockReason).toBe('manual');

    // Restore the exported archive into the (now locked) client.
    await act(async () => {
      const res = await latest.importArchive(archive, PATTERN);
      expect(res.entryCount).toBe(2);
    });
    expect(latest.isUnlocked).toBe(true);
    expect(latest.entries).toHaveLength(2);

    act(() => latest.refresh({ nameContains: 'greet' }));
    expect(latest.entries.map((e) => e.name)).toEqual(['greeting']);
    act(() => latest.touch());
  });

  it('surfaces errors in state and rethrows', async () => {
    const adapter = new MemoryStorageAdapter();
    await act(async () => root.render(h(Probe, { adapter })));
    let caught: unknown;
    await act(async () => {
      try {
        await latest.unlock([1, 2]);
      } catch (e) {
        caught = e;
      }
    });
    expect((caught as { code?: string }).code).toBe('INVALID_PATTERN');
    expect(latest.error).toBeInstanceOf(Error);
    expect(latest.status).toBe('locked');
  });

  it('locks an owned client on unmount but leaves a supplied client alone', async () => {
    const adapter = new MemoryStorageAdapter();
    await act(async () => root.render(h(Probe, { adapter })));
    await act(async () => {
      await latest.unlock(PATTERN);
    });
    const ownedClient = latest.client;
    expect(ownedClient.isUnlocked).toBe(true);
    act(() => root.unmount());
    expect(ownedClient.isUnlocked).toBe(false);

    root = createRoot(container);
    const { VaultClient } = await import('../src/vault');
    const external = new VaultClient({ adapter: new MemoryStorageAdapter(), kdfIterations: 1_000 });
    function External() {
      latest = useVault({ client: external });
      return null;
    }
    await act(async () => root.render(h(External)));
    await act(async () => {
      await latest.unlock(PATTERN);
    });
    act(() => root.unmount());
    expect(external.isUnlocked).toBe(true);
    external.dispose();
    root = createRoot(container);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* useVaultDialog() + <VaultModal />                                                          */
/* ------------------------------------------------------------------------------------------ */

describe('useVaultDialog()', () => {
  const PATTERN_A = [0, 1, 2, 3, 4, 9];
  const PATTERN_B = [24, 23, 22, 21, 20, 15];
  const DURESS = [10, 11, 12, 13, 14, 19];
  let dlg: UseVaultDialogResult;
  let renders = 0;
  let adapter: MemoryStorageAdapter;

  // The modal is portalled into <body>, so look for it in the whole document.
  const modal = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const grid = () => modal()!.querySelector<SVGSVGElement>('svg[role="application"]')!;
  const buttonIn = (root: ParentNode, label: string) =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    );
  const press = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const flush = async (ms = 30) => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };
  const until = async <T,>(fn: () => T | null | undefined | false, timeout = 5000): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('timed out');
      await flush(10);
    }
  };
  const draw = (svg: SVGSVGElement, nodes: number[]) => {
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const fire = (type: string, n: number) => {
      const c = nodeCenter(n);
      act(() => {
        svg.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: c.x, clientY: c.y }));
      });
    };
    fire('pointerdown', nodes[0]!);
    for (const n of nodes.slice(1)) fire('pointermove', n);
    fire('pointerup', nodes[nodes.length - 1]!);
  };
  /** Every blob in storage, to prove plaintext never reaches it. */
  const storedBytes = async () => {
    const out: Uint8Array[] = [];
    for (const ns of await adapter.listNamespaces()) for (const n of await adapter.list(ns)) out.push((await adapter.get(ns, n))!);
    return out;
  };
  const itemBlobs = async () => {
    let n = 0;
    for (const ns of await adapter.listNamespaces()) n += (await adapter.list(ns)).filter((x) => /^[0-9a-f-]{36}$/.test(x)).length;
    return n;
  };

  function Host(props: { duress?: number[]; theme?: Partial<VaultModalTheme>; clip?: boolean }) {
    renders++;
    dlg = useVaultDialog({
      adapter,
      kdfIterations: 1_000,
      ...(props.duress ? { duressPattern: props.duress } : {}),
      ...(props.theme ? { theme: props.theme } : {}),
    });
    // `clip` wraps the modal in an ancestor that would trap a non-portalled `position: fixed` element.
    return h(
      'div',
      props.clip ? { 'data-testid': 'clipper', style: { transform: 'translateZ(0)', overflow: 'hidden', width: 10, height: 10 } } : null,
      h('button', { type: 'button', id: 'opener' }, 'Host button'),
      h(dlg.VaultModal),
    );
  }

  async function mountHost(props: Parameters<typeof Host>[0] = {}) {
    await act(async () => root.render(h(Host, props)));
  }

  /** Lock, then re-run a save that should NOT show the recovery step (vault exists). */
  async function saveWithPattern(name: string, data: string | Uint8Array, pattern = PATTERN_A) {
    let result: Awaited<ReturnType<UseVaultDialogResult['saveEncrypted']>> | undefined;
    act(() => {
      void dlg.saveEncrypted(name, data).then((r) => (result = r));
    });
    await until(() => modal());
    draw(grid(), pattern);
    return { done: () => result, wait: () => until(() => result !== undefined) };
  }

  beforeEach(() => {
    adapter = new MemoryStorageAdapter();
    renders = 0;
    URL.createObjectURL = vi.fn(() => 'blob:dialog/1');
    URL.revokeObjectURL = vi.fn();
  });

  it('renders nothing until it is needed and keeps a stable VaultModal component', async () => {
    await mountHost();
    expect(modal()).toBeNull();
    const first = dlg.VaultModal;
    await act(async () => root.render(h(Host, {})));
    expect(dlg.VaultModal).toBe(first);
    expect(dlg.isUnlocked).toBe(false);
  });

  it('saveEncrypted while locked: pattern → one-time recovery phrase → encrypt → close', async () => {
    await mountHost();
    let result: unknown;
    act(() => {
      void dlg.saveEncrypted('note.md', '# Hello SECRET-MARKER').then((r) => (result = r));
    });
    await until(() => modal());
    expect(modal()!.getAttribute('aria-modal')).toBe('true');
    expect(modal()!.textContent).toContain('Save encrypted');
    expect(modal()!.querySelectorAll('svg[role="application"]')).toHaveLength(1);

    draw(grid(), PATTERN_A);
    const words = await until(() => modal()?.querySelector('[data-testid="vault-modal-recovery-words"]'));
    expect(words.querySelectorAll('li')).toHaveLength(9);
    expect(modal()!.textContent).toContain('shown once');
    // The recovery phrase is shown BEFORE encrypting: nothing has been saved yet.
    expect(await itemBlobs()).toBe(0);
    expect(result).toBeUndefined();

    // Escape must not skip the one-time phrase.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(modal()).not.toBeNull();

    press(buttonIn(modal()!, 'I have written this down')!);
    await until(() => result !== undefined);
    expect(result).toMatchObject({ name: 'note.md', mimeType: 'text/markdown', size: 21 });
    expect(modal()).toBeNull();
    expect(dlg.isUnlocked).toBe(true);
    expect(await itemBlobs()).toBe(1);
    for (const b of await storedBytes()) expect(Buffer.from(b).includes(Buffer.from('SECRET-MARKER'))).toBe(false);
  });

  it('saveEncrypted on an existing vault skips the recovery step', async () => {
    await mountHost();
    const s1 = await saveWithPattern('a.txt', 'one');
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await s1.wait();
    act(() => dlg.lockVault());
    await flush();
    expect(dlg.isUnlocked).toBe(false);

    const s2 = await saveWithPattern('b.txt', 'two');
    await s2.wait();
    expect(s2.done()).toMatchObject({ name: 'b.txt', mimeType: 'text/plain' });
    expect(await itemBlobs()).toBe(2);
  });

  it('saveEncrypted while unlocked saves straight away with no modal, and never mutates the caller’s bytes', async () => {
    await mountHost();
    const s1 = await saveWithPattern('a.bin', 'x');
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await s1.wait();

    const caller = new Uint8Array([1, 2, 3, 4]);
    let entry: unknown;
    await act(async () => {
      entry = await dlg.saveEncrypted('raw.bin', caller);
    });
    expect(modal()).toBeNull();
    expect(entry).toMatchObject({ name: 'raw.bin', mimeType: 'application/octet-stream', size: 4 });
    expect(Array.from(caller)).toEqual([1, 2, 3, 4]); // we encrypted (and wiped) our own copy
    await act(async () => {
      expect(await dlg.saveEncrypted('custom.dat', 'y', 'application/x-custom')).toMatchObject({ mimeType: 'application/x-custom' });
    });
  });

  it('cancelling (Close or Escape) resolves null and stores nothing', async () => {
    await mountHost();
    let result: unknown = 'pending';
    act(() => {
      void dlg.saveEncrypted('n.txt', 'z').then((r) => (result = r));
    });
    await until(() => modal());
    press(buttonIn(modal()!, 'Close dialog')!);
    await until(() => result !== 'pending');
    expect(result).toBeNull();
    expect(modal()).toBeNull();
    expect(await adapter.listNamespaces()).toEqual([]);

    result = 'pending';
    act(() => {
      void dlg.openEncrypted(() => undefined).then((r) => (result = r));
    });
    await until(() => modal());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await until(() => result !== 'pending');
    expect(result).toBe(false);
  });

  it('openEncrypted while locked: pattern → file browser → decrypts the chosen file into onSelect', async () => {
    await mountHost();
    const s = await saveWithPattern('report.md', '# Quarterly\n\ncontents');
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await s.wait();
    act(() => dlg.lockVault());
    await flush();

    let picked: { name: string; bytes: Uint8Array; text: () => string; mimeType: string } | null = null;
    let opened: unknown;
    act(() => {
      void dlg.openEncrypted((f) => void (picked = f)).then((r) => (opened = r));
    });
    await until(() => modal());
    expect(modal()!.textContent).toContain('Open encrypted');
    draw(grid(), PATTERN_A);

    const list = await until(() => modal()?.querySelector('[data-testid="vault-modal-files"]'));
    expect(list.querySelectorAll('li')).toHaveLength(1);
    expect(list.textContent).toContain('report.md');
    expect(modal()!.querySelector('[data-testid="vault-modal-recovery-words"]')).toBeNull();

    press(buttonIn(modal()!, 'Open report.md')!);
    await until(() => opened !== undefined);
    expect(opened).toBe(true);
    expect(modal()).toBeNull();
    expect(picked).not.toBeNull();
    expect(picked!.name).toBe('report.md');
    expect(picked!.mimeType).toBe('text/markdown');
    expect(picked!.text()).toBe('# Quarterly\n\ncontents');
    expect(picked!.bytes).toBeInstanceOf(Uint8Array);
  });

  it('openEncrypted when unlocked goes straight to the browser; delete (two-step) and .vault export work', async () => {
    await mountHost();
    const s = await saveWithPattern('keep.txt', 'k');
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await s.wait();
    await act(async () => {
      await dlg.saveEncrypted('drop.txt', 'd');
    });

    act(() => {
      void dlg.openEncrypted(() => undefined);
    });
    await until(() => modal()?.querySelector('[data-testid="vault-modal-files"]'));
    expect(modal()!.querySelector('svg[role="application"]')).toBeNull(); // no second pattern prompt
    expect(modal()!.querySelectorAll('[data-testid="vault-modal-files"] li')).toHaveLength(2);

    press(buttonIn(modal()!, 'Delete drop.txt')!);
    press(buttonIn(modal()!, 'Confirm delete drop.txt')!);
    await until(() => modal()!.querySelectorAll('[data-testid="vault-modal-files"] li').length === 1);
    expect(modal()!.textContent).toContain('Deleted “drop.txt”');
    expect(await itemBlobs()).toBe(1);

    const exported: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (exported.push(b), 'blob:dialog/export'));
    const clicked: string[] = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    press(buttonIn(modal()!, 'Export .vault')!);
    await until(() => /Exported vault-\d{8}-\d{4}\.vault/.test(modal()!.textContent ?? ''));
    expect(clicked[0]).toMatch(/^vault-\d{8}-\d{4}\.vault$/);
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as ArrayBuffer);
      r.readAsArrayBuffer(exported[0]!);
    }));
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('VLT1');
  });

  it('a different pattern opens a different, empty vault (no wrong-pattern error)', async () => {
    await mountHost();
    const s = await saveWithPattern('a.txt', 'a');
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await s.wait();
    act(() => dlg.lockVault());
    await flush();

    act(() => {
      void dlg.openEncrypted(() => undefined);
    });
    await until(() => modal());
    draw(grid(), PATTERN_B);
    // New vault → recovery step first, then an empty browser.
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await until(() => /no files yet/.test(modal()?.textContent ?? ''));
    expect(modal()!.textContent).not.toMatch(/wrong|incorrect|invalid/i);
  });

  it('locking while the recovery step is open aborts the save (resolves null, nothing stored)', async () => {
    await mountHost();
    let result: unknown = 'pending';
    act(() => {
      void dlg.saveEncrypted('n.txt', 'will not be saved').then((r) => (result = r));
    });
    await until(() => modal());
    draw(grid(), PATTERN_A);
    await until(() => modal()?.querySelector('[data-testid="vault-modal-recovery-words"]'));
    act(() => dlg.vault.client.lock()); // e.g. the tab was hidden
    await until(() => result !== 'pending');
    expect(result).toBeNull();
    expect(modal()).toBeNull();
    expect(await itemBlobs()).toBe(0);
  });

  it('rejects a too-short pattern with a hint and lets the user try again', async () => {
    await mountHost();
    act(() => {
      void dlg.saveEncrypted('n.txt', 'x');
    });
    await until(() => modal());
    draw(grid(), [0, 1, 2]);
    await until(() => /at least 6 dots/.test(modal()!.textContent ?? ''));
    expect(await adapter.listNamespaces()).toEqual([]);
    draw(grid(), PATTERN_A);
    await until(() => modal()?.querySelector('[data-testid="vault-modal-recovery-words"]'));
  });

  it('shows a save error with Retry instead of losing the data', async () => {
    await mountHost();
    const s = await saveWithPattern('ok.txt', 'ok');
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await s.wait();
    act(() => dlg.lockVault());
    await flush();

    let result: unknown = 'pending';
    act(() => {
      void dlg.saveEncrypted('', 'empty name').then((r) => (result = r)); // invalid name → SDK rejects
    });
    await until(() => modal());
    draw(grid(), PATTERN_A);
    await until(() => /Could not save/.test(modal()?.textContent ?? ''));
    expect(buttonIn(modal()!, 'Try again')).toBeDefined();
    press(buttonIn(modal()!, 'Cancel')!);
    await until(() => result !== 'pending');
    expect(result).toBeNull();
  });

  it('the duress pattern wipes storage and closes the modal without saving', async () => {
    await mountHost({ duress: DURESS });
    const s = await saveWithPattern('real.txt', 'real');
    press(await until(() => buttonIn(modal() ?? document, 'I have written this down')));
    await s.wait();
    act(() => dlg.lockVault());
    await flush();
    expect(await adapter.listNamespaces()).toHaveLength(1);

    let result: unknown = 'pending';
    act(() => {
      void dlg.saveEncrypted('x.txt', 'x').then((r) => (result = r));
    });
    await until(() => modal());
    draw(grid(), DURESS);
    await until(() => result !== 'pending');
    expect(result).toBeNull();
    expect(modal()).toBeNull();
    expect(await adapter.listNamespaces()).toEqual([]);
  });

  it('uses only inline styles and honours the theme', async () => {
    await mountHost({ theme: { accent: '#ff00aa', nodeColor: '#123456' } });
    act(() => {
      void dlg.saveEncrypted('n.txt', 'x');
    });
    await until(() => modal());
    const overlay = document.querySelector<HTMLElement>('[data-vaulty-modal]')!;
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.className).toBe('');
    expect(modal()!.className).toBe('');
    expect(overlay.querySelector('[class]')).toBeNull(); // no CSS classes anywhere in the modal
    expect(grid().innerHTML).toContain('fill="#123456"'); // nodeColor drives the PatternGrid
    expect(modal()!.getAttribute('aria-labelledby')).toBeTruthy();

    draw(grid(), PATTERN_A);
    const confirm = await until(() => buttonIn(modal() ?? document, 'I have written this down'));
    expect(confirm.style.background).toBe('rgb(255, 0, 170)'); // accent drives primary actions
  });

  it('settles a pending promise when the host unmounts', async () => {
    await mountHost();
    let result: unknown = 'pending';
    act(() => {
      void dlg.saveEncrypted('n.txt', 'x').then((r) => (result = r));
    });
    await until(() => modal());
    act(() => root.unmount());
    await flush();
    expect(result).toBeNull();
    root = createRoot(container);
  });

  it('renders through a portal into <body>, escaping clipping/transformed ancestors', async () => {
    await mountHost({ clip: true });
    act(() => {
      void dlg.saveEncrypted('n.txt', 'x');
    });
    await until(() => modal());
    const overlay = document.querySelector('[data-vaulty-modal]')!;
    expect(overlay.parentElement).toBe(document.body);
    expect(container.querySelector('[data-vaulty-modal]')).toBeNull();
    expect(container.querySelector('[data-testid="clipper"]')!.contains(overlay)).toBe(false);
    act(() => root.unmount()); // unmounting the host removes the portal content too
    expect(document.querySelector('[data-vaulty-modal]')).toBeNull();
    root = createRoot(container);
  });

  describe('focus management', () => {
    const tab = (shiftKey = false) =>
      act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
      });

    it('traps Tab / Shift+Tab inside the dialog and wraps at both ends', async () => {
      await mountHost();
      act(() => {
        void dlg.saveEncrypted('n.txt', 'x');
      });
      await until(() => modal());
      const closeBtn = buttonIn(modal()!, 'Close dialog')!;
      const gridEl = grid();
      // Focus starts on the pattern grid, so keyboard users can draw straight away.
      expect(document.activeElement).toBe(gridEl);

      // Last → Tab → first
      act(() => gridEl.focus());
      tab();
      expect(document.activeElement).toBe(closeBtn);
      // First → Shift+Tab → last
      tab(true);
      expect(document.activeElement).toBe(gridEl);
    });

    it('pulls focus back inside if it escapes to the page behind', async () => {
      await mountHost();
      act(() => {
        void dlg.saveEncrypted('n.txt', 'x');
      });
      await until(() => modal());
      act(() => (container.querySelector('#opener') as HTMLButtonElement).focus());
      expect(modal()!.contains(document.activeElement)).toBe(true);
    });

    it('keeps focus on the only control of a step (recovery phrase)', async () => {
      await mountHost();
      act(() => {
        void dlg.saveEncrypted('n.txt', 'x');
      });
      await until(() => modal());
      draw(grid(), PATTERN_A);
      const confirm = await until(() => buttonIn(modal() ?? document, 'I have written this down'));
      expect(document.activeElement).toBe(confirm);
      tab();
      expect(document.activeElement).toBe(confirm);
      tab(true);
      expect(document.activeElement).toBe(confirm);
    });

    it('restores focus to the element that opened the modal', async () => {
      await mountHost();
      const opener = container.querySelector<HTMLButtonElement>('#opener')!;
      act(() => opener.focus());
      act(() => {
        void dlg.openEncrypted(() => undefined);
      });
      await until(() => modal());
      expect(document.activeElement).not.toBe(opener);
      press(buttonIn(modal()!, 'Close dialog')!);
      await flush();
      expect(modal()).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  });

  it('does not get stuck in a render loop', async () => {
    await mountHost();
    act(() => {
      void dlg.saveEncrypted('n.txt', 'x');
    });
    await until(() => modal());
    await flush(200);
    const before = renders;
    await flush(300);
    expect(renders).toBe(before); // idle modal ⇒ no further host renders
  });
});
