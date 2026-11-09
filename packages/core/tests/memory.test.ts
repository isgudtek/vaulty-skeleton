import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecureBuffer, SessionGuard, wipeBytes, type GuardDocumentLike } from '../src/memory';

class FakeTarget implements GuardDocumentLike {
  visibilityState = 'visible';
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, l: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: () => void): void {
    this.listeners.get(type)?.delete(l);
  }
  emit(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  get count(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

afterEach(() => vi.useRealTimers());

describe('wipeBytes', () => {
  it('zeroes in place', () => {
    const b = new Uint8Array([1, 2, 3]);
    wipeBytes(b);
    expect(Array.from(b)).toEqual([0, 0, 0]);
  });
});

describe('SessionGuard', () => {
  it('wipes registered buffers and notifies on visibilitychange → hidden', () => {
    const doc = new FakeTarget();
    const win = new FakeTarget();
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, documentRef: doc, windowRef: win });
    const key = SecureBuffer.copyOf(new Uint8Array(32).fill(7));
    guard.register(key);
    guard.start();

    doc.emit('visibilitychange'); // visible: no-op
    expect(onLock).not.toHaveBeenCalled();
    expect(key.isWiped).toBe(false);

    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    expect(key.isWiped).toBe(true);
    expect(onLock).toHaveBeenCalledExactlyOnceWith('hidden');
    expect(doc.count + win.count).toBe(0); // fully detached
  });

  it('honours document.hidden and locks on pagehide', () => {
    const doc = new FakeTarget();
    const win = new FakeTarget();
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, documentRef: doc, windowRef: win });
    const key = SecureBuffer.alloc(32);
    guard.register(key);
    guard.start();
    win.emit('pagehide');
    expect(key.isWiped).toBe(true);
    expect(onLock).toHaveBeenCalledWith('pagehide');

    class HiddenDoc extends FakeTarget {
      hidden = true;
    }
    const doc2 = new HiddenDoc();
    const onLock2 = vi.fn();
    const g2 = new SessionGuard({ onLock: onLock2, documentRef: doc2, windowRef: null });
    g2.start();
    doc2.emit('visibilitychange');
    expect(onLock2).toHaveBeenCalledWith('hidden');
  });

  it('can disable hidden / pagehide locking', () => {
    const doc = new FakeTarget();
    const win = new FakeTarget();
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, documentRef: doc, windowRef: win, lockOnHidden: false, lockOnPageHide: false });
    guard.start();
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    win.emit('pagehide');
    expect(onLock).not.toHaveBeenCalled();
    guard.stop();
  });

  it('enforces the idle timeout and resets it on touch()/user activity', () => {
    vi.useFakeTimers();
    const doc = new FakeTarget();
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, idleTimeoutMs: 1000, documentRef: doc, windowRef: null });
    const key = SecureBuffer.alloc(32);
    guard.register(key);
    guard.start();
    vi.advanceTimersByTime(900);
    guard.touch();
    vi.advanceTimersByTime(900);
    doc.emit('pointerdown'); // activity tracked
    vi.advanceTimersByTime(900);
    expect(onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onLock).toHaveBeenCalledExactlyOnceWith('idle');
    expect(key.isWiped).toBe(true);
    expect(guard.isActive).toBe(false);
  });

  it('can change the idle timeout at runtime and ignores activity when tracking is off', () => {
    vi.useFakeTimers();
    const doc = new FakeTarget();
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, documentRef: doc, windowRef: null, trackActivity: false });
    guard.start();
    expect(doc.listeners.has('pointerdown')).toBe(false);
    guard.setIdleTimeout(500);
    expect(guard.idleTimeoutMs).toBe(500);
    vi.advanceTimersByTime(499);
    expect(onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onLock).toHaveBeenCalledWith('idle');
  });

  it('is a safe no-op for browser hooks in Node/SSR (no document, no window)', () => {
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, documentRef: null, windowRef: null });
    expect(() => guard.start()).not.toThrow();
    expect(guard.isActive).toBe(true);
    guard.stop();
    expect(guard.isActive).toBe(false);
  });

  it('defaults to globalThis.document/window when present', () => {
    const doc = new FakeTarget();
    const win = new FakeTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    try {
      const onLock = vi.fn();
      const guard = new SessionGuard({ onLock });
      guard.start();
      expect(doc.listeners.get('visibilitychange')?.size).toBe(1);
      expect(win.listeners.get('pagehide')?.size).toBe(1);
      guard.stop();
      expect(doc.count + win.count).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('manual lock() wipes + notifies once; start/stop are idempotent; unregister keeps a buffer alive', () => {
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, documentRef: null, windowRef: null });
    const a = SecureBuffer.alloc(8);
    const b = SecureBuffer.alloc(8);
    guard.register(a);
    guard.register(b);
    guard.unregister(b);
    guard.start();
    guard.start();
    guard.lock();
    expect(a.isWiped).toBe(true);
    expect(b.isWiped).toBe(false);
    expect(onLock).toHaveBeenCalledExactlyOnceWith('manual');
    guard.stop();
    guard.stop();
  });

  it('does not fire for non-manual reasons after it was stopped', () => {
    const doc = new FakeTarget();
    const onLock = vi.fn();
    const guard = new SessionGuard({ onLock, documentRef: doc, windowRef: null });
    guard.start();
    guard.stop();
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    expect(onLock).not.toHaveBeenCalled();
  });
});
