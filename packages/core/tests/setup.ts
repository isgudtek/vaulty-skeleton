import { webcrypto } from 'node:crypto';

// Guarantee Web Crypto on globalThis for every Node version the suite runs on.
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
