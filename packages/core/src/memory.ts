import { VaultyError } from './types';

/**
 * Volatile-memory hygiene.
 *
 * JavaScript cannot guarantee that no copy of a value exists elsewhere (GC, JIT, swap),
 * but key material is kept in a single `Uint8Array` that is deterministically zeroed with
 * `fill(0)` on lock / visibilitychange / pagehide / idle timeout. CryptoKey objects derived
 * from it are created per operation, non-extractable, and dropped immediately.
 */
export class SecureBuffer {
  #bytes: Uint8Array;
  #wiped = false;

  /** Takes ownership of `bytes` (no copy) so that wiping zeroes the caller's array too. */
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  static alloc(length: number): SecureBuffer {
    return new SecureBuffer(new Uint8Array(length));
  }

  /** Copy `bytes` into a fresh SecureBuffer. */
  static copyOf(bytes: Uint8Array): SecureBuffer {
    return new SecureBuffer(bytes.slice());
  }

  get length(): number {
    return this.#bytes.length;
  }

  get isWiped(): boolean {
    return this.#wiped;
  }

  /** Live view of the key bytes. Throws once wiped so a stale handle can never be used. */
  get bytes(): Uint8Array {
    if (this.#wiped) {
      throw new VaultyError('VAULT_LOCKED', 'SecureBuffer has been wiped');
    }
    return this.#bytes;
  }

  /** Deterministically overwrite with zeros. Idempotent. */
  wipe(): void {
    this.#bytes.fill(0);
    this.#wiped = true;
  }
}

/** Zero any Uint8Array in place (helper for transient plaintext). */
export function wipeBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

type Listener = () => void;

/** Structural subset of `EventTarget` so Node tests (and SSR) can inject fakes. */
export interface GuardEventTarget {
  addEventListener(type: string, listener: Listener, options?: unknown): void;
  removeEventListener(type: string, listener: Listener, options?: unknown): void;
}

export interface GuardDocumentLike extends GuardEventTarget {
  visibilityState?: string;
  hidden?: boolean;
}

export type LockReason = 'manual' | 'hidden' | 'pagehide' | 'idle';

export interface SessionGuardOptions {
  /** Invoked (once per lock) AFTER registered buffers have been wiped. */
  onLock: (reason: LockReason) => void;
  /** Lock after this many ms without `touch()`/user activity. 0/undefined disables. */
  idleTimeoutMs?: number;
  /** Lock when the document becomes hidden. Default true. */
  lockOnHidden?: boolean;
  /** Lock on `pagehide`. Default true. */
  lockOnPageHide?: boolean;
  /** Treat pointer/key/touch events as activity that resets the idle timer. Default true. */
  trackActivity?: boolean;
  /** Test/SSR injection; defaults to `globalThis.document` / `globalThis.window` when present. */
  documentRef?: GuardDocumentLike | null;
  windowRef?: GuardEventTarget | null;
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

/**
 * Locks the vault on tab hide / page hide / inactivity and wipes registered key buffers.
 * Safe to construct in SSR/Node: with no `document`/`window` it simply has no browser hooks
 * (idle timeouts still work).
 */
export class SessionGuard {
  readonly #options: SessionGuardOptions;
  readonly #buffers = new Set<SecureBuffer>();
  #doc: GuardDocumentLike | null;
  #win: GuardEventTarget | null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #active = false;
  #idleTimeoutMs: number;

  readonly #onVisibility: Listener = () => {
    const doc = this.#doc;
    if (!doc) return;
    const hidden = doc.visibilityState === 'hidden' || doc.hidden === true;
    if (hidden && this.#options.lockOnHidden !== false) this.lock('hidden');
  };
  readonly #onPageHide: Listener = () => {
    if (this.#options.lockOnPageHide !== false) this.lock('pagehide');
  };
  readonly #onActivity: Listener = () => this.touch();

  constructor(options: SessionGuardOptions) {
    this.#options = options;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 0;
    const g = globalThis as { document?: GuardDocumentLike; window?: GuardEventTarget };
    this.#doc =
      options.documentRef !== undefined ? options.documentRef : (g.document ?? null);
    this.#win = options.windowRef !== undefined ? options.windowRef : (g.window ?? null);
  }

  get isActive(): boolean {
    return this.#active;
  }

  get idleTimeoutMs(): number {
    return this.#idleTimeoutMs;
  }

  /** Register a buffer to be zeroed on every lock. */
  register(buffer: SecureBuffer): void {
    this.#buffers.add(buffer);
  }

  unregister(buffer: SecureBuffer): void {
    this.#buffers.delete(buffer);
  }

  /** Attach listeners and arm the idle timer. Idempotent. */
  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#doc?.addEventListener('visibilitychange', this.#onVisibility);
    this.#win?.addEventListener('pagehide', this.#onPageHide);
    if (this.#options.trackActivity !== false) {
      const target = this.#doc ?? this.#win;
      if (target) {
        for (const ev of ACTIVITY_EVENTS) {
          target.addEventListener(ev, this.#onActivity, { passive: true });
        }
      }
    }
    this.touch();
  }

  /** Detach listeners and cancel timers. Does NOT wipe buffers (use `lock`). */
  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#clearTimer();
    this.#doc?.removeEventListener('visibilitychange', this.#onVisibility);
    this.#win?.removeEventListener('pagehide', this.#onPageHide);
    const target = this.#doc ?? this.#win;
    if (target) {
      for (const ev of ACTIVITY_EVENTS) target.removeEventListener(ev, this.#onActivity);
    }
  }

  /** Reset the idle timer (call on user activity). */
  touch(): void {
    if (!this.#active) return;
    this.#clearTimer();
    if (this.#idleTimeoutMs > 0) {
      this.#timer = setTimeout(() => this.lock('idle'), this.#idleTimeoutMs);
      // Never keep a Node process alive just for the idle timer.
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  setIdleTimeout(ms: number): void {
    this.#idleTimeoutMs = Math.max(0, ms);
    this.touch();
  }

  /** Wipe every registered buffer, stop the guard and notify. Idempotent per session. */
  lock(reason: LockReason = 'manual'): void {
    for (const buf of this.#buffers) buf.wipe();
    this.#buffers.clear();
    const wasActive = this.#active;
    this.stop();
    if (wasActive || reason === 'manual') this.#options.onLock(reason);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
