import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  groupCode,
  hotp,
  isValidBase32,
  normalizeBase32,
  parseOtpauth,
  secondsRemaining,
  timeStep,
  totp,
} from '../src/lib/totp';

/** RFC 4226 / 6238 test secret: ASCII "12345678901234567890". */
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('Base32', () => {
  it('decodes the RFC 4648 test vectors', () => {
    const dec = (s: string) => new TextDecoder().decode(base32Decode(s));
    expect(dec('MZXW6===')).toBe('foo');
    expect(dec('MZXW6YQ=')).toBe('foob');
    expect(dec('MZXW6YTB')).toBe('fooba');
    expect(dec('MZXW6YTBOI======')).toBe('foobar');
  });

  it('decodes the RFC test secret', () => {
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET_B32))).toBe('12345678901234567890');
  });

  it('is forgiving about case, spaces, dashes and padding', () => {
    expect(normalizeBase32('gezd gnbv-gy3t qojq====')).toBe('GEZDGNBVGY3TQOJQ');
    expect(Array.from(base32Decode('gezd gnbv gy3t qojq'))).toEqual(Array.from(base32Decode('GEZDGNBVGY3TQOJQ')));
  });

  it('rejects characters outside the alphabet and empty input', () => {
    expect(() => base32Decode('ABC1')).toThrow('Invalid Base32');
    expect(() => base32Decode('abc!')).toThrow('Invalid Base32');
    expect(() => base32Decode('')).toThrow('Invalid Base32');
  });

  it('validates setup keys by alphabet and minimum length', () => {
    expect(isValidBase32('JBSWY3DPEHPK3PXP')).toBe(true);
    expect(isValidBase32('JBSWY3DP')).toBe(false); // too short
    expect(isValidBase32('JBSWY3DPEHPK3PX1')).toBe(false); // '1' is not Base32
    expect(isValidBase32('JBSWY3DP', 8)).toBe(true);
  });
});

describe('HOTP — RFC 4226 Appendix D', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(expected.map((code, counter) => [counter, code] as const))('counter %i → %s', async (counter, code) => {
    expect(await hotp(RFC_SECRET, counter)).toBe(code);
  });

  it('rejects an empty secret and a bad counter', async () => {
    await expect(hotp(new Uint8Array(0), 0)).rejects.toThrow('Empty secret');
    await expect(hotp(RFC_SECRET, -1)).rejects.toThrow('Invalid counter');
    await expect(hotp(RFC_SECRET, 1.5)).rejects.toThrow('Invalid counter');
  });
});

describe('TOTP — RFC 6238 Appendix B (HMAC-SHA1)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('t=%i → %s (8 digits)', async (seconds, code) => {
    expect(await totp(RFC_SECRET_B32, seconds * 1000, { digits: 8 })).toBe(code);
  });

  it.each(vectors)('t=%i → last 6 digits of %s (default 6-digit code)', async (seconds, code) => {
    expect(await totp(RFC_SECRET_B32, seconds * 1000)).toBe(code.slice(2));
  });

  it('stays constant inside a 30-second window and changes at the boundary', async () => {
    const a = await totp(RFC_SECRET_B32, 30_000);
    expect(await totp(RFC_SECRET_B32, 59_999)).toBe(a);
    expect(await totp(RFC_SECRET_B32, 60_000)).not.toBe(a);
  });

  it('honours custom periods', async () => {
    const t = 1_700_000_000_000;
    expect(await totp(RFC_SECRET_B32, t, { period: 60 })).toBe(await hotp(RFC_SECRET, Math.floor(t / 1000 / 60)));
  });
});

describe('TOTP — SHA-256 / SHA-512 agree with an independent HMAC implementation', () => {
  const reference = (alg: 'sha1' | 'sha256' | 'sha512', key: Buffer, counter: number, digits: number) => {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const mac = createHmac(alg, key).update(msg).digest();
    const o = mac[mac.length - 1]! & 0x0f;
    const bin = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
    return String(bin % 10 ** digits).padStart(digits, '0');
  };

  const key = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  const b32 = (() => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const b of key) bits += b.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    return out;
  })();

  it.each([
    ['SHA1', 'sha1'],
    ['SHA256', 'sha256'],
    ['SHA512', 'sha512'],
  ] as const)('%s at many instants and both digit lengths', async (name, node) => {
    for (const ms of [0, 59_000, 1_111_111_109_000, 1_700_000_000_123, 4_102_444_800_000]) {
      for (const digits of [6, 8] as const) {
        const counter = Math.floor(ms / 1000 / 30);
        expect(await totp(b32, ms, { digits, algorithm: name })).toBe(reference(node, key, counter, digits));
      }
    }
  });

  it('handles counters beyond 32 bits', async () => {
    const counter = 2 ** 32 + 5;
    expect(await hotp(key, counter, 6, 'SHA256')).toBe(reference('sha256', key, counter, 6));
  });
});

describe('time helpers', () => {
  it('computes the seconds remaining in the current window', () => {
    expect(secondsRemaining(0)).toBe(30);
    expect(secondsRemaining(1_000)).toBe(29);
    expect(secondsRemaining(59_000)).toBe(1);
    expect(secondsRemaining(60_000)).toBe(30);
    expect(secondsRemaining(61_000, 60)).toBe(59);
  });
  it('computes the time step', () => {
    expect(timeStep(59_999)).toBe(1);
    expect(timeStep(60_000)).toBe(2);
    expect(timeStep(120_000, 60)).toBe(2);
  });
  it('groups codes for display', () => {
    expect(groupCode('123456')).toBe('123 456');
    expect(groupCode('12345678')).toBe('1234 5678');
  });
});

describe('otpauth:// parsing', () => {
  const uri =
    'otpauth://totp/ACME%20Co:john@example.com?secret=hxdmvjecjjwsrb3hwizr4ifugftmxboz&issuer=ACME%20Co&algorithm=SHA1&digits=6&period=30';

  it('parses a standard Key URI', () => {
    expect(parseOtpauth(uri)).toEqual({
      issuer: 'ACME Co',
      account: 'john@example.com',
      secret: 'HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ',
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    });
  });

  it('falls back to the label issuer, applies defaults and supports other algorithms', () => {
    const p = parseOtpauth('otpauth://totp/Example:alice@x.org?secret=GEZDGNBVGY3TQOJQ&digits=8&period=60&algorithm=SHA-256');
    expect(p).toMatchObject({ issuer: 'Example', account: 'alice@x.org', digits: 8, period: 60, algorithm: 'SHA256' });
    expect(parseOtpauth('otpauth://totp/solo?secret=GEZDGNBVGY3TQOJQ')).toMatchObject({ issuer: '', account: 'solo', digits: 6 });
  });

  it.each([
    ['not a url', 'Not a valid otpauth'],
    ['https://example.com/?secret=GEZDGNBVGY3TQOJQ', 'Not an otpauth'],
    ['otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=1', 'time-based'],
    ['otpauth://totp/x', 'no valid Base32'],
    ['otpauth://totp/x?secret=!!!', 'no valid Base32'],
    ['otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=7', '6 or 8'],
    ['otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&period=0', 'Invalid period'],
    ['otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5', 'Unsupported algorithm'],
  ])('rejects %s', (bad, message) => {
    expect(() => parseOtpauth(bad)).toThrow(message);
  });
});
