// @vitest-environment jsdom
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatternGrid, nearestNode, nodeCenter, useVault, type UseVaultResult } from '../src/react';
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
