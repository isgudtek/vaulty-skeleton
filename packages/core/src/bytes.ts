import { VaultyError } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s: string): Uint8Array => encoder.encode(s);
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

const tagOf = (v: unknown): string => Object.prototype.toString.call(v);

/** Realm-safe `instanceof Uint8Array` (works across iframes, workers, jsdom). */
export function isUint8Array(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array || tagOf(v) === '[object Uint8Array]';
}

/** Realm-safe `instanceof Blob`. */
export function isBlob(v: unknown): v is Blob {
  return typeof Blob !== 'undefined' && (v instanceof Blob || tagOf(v) === '[object Blob]');
}

/** Realm-safe `instanceof ArrayBuffer`. */
export function isArrayBuffer(v: unknown): v is ArrayBuffer {
  return v instanceof ArrayBuffer || tagOf(v) === '[object ArrayBuffer]';
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new VaultyError('INVALID_ARGUMENT', 'Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Length-checked, branch-free-on-content equality (for non-secret-critical comparisons). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Parse a canonical UUID string into its 16 raw bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new VaultyError('INVALID_ARGUMENT', 'Invalid UUID');
  return hexToBytes(hex);
}

export function bytesToUuid(bytes: Uint8Array): string {
  const h = bytesToHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Growable big-endian writer. */
export class ByteWriter {
  readonly #chunks: Uint8Array[] = [];

  u8(v: number): this {
    this.#chunks.push(Uint8Array.of(v & 0xff));
    return this;
  }
  u16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, false);
    this.#chunks.push(b);
    return this;
  }
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, false);
    this.#chunks.push(b);
    return this;
  }
  bytes(b: Uint8Array): this {
    this.#chunks.push(b);
    return this;
  }
  finish(): Uint8Array {
    return concatBytes(...this.#chunks);
  }
}

/** Strict bounds-checked big-endian reader; every overrun is a typed error, never a RangeError. */
export class ByteReader {
  readonly #view: DataView;
  #offset = 0;

  constructor(private readonly data: Uint8Array) {
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get offset(): number {
    return this.#offset;
  }
  get remaining(): number {
    return this.data.length - this.#offset;
  }

  #need(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) {
      throw new VaultyError('ARCHIVE_INVALID', 'Truncated or malformed binary data');
    }
  }

  u8(): number {
    this.#need(1);
    return this.#view.getUint8(this.#offset++);
  }
  u16(): number {
    this.#need(2);
    const v = this.#view.getUint16(this.#offset, false);
    this.#offset += 2;
    return v;
  }
  u32(): number {
    this.#need(4);
    const v = this.#view.getUint32(this.#offset, false);
    this.#offset += 4;
    return v;
  }
  /** Returns a copy so callers can wipe/own it independently of the source buffer. */
  bytes(n: number): Uint8Array {
    this.#need(n);
    const out = this.data.slice(this.#offset, this.#offset + n);
    this.#offset += n;
    return out;
  }
}
