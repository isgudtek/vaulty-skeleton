import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the showcase contract: GhostDrop contains NO cryptographic or storage logic of its own.
 * Everything of that kind must come from @vaulty/core / @vaulty/core/react.
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

const FORBIDDEN: Array<[string, RegExp]> = [
  ['Web Crypto', /\bcrypto\s*\.\s*(subtle|getRandomValues|randomUUID)\b|\bsubtle\s*\.|\bimportKey\b|\bderiveKey\b|\bderiveBits\b/],
  ['web storage', /\b(local|session)Storage\b|document\s*\.\s*cookie/],
  ['browser databases', /\bindexedDB\b|\bIDBDatabase\b|\bnavigator\s*\.\s*storage\b|\bgetDirectory\b|\bcreateWritable\b|\bcaches\s*\./],
  ['network I/O', /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/],
  ['insecure randomness', /Math\s*\.\s*random/],
  ['console output', /\bconsole\s*\./],
];

describe('GhostDrop architecture: no crypto or storage logic outside @vaulty/core', () => {
  it('scans a meaningful number of source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN)('contains no %s', (_label, re) => {
    const offenders = files.filter((f) => re.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
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

  it('declares only @vaulty/core, react and react-dom as runtime dependencies', () => {
    expect(Object.keys(PKG.dependencies).sort()).toEqual(['@vaulty/core', 'react', 'react-dom']);
  });

  it('actually drives the SDK for every showcased capability', () => {
    const all = files.map((f) => f.code).join('\n');
    for (const needle of [
      'useVault',
      'PatternGrid',
      'putFile',
      'getFile',
      'deleteFile',
      'configureDuress',
      'exportArchive',
      'importArchive',
      'createBestStorageAdapter',
    ]) {
      expect(all, needle).toContain(needle);
    }
  });
});
