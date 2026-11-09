/**
 * RFC 6238 TOTP / RFC 4226 HOTP using ONLY the native Web Crypto HMAC primitive.
 *
 * This is the one place CryptKeep touches `crypto.subtle`, and only for HMAC *signing* of a counter —
 * the algorithm authenticator apps are required to implement (HMAC-SHA1 by default). All vault
 * encryption, key derivation and storage live in @vaulty/core.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

const HASH_NAME: Record<TotpAlgorithm, string> = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

/** Uppercase and strip spaces, dashes and `=` padding from a user-entered Base32 key. */
export function normalizeBase32(input: string): string {
  return input.replace(/[\s-]+/g, '').replace(/=+$/g, '').toUpperCase();
}

export function isValidBase32(input: string, minChars = 16): boolean {
  const s = normalizeBase32(input);
  return s.length >= minChars && /^[A-Z2-7]+$/.test(s);
}

export function base32Decode(input: string): Uint8Array {
  const s = normalizeBase32(input);
  if (s.length === 0 || !/^[A-Z2-7]+$/.test(s)) throw new Error('Invalid Base32 secret');
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

export interface OtpauthParams {
  issuer: string;
  account: string;
  secret: string;
  digits: 6 | 8;
  period: number;
  algorithm: TotpAlgorithm;
}

/** Parse `otpauth://totp/Issuer:account?secret=…&issuer=…&digits=6&period=30&algorithm=SHA1`. */
export function parseOtpauth(uri: string): OtpauthParams {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error('Not a valid otpauth:// link');
  }
  if (url.protocol !== 'otpauth:') throw new Error('Not an otpauth:// link');
  if (url.hostname !== 'totp') throw new Error('Only time-based (totp) codes are supported');
  const secret = url.searchParams.get('secret');
  if (!secret || !isValidBase32(secret, 8)) throw new Error('The link has no valid Base32 secret');

  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const colon = label.indexOf(':');
  const labelIssuer = colon >= 0 ? label.slice(0, colon).trim() : '';
  const account = (colon >= 0 ? label.slice(colon + 1) : label).trim();
  const issuer = (url.searchParams.get('issuer') ?? labelIssuer).trim();

  const digitsRaw = Number(url.searchParams.get('digits') ?? '6');
  if (digitsRaw !== 6 && digitsRaw !== 8) throw new Error('Only 6 or 8 digit codes are supported');
  const period = Number(url.searchParams.get('period') ?? '30');
  if (!Number.isInteger(period) || period < 1 || period > 300) throw new Error('Invalid period');
  const algo = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '');
  if (algo !== 'SHA1' && algo !== 'SHA256' && algo !== 'SHA512') throw new Error('Unsupported algorithm');

  return { issuer, account, secret: normalizeBase32(secret), digits: digitsRaw, period, algorithm: algo };
}

function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000), false);
  view.setUint32(4, counter >>> 0, false);
  return buf;
}

/** RFC 4226 HOTP. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits: 6 | 8 = 6,
  algorithm: TotpAlgorithm = 'SHA1',
): Promise<string> {
  if (secret.length === 0) throw new Error('Empty secret');
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid counter');
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: HASH_NAME[algorithm] }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter) as BufferSource));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpOptions {
  period?: number;
  digits?: 6 | 8;
  algorithm?: TotpAlgorithm;
}

/** RFC 6238 TOTP for a Base32 secret at wall-clock `nowMs`. */
export async function totp(secretBase32: string, nowMs: number, options: TotpOptions = {}): Promise<string> {
  const period = options.period ?? 30;
  const counter = Math.floor(nowMs / 1000 / period);
  const secret = base32Decode(secretBase32);
  try {
    return await hotp(secret, counter, options.digits ?? 6, options.algorithm ?? 'SHA1');
  } finally {
    secret.fill(0);
  }
}

export function timeStep(nowMs: number, period = 30): number {
  return Math.floor(nowMs / 1000 / period);
}

/** Seconds (1…period) until the current code expires. */
export function secondsRemaining(nowMs: number, period = 30): number {
  return period - (Math.floor(nowMs / 1000) % period);
}

/** `123456` → `123 456` for readability. */
export function groupCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
