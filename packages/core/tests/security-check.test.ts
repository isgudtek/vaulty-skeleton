import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFiles, checkSource, stripComments } from '../scripts/check-security.mjs';

const rules = (src: string) => checkSource(src, 'x.ts').map((v) => v.rule);

describe('security hygiene checker (guards the save-hook)', () => {
  it.each([
    ['localStorage.setItem("k", v)', 'no-web-storage-rw'],
    ['const v = sessionStorage.getItem("k")', 'no-web-storage-rw'],
    ['localStorage["k"] = "v"', 'no-web-storage-rw'],
    ['window.localStorage?.setItem("a","b")', 'no-web-storage-rw'],
    ['document.cookie = "a=b"', 'no-cookies'],
    ['const iv = Math.random()', 'no-math-random'],
    ["{ name: 'AES-CBC', iv }", 'no-weak-algorithms'],
    ["subtle.digest('SHA-1', d)", 'no-weak-algorithms'],
    ["await subtle.exportKey('raw', k)", 'no-exportkey'],
    ["subtle.importKey('raw', b, 'AES-GCM', true, ['encrypt'])", 'no-extractable-keys'],
    ['const o = { extractable: true }', 'no-extractable-keys'],
    ['const p = { name: "AES-GCM", iv: new Uint8Array(12) }', 'no-static-iv'],
    ['const iv = new Uint8Array(IV_BYTES);', 'no-static-iv'],
    ['const p = { name: "AES-GCM", iv: new Uint8Array([1,2,3]) }', 'no-literal-iv'],
    ['console.log(key)', 'no-console'],
    ['eval("1")', 'no-eval'],
    ['fetch("https://x")', 'no-network'],
    ['debugger;', 'no-debugger'],
  ])('flags %s', (src, rule) => {
    expect(rules(src)).toContain(rule);
  });

  it('flags AES-GCM encryption in a module that never draws a random IV', () => {
    const bad = `await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);`;
    expect(rules(bad)).toContain('encrypt-needs-random-iv');
    const good = `const iv = crypto.getRandomValues(new Uint8Array(12));\n${bad}`;
    expect(rules(good)).not.toContain('encrypt-needs-random-iv');
  });

  it('flags PBKDF2 without SHA-256, non-GCM AES and non-256-bit keys', () => {
    expect(rules(`derive({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations })`)).toContain('pbkdf2-must-use-sha256');
    expect(rules(`derive({ name: 'PBKDF2', salt, iterations })`)).toContain('pbkdf2-must-use-sha256');
    expect(rules(`derive({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations })`)).not.toContain('pbkdf2-must-use-sha256');
    expect(rules(`k({ name: 'AES-KW', length: 256 })`)).toContain('aes-gcm-only');
    expect(rules(`k({ name: 'AES-GCM', length: 128 })`)).toContain('aes-256-only');
    expect(rules(`k({ name: 'AES-GCM', length: 256 })`)).toEqual([]);
  });

  it('allows the destructive-only purge APIs and ignores comments', () => {
    expect(rules('localStorage.clear(); sessionStorage?.clear();')).toEqual([]);
    expect(rules('// localStorage.setItem("x") and Math.random() are banned\n/* document.cookie */ const a = 1;')).toEqual([]);
    expect(rules('/**\n * eval(x)\n */\nconst ok = true;')).toEqual([]);
  });

  it('reports accurate line numbers and keeps positions when stripping comments', () => {
    const src = '/* a\n b */\nconst x = 1;\nlocalStorage.setItem("a", "b");\n';
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
    expect(checkSource(src, 'f.ts')[0]).toMatchObject({ file: 'f.ts', line: 4, rule: 'no-web-storage-rw' });
  });

  it('every real source file in packages/core/src is clean', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
      });
    const files = walk(join(__dirname, '..', 'src'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(checkFiles(files, process.cwd())).toEqual([]);
  });

  it('the shipped crypto module really uses getRandomValues for IVs and 600k iterations by default', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'crypto.ts'), 'utf8');
    expect(src).toMatch(/getRandomValues/);
    expect(src).toMatch(/DEFAULT_KDF_ITERATIONS\s*=\s*600_000/);
    expect(src).toMatch(/hash:\s*'SHA-256'/);
  });
});
