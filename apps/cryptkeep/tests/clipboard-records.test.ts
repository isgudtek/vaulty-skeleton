import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_CLEAR_MS, ClipboardGuard } from '../src/lib/clipboard';
import { parseSeedWords, validateSeed } from '../src/lib/records';

describe('ClipboardGuard — 15-second auto-clear', () => {
  let writes: string[];
  let ticks: Array<number | null>;
  const clipboard = { writeText: async (t: string) => void writes.push(t) };

  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    ticks = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (clearAfterMs?: number) =>
    new ClipboardGuard({ clipboard, onTick: (s) => ticks.push(s), ...(clearAfterMs ? { clearAfterMs } : {}) });

  it('defaults to exactly 15 seconds', () => {
    expect(CLIPBOARD_CLEAR_MS).toBe(15_000);
  });

  it('copies, counts down every second, and overwrites the clipboard at 15s', async () => {
    const g = make();
    await g.copy('correct horse battery staple');
    expect(writes).toEqual(['correct horse battery staple']);
    expect(g.remaining).toBe(15);
    expect(g.isPending).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(g.remaining).toBe(14);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(g.remaining).toBe(1);
    expect(writes).toEqual(['correct horse battery staple']); // not yet cleared at 14s

    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toEqual(['correct horse battery staple', '']); // cleared at 15s
    expect(g.remaining).toBeNull();
    expect(ticks[0]).toBe(15);
    expect(ticks.slice(0, 16)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, null]);

    await vi.advanceTimersByTimeAsync(60_000); // never clears twice
    expect(writes).toHaveLength(2);
  });

  it('restarts the countdown when another secret is copied', async () => {
    const g = make();
    await g.copy('first');
    await vi.advanceTimersByTimeAsync(10_000);
    await g.copy('second');
    expect(g.remaining).toBe(15);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(writes).toEqual(['first', 'second']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toEqual(['first', 'second', '']);
  });

  it('clearNow() wipes immediately; it is a no-op when nothing is pending', async () => {
    const g = make();
    await g.clearNow();
    expect(writes).toEqual([]);
    await g.copy('secret');
    await g.clearNow();
    expect(writes).toEqual(['secret', '']);
    expect(g.isPending).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toHaveLength(2);
  });

  it('dispose() stops the timer without touching the clipboard', async () => {
    const g = make();
    await g.copy('secret');
    g.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toEqual(['secret']);
  });

  it('supports custom delays', async () => {
    const g = make(3_000);
    await g.copy('x');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(writes).toEqual(['x']);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(['x', '']);
  });

  it('rejects when no clipboard exists and swallows a failing final clear', async () => {
    await expect(new ClipboardGuard().copy('x')).rejects.toThrow('Clipboard is not available');
    let calls = 0;
    const flaky = {
      writeText: async (t: string) => {
        calls++;
        if (t === '') throw new Error('permission revoked');
      },
    };
    const g = new ClipboardGuard({ clipboard: flaky, clearAfterMs: 1_000 });
    await g.copy('x');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(g.isPending).toBe(false);
  });
});

describe('seed phrase parsing & validation', () => {
  const valid12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('splits on whitespace and commas and lower-cases', () => {
    expect(parseSeedWords('  Abandon,ABOUT\nzoo\t')).toEqual(['abandon', 'about', 'zoo']);
    expect(parseSeedWords('')).toEqual([]);
  });

  it('accepts 12 BIP-39 words', () => {
    expect(validateSeed(parseSeedWords(valid12), 12, false).errors).toEqual([]);
  });

  it('flags a wrong word count', () => {
    expect(validateSeed(parseSeedWords(valid12), 24, false).errors[0]).toContain('exactly 24');
    expect(validateSeed(parseSeedWords('abandon about'), 12, false).errors[0]).toContain('found 2');
  });

  it('flags non-BIP-39 words unless another word list is allowed', () => {
    const words = parseSeedWords(valid12.replace('about', 'notaword'));
    const strict = validateSeed(words, 12, false);
    expect(strict.unknownWords).toEqual(['notaword']);
    expect(strict.errors[0]).toContain('not in the BIP-39 list');
    expect(validateSeed(words, 12, true).errors).toEqual([]);
  });
});
