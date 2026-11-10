import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the showcase contract: CryptKeep contains NO vault encryption, key derivation or storage logic.
 * The only crypto it touches is HMAC signing of the TOTP counter (RFC 6238) in lib/totp.ts.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');
const PKG = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const files = walk(SRC).map((p) => ({ path: p.slice(SRC.length + 1), code: stripComments(readFileSync(p, 'utf8')) }));
const others = files.filter((f) => f.path !== join('lib', 'totp.ts'));
const totpFile = files.find((f) => f.path === join('lib', 'totp.ts'))!;

describe('CryptKeep architecture: no crypto or storage logic outside @vaulty/core', () => {
  it('scans a meaningful number of source files', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(totpFile).toBeDefined();
  });

  it('uses Web Crypto nowhere except lib/totp.ts', () => {
    const re = /\bcrypto\s*\.\s*(subtle|getRandomValues|randomUUID)\b|\bsubtle\s*\.|\bimportKey\b|\bderiveKey\b|\bderiveBits\b/;
    expect(others.filter((f) => re.test(f.code)).map((f) => f.path)).toEqual([]);
  });

  it('lib/totp.ts performs HMAC signing only — no encryption, key derivation, key export or randomness', () => {
    expect(totpFile.code).toMatch(/name:\s*'HMAC'/);
    expect(totpFile.code).toMatch(/\[\s*'sign'\s*,?\s*\]/);
    for (const banned of [/\bencrypt\b/, /\bdecrypt\b/, /\bderiveKey\b/, /\bderiveBits\b/, /\bexportKey\b/, /\bwrapKey\b/, /getRandomValues/, /\bAES\b/, /PBKDF2/]) {
      expect(totpFile.code).not.toMatch(banned);
    }
  });

  it.each<[string, RegExp]>([
    ['web storage', /\b(local|session)Storage\b|document\s*\.\s*cookie/],
    ['browser databases', /\bindexedDB\b|\bIDBDatabase\b|\bnavigator\s*\.\s*storage\b|\bgetDirectory\b|\bcreateWritable\b|\bcaches\s*\./],
    ['network I/O', /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/],
    ['insecure randomness', /Math\s*\.\s*random/],
    ['console output', /\bconsole\s*\./],
  ])('contains no %s', (_label, re) => {
    expect(files.filter((f) => re.test(f.code)).map((f) => f.path)).toEqual([]);
  });

  it('touches navigator.clipboard only from lib/clipboard.ts', () => {
    expect(files.filter((f) => /navigator\s*\??\.\s*clipboard|clipboard\s*\.\s*readText/.test(f.code)).map((f) => f.path)).toEqual([
      join('lib', 'clipboard.ts'),
    ]);
  });

  it('imports only react, react-dom, @vaulty/core, @vaulty/core/react and local files', () => {
    const allowed = /^(\.{1,2}\/.*|react|react\/jsx-runtime|react-dom\/client|@vaulty\/core|@vaulty\/core\/react)$/;
    const bad: string[] = [];
    for (const f of files) {
      for (const m of f.code.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
        if (!allowed.test(m[1]!) && !m[1]!.endsWith('.css')) bad.push(`${f.path}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps the Vite base configurable for sub-path hosting (GitHub Pages)', () => {
    const cfg = readFileSync(resolve(HERE, '../vite.config.ts'), 'utf8');
    expect(cfg).toContain("base: process.env.VITE_BASE_PATH || '/'");
  });

  it('uses an app-specific storage root so apps sharing one origin keep separate vaults', () => {
    const adapter = files.find((f) => f.path.endsWith('adapter.ts'))!.code;
    expect(adapter).toContain("rootName: 'cryptkeep'");
  });

  it('declares only @vaulty/core, react and react-dom as runtime dependencies', () => {
    expect(Object.keys(PKG.dependencies).sort()).toEqual(['@vaulty/core', 'react', 'react-dom']);
  });

  it('drives the SDK for every showcased capability', () => {
    const all = files.map((f) => f.code).join('\n');
    for (const needle of [
      'useVault',
      'PatternGrid',
      'putRecord',
      'getRecord',
      'deleteFile',
      'exportArchive',
      'importArchive',
      'createBestStorageAdapter',
      'WORDLIST',
      'newPattern',
    ]) {
      expect(all, needle).toContain(needle);
    }
  });
});
