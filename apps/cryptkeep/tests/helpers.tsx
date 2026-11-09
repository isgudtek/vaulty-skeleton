import { nodeCenter } from '@vaulty/core/react';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

export function mount(element: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Let pending promises/timers run inside act(). */
export async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

/** Poll until `predicate` is truthy (flushing React each tick). */
export async function waitFor<T>(predicate: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await settle(10);
  }
}

/** Draw `nodes` on a PatternGrid <svg> with real pointer events (jsdom has no layout, so mock the rect). */
export function draw(svg: Element, nodes: readonly number[]): void {
  (svg as SVGSVGElement).getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const fire = (type: string, node: number) => {
    const c = nodeCenter(node);
    act(() => {
      svg.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: c.x, clientY: c.y }));
    });
  };
  fire('pointerdown', nodes[0]!);
  for (const n of nodes.slice(1)) fire('pointermove', n);
  fire('pointerup', nodes[nodes.length - 1]!);
}

export const grids = (root: ParentNode): SVGSVGElement[] =>
  Array.from(root.querySelectorAll<SVGSVGElement>('svg[role="application"]'));

export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

export function buttonByText(root: ParentNode, text: string | RegExp): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
  );
}

export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function chooseFile(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export const PATTERN_A = [0, 1, 2, 3, 4, 9];
export const PATTERN_B = [24, 23, 22, 21, 20, 15];
export const DURESS = [10, 11, 12, 13, 14, 19];
export const NEW_PATTERN = [20, 21, 22, 23, 24, 19];
