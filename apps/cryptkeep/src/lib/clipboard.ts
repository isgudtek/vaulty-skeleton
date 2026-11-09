/** How long a copied secret stays on the system clipboard before CryptKeep overwrites it. */
export const CLIPBOARD_CLEAR_MS = 15_000;

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export interface ClipboardGuardOptions {
  clipboard?: ClipboardLike;
  clearAfterMs?: number;
  /** Called with whole seconds remaining, then `null` once cleared/cancelled. */
  onTick?: (secondsRemaining: number | null) => void;
}

/**
 * Copy-with-countdown. After `clearAfterMs` the clipboard is overwritten with an empty string.
 * (Browsers cannot read the clipboard without a prompt, so we cannot check it is still ours;
 * overwriting is the safe default.)
 */
export class ClipboardGuard {
  readonly #clipboard: ClipboardLike | undefined;
  readonly #total: number;
  readonly #onTick: ((s: number | null) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;
  #remaining: number | null = null;

  constructor(options: ClipboardGuardOptions = {}) {
    this.#clipboard = options.clipboard;
    this.#total = Math.max(1, Math.round((options.clearAfterMs ?? CLIPBOARD_CLEAR_MS) / 1000));
    this.#onTick = options.onTick;
  }

  get remaining(): number | null {
    return this.#remaining;
  }

  get isPending(): boolean {
    return this.#remaining !== null;
  }

  #clipboardRef(): ClipboardLike {
    const c = this.#clipboard ?? globalThis.navigator?.clipboard;
    if (!c) throw new Error('Clipboard is not available in this browser');
    return c;
  }

  /** Write `text` to the clipboard and start the auto-clear countdown (restarts if already running). */
  async copy(text: string): Promise<void> {
    await this.#clipboardRef().writeText(text);
    this.#stopTimer();
    this.#remaining = this.#total;
    this.#onTick?.(this.#remaining);
    this.#timer = setInterval(() => {
      if (this.#remaining === null) return;
      this.#remaining -= 1;
      if (this.#remaining <= 0) {
        void this.clearNow();
      } else {
        this.#onTick?.(this.#remaining);
      }
    }, 1000);
  }

  /** Overwrite the clipboard immediately (if a secret is pending) and stop the countdown. */
  async clearNow(): Promise<void> {
    const wasPending = this.#remaining !== null;
    this.#stopTimer();
    this.#remaining = null;
    this.#onTick?.(null);
    if (wasPending) {
      try {
        await this.#clipboardRef().writeText('');
      } catch {
        /* clipboard permission revoked: nothing more we can do */
      }
    }
  }

  /** Stop timers without touching the clipboard. */
  dispose(): void {
    this.#stopTimer();
  }

  #stopTimer(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
