#!/usr/bin/env node
/**
 * Static Web Crypto hygiene / forbidden-storage check for @vaulty/core.
 *
 *   node scripts/check-security.mjs                 # scan every src/**\/*.ts
 *   node scripts/check-security.mjs src/crypto.ts   # scan specific files (used by the save hook)
 *
 * Exit code 0 = clean, 1 = violations (printed as `file:line  [rule]  message`).
 * Comments are stripped before matching, so documentation may mention forbidden APIs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Blank out comments but keep line/column positions stable. */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** @type {Array<{id: string, re: RegExp, message: string}>} */
const LINE_RULES = [
  {
    id: 'no-web-storage-rw',
    re: /\b(?:local|session)Storage\s*(?:\?\.|\.)\s*(?:setItem|getItem|removeItem|key|length)\b|\b(?:local|session)Storage\s*\[/,
    message: 'localStorage/sessionStorage may never be read or written (only .clear() inside the duress purge)',
  },
  { id: 'no-cookies', re: /\bdocument\s*\.\s*cookie\b/, message: 'cookies are forbidden' },
  { id: 'no-math-random', re: /\bMath\s*\.\s*random\s*\(/, message: 'Math.random is not cryptographically secure; use crypto.getRandomValues' },
  { id: 'no-weak-algorithms', re: /['"`](?:AES-CBC|AES-CTR|AES-ECB|SHA-1|SHA1|MD5|RC4|DES|3DES)['"`]/i, message: 'weak or unauthenticated algorithm' },
  { id: 'no-exportkey', re: /\.exportKey\s*\(/, message: 'never export key material from CryptoKey objects' },
  { id: 'no-extractable-keys', re: /\bextractable\s*:\s*true\b|importKey\s*\([^;]*?,\s*true\s*,\s*\[/, message: 'keys must be non-extractable' },
  { id: 'no-static-iv', re: /\biv\s*:\s*new\s+Uint8Array\s*\(\s*(?:12|IV_BYTES)\s*\)|\biv\s*=\s*new\s+Uint8Array\s*\(\s*(?:12|IV_BYTES)\s*\)/, message: 'IV must come from crypto.getRandomValues, never zero-filled' },
  { id: 'no-literal-iv', re: /\biv\s*:\s*(?:new\s+Uint8Array\s*\(\s*\[|utf8\s*\(|new\s+TextEncoder)/, message: 'IV must be freshly random, not a literal' },
  { id: 'no-console', re: /\bconsole\s*\.\s*\w+\s*\(/, message: 'console output can leak secrets' },
  { id: 'no-eval', re: /\beval\s*\(|\bnew\s+Function\s*\(/, message: 'dynamic code execution is forbidden' },
  { id: 'no-network', re: /\b(?:fetch|sendBeacon)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\b/, message: 'a zero-knowledge core must not perform network I/O' },
  { id: 'no-debugger', re: /\bdebugger\b/, message: 'debugger statement' },
];

/**
 * Whole-file rules (need cross-line context).
 * @type {Array<{id: string, check: (code: string) => Array<{index: number, message: string}>}>}
 */
const FILE_RULES = [
  {
    id: 'encrypt-needs-random-iv',
    check(code) {
      const out = [];
      const usesEncrypt = /\bsubtle\s*\.\s*encrypt\s*\(|\bgetSubtle\s*\(\s*\)\s*\.\s*encrypt\s*\(/.exec(code);
      if (usesEncrypt && !/\brandomBytes\s*\(\s*IV_BYTES\s*\)|\bgetRandomValues\s*\(/.test(code)) {
        out.push({ index: usesEncrypt.index, message: 'AES-GCM encrypt without a fresh crypto.getRandomValues IV in the same module' });
      }
      return out;
    },
  },
  {
    id: 'pbkdf2-must-use-sha256',
    check(code) {
      const out = [];
      const re = /name\s*:\s*['"]PBKDF2['"][^}]*\}/g;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        if (!/hash\s*:\s*['"]SHA-256['"]/.test(m[0])) {
          out.push({ index: m.index, message: 'PBKDF2 must specify hash: "SHA-256"' });
        }
      }
      return out;
    },
  },
  {
    id: 'aes-gcm-only',
    check(code) {
      const out = [];
      const re = /name\s*:\s*['"](AES-[A-Z]+)['"]/g;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        if (m[1] !== 'AES-GCM') out.push({ index: m.index, message: `only AES-GCM is allowed, found ${m[1]}` });
      }
      return out;
    },
  },
  {
    id: 'aes-256-only',
    check(code) {
      const out = [];
      const re = /name\s*:\s*['"]AES-GCM['"]\s*,\s*length\s*:\s*(\d+)/g;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        if (m[1] !== '256') out.push({ index: m.index, message: `AES key length must be 256, found ${m[1]}` });
      }
      return out;
    },
  },
];

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

/**
 * @param {string} source raw file text
 * @param {string} file   label used in reports
 * @returns {Array<{file: string, line: number, rule: string, message: string}>}
 */
export function checkSource(source, file = '<input>') {
  const code = stripComments(source);
  const violations = [];
  code.split('\n').forEach((text, i) => {
    for (const rule of LINE_RULES) {
      if (rule.re.test(text)) violations.push({ file, line: i + 1, rule: rule.id, message: rule.message });
    }
  });
  for (const rule of FILE_RULES) {
    for (const hit of rule.check(code)) {
      violations.push({ file, line: lineOf(code, hit.index), rule: rule.id, message: hit.message });
    }
  }
  return violations.sort((a, b) => a.line - b.line);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(?:ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Entry point shared by the CLI and tests. Returns all violations. */
export function checkFiles(files, cwd = process.cwd()) {
  const all = [];
  for (const f of files) {
    const abs = resolve(cwd, f);
    // The embedded wordlist is data, not code.
    if (/wordlist\.ts$/.test(abs)) continue;
    all.push(...checkSource(readFileSync(abs, 'utf8'), relative(cwd, abs)));
  }
  return all;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const files = args.length > 0 ? args : walk(join(pkgRoot, 'src'));
  const scoped = files.filter((f) => /(?:^|[\\/])src[\\/].*\.(?:ts|tsx)$/.test(f) || args.length === 0);
  const violations = checkFiles(scoped, args.length > 0 ? process.cwd() : process.cwd());
  if (violations.length === 0) {
    console.log(`✔ crypto/storage hygiene check passed (${scoped.length} file${scoped.length === 1 ? '' : 's'})`);
    process.exit(0);
  }
  for (const v of violations) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.message}`);
  console.error(`\n✖ ${violations.length} violation${violations.length === 1 ? '' : 's'} found`);
  process.exit(1);
}
