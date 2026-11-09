import { WORDLIST } from '@vaulty/core';
import type { TotpAlgorithm } from './totp';

/** Structured payloads stored with `VaultClient.putRecord<T>()`. CryptKeep never encrypts them itself. */
export interface SeedEntry {
  label: string;
  network: string;
  wordCount: 12 | 24;
  words: string[];
  derivationPath: string;
  notes: string;
}

export interface TotpEntry {
  issuer: string;
  account: string;
  /** Base32 shared secret. */
  secret: string;
  digits: 6 | 8;
  period: number;
  algorithm: TotpAlgorithm;
}

export const TAG_SEED = 'seed';
export const TAG_TOTP = 'totp';

export const NETWORKS = ['Bitcoin', 'Ethereum', 'Solana', 'Cosmos', 'Other'] as const;

const BIP39 = new Set<string>(WORDLIST);

export function parseSeedWords(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

export interface SeedValidation {
  errors: string[];
  /** Words missing from the BIP-39 English list (some wallets legitimately use other lists). */
  unknownWords: string[];
}

export function validateSeed(words: string[], expected: 12 | 24, allowNonBip39: boolean): SeedValidation {
  const errors: string[] = [];
  if (words.length !== expected) errors.push(`Enter exactly ${expected} words (found ${words.length}).`);
  const unknownWords = words.filter((w) => !BIP39.has(w));
  if (unknownWords.length > 0 && !allowNonBip39) {
    errors.push(
      `${unknownWords.length} word${unknownWords.length === 1 ? ' is' : 's are'} not in the BIP-39 list. Check for typos, or tick “other word list”.`,
    );
  }
  return { errors, unknownWords };
}
