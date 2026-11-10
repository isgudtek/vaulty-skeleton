#!/usr/bin/env node
/**
 * External-consumer verification for @vaulty/core.
 *
 *   npm run verify:pack                 # pack → install into a standalone Vite + React 19 project → typecheck → build → real Chrome
 *   npm run verify:pack -- --react18    # …also the same project on React 18
 *   npm run verify:pack -- --next       # …also a Next.js App Router project (SSR prerender + "use client" + real Chrome)
 *   npm run verify:pack -- --all
 *
 * Everything happens in the OS temp directory, OUTSIDE this monorepo, so no workspace symlink or hoisted
 * dependency can make it pass by accident. Needs network access (npm install). Chrome is optional
 * (CHROME_PATH to override); without it the browser step is skipped and reported as such.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(tmpdir(), 'vaulty-verify-pack');
const args = new Set(process.argv.slice(2));
const wantReact18 = args.has('--react18') || args.has('--all');
const wantNext = args.has('--next') || args.has('--all');

const VERSIONS = {
  react19: { react: '19.3.1', 'react-dom': '19.3.1', '@types/react': '19.3.0', '@types/react-dom': '19.3.0' },
  react18: { react: '18.3.1', 'react-dom': '18.3.1', '@types/react': '18.3.31', '@types/react-dom': '18.3.7' },
  tooling: { vite: '8.3.7', '@vitejs/plugin-react': '6.3.0', typescript: '5.9.3' },
  next: '16.4.6',
};

const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

let passed = 0;
let failed = 0;
const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label });
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}
const run = (cmd, argv, cwd, env = {}) =>
  execFileSync(cmd, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
function tryRun(label, cmd, argv, cwd, env) {
  try {
    run(cmd, argv, cwd, env);
    check(true, label);
    return true;
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n      ');
    check(false, label, `\n      ${out}`);
    return false;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 1. Pack                                                                                     */
/* ------------------------------------------------------------------------------------------ */

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
console.log(`Packing @vaulty/core (prepare → build) into ${WORK}`);
// `npm pack` runs `prepare` (the tsup build) first, and the build log shares stdout with the JSON report — take the JSON block.
const packOut = run('npm', ['pack', '--workspace', '@vaulty/core', '--pack-destination', WORK, '--json'], REPO);
const jsonStart = packOut.search(/^\[\s*\{/m);
check(/Build success/.test(packOut.slice(0, Math.max(jsonStart, 0))), '`npm pack` ran `prepare` → tsup build');
const packJson = JSON.parse(packOut.slice(jsonStart));
const pack = Array.isArray(packJson) ? packJson[0] : packJson;
const TARBALL = join(WORK, pack.filename);
const files = pack.files.map((f) => f.path);
check(existsSync(TARBALL), `tarball created: ${pack.filename}`, `${(pack.size / 1024).toFixed(1)} kB packed, ${files.length} files`);
for (const f of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/react.js', 'dist/react.cjs', 'dist/react.d.ts']) {
  check(files.includes(f), `tarball contains ${f}`);
}
const leaked = files.filter((f) => /^(src|tests|scripts)\/|^tsup\.config|^vitest\.config|^tsconfig|node_modules/.test(f));
check(leaked.length === 0, 'tarball contains no source, tests, scripts or configs', leaked.join(', '));

/* ------------------------------------------------------------------------------------------ */
/* 2. Standalone Vite + React projects                                                         */
/* ------------------------------------------------------------------------------------------ */

const APP_TSX = `import { useState } from 'react';
import { useVaultDialog } from '@vaulty/core/react';

export function App() {
  const [text, setText] = useState('# hello');
  // ---- the 6-line integration, verbatim from the README ----
  const { saveEncrypted, openEncrypted, VaultModal } = useVaultDialog();
  return (
    <>
      <textarea aria-label="note" value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={() => saveEncrypted('note.md', text)}>Save encrypted</button>
      <button onClick={() => openEncrypted((file) => setText(file.text()))}>Open encrypted</button>
      <VaultModal />
    </>
  );
}
`;

function writeViteProject(dir, reactVersions) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'external-vaulty-consumer',
        private: true,
        type: 'module',
        dependencies: { '@vaulty/core': `file:${TARBALL}`, react: reactVersions.react, 'react-dom': reactVersions['react-dom'] },
        devDependencies: {
          ...VERSIONS.tooling,
          '@types/react': reactVersions['@types/react'],
          '@types/react-dom': reactVersions['@types/react-dom'],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ['src'],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'vite.config.mjs'), "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()], logLevel: 'error' };\n");
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>external</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n');
  writeFileSync(join(dir, 'src', 'App.tsx'), APP_TSX);
  writeFileSync(
    join(dir, 'src', 'main.tsx'),
    "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App';\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n",
  );
  writeFileSync(
    join(dir, 'node-check.mjs'),
    `import * as esm from '@vaulty/core';
import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('@vaulty/core');
const v = new esm.VaultClient({ adapter: new esm.MemoryStorageAdapter(), kdfIterations: 1000 });
const r = await v.unlock([0, 1, 2, 3, 4, 9]);
await v.putRecord({ ok: true }, { name: 'x' });
if (r.status !== 'unlocked' || v.listEntries().length !== 1 || typeof cjs.VaultClient !== 'function') process.exit(1);
console.log('ok');
`,
  );
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.txt': 'text/plain', '.json': 'application/json' };
function serveStatic(dir) {
  return new Promise((res) => {
    const srv = createServer((req, reply) => {
      const u = new URL(req.url, 'http://x');
      let p = normalize(join(dir, decodeURIComponent(u.pathname)));
      if (!p.startsWith(dir)) return reply.writeHead(403).end();
      if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
      if (!existsSync(p) && existsSync(`${p}.html`)) p = `${p}.html`;
      if (!existsSync(p)) return reply.writeHead(404).end();
      reply.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, origin: `http://localhost:${srv.address().port}` }));
  });
}

/** Drive the 6-line app in real Chrome: save → recovery → ciphertext in OPFS → open; focus trap; portal. */
async function browserCheck(label, dir, opts = {}) {
  if (!CHROME) {
    console.log(`  – ${label}: Chrome not found, browser step skipped (set CHROME_PATH)`);
    return;
  }
  const { default: puppeteer } = await import('puppeteer-core'); // resolved from this repo's devDependencies
  const { srv, origin } = await serveStatic(dir);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The browser's automatic /favicon.ico request 404s on these bare test servers; anything else is a real problem.
      if (/favicon\.ico$/.test(m.location()?.url ?? '')) return;
      problems.push(`${m.text()} (${m.location()?.url ?? 'unknown source'})`);
    });
    page.on('response', (r) => r.status() >= 400 && !r.url().endsWith('/favicon.ico') && problems.push(`${r.status()} ${r.url()}`));
    await page.goto(`${origin}/`, { waitUntil: 'networkidle0' });
    if (opts.serverText) {
      const html = await page.evaluate(() => document.body.innerText);
      check(html.includes(opts.serverText), `${label}: server-rendered content present`, opts.serverText);
      const nodes = await page.$$eval('[data-testid="server-grid"] [data-node]', (n) => n.length);
      check(nodes === 25, `${label}: <PatternGrid /> rendered from a Server Component (thanks to "use client")`, `${nodes} nodes`);
    }
    const click = async (t) => (await page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t), t)).asElement().click();
    const draw = async (nodes) => {
      await page.waitForSelector('[role="dialog"] svg[role="application"]');
      const r = await page.$eval('[role="dialog"] svg[role="application"]', (e) => {
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
      const at = (n) => ({ x: r.x + ((10 + (n % 5) * 20) / 100) * r.w, y: r.y + ((10 + Math.floor(n / 5) * 20) / 100) * r.h });
      await page.mouse.move(at(nodes[0]).x, at(nodes[0]).y);
      await page.mouse.down();
      for (const n of nodes.slice(1)) await page.mouse.move(at(n).x, at(n).y, { steps: 5 });
      await page.mouse.up();
    };
    await page.$eval('textarea', (t) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '# external EXTERNAL-MARKER-99');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Save encrypted');
    await page.waitForSelector('[role="dialog"]');
    const portal = await page.evaluate(() => document.querySelector('[data-vaulty-modal]').parentElement === document.body);
    check(portal, `${label}: modal is portalled into <body>`);
    const onGrid = await page.evaluate(() => document.activeElement?.getAttribute('role') === 'application');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const trapped = await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement));
    check(onGrid && trapped, `${label}: focus starts on the grid and real Tab presses stay inside the dialog`);
    await draw([0, 1, 2, 3, 4, 9]);
    await page.waitForSelector('[data-testid="vault-modal-recovery-words"]', { timeout: 20000 });
    await click('I have written this down');
    await page.waitForSelector('[role="dialog"]', { hidden: true, timeout: 10000 });
    const scan = await page.evaluate(async () => {
      const enc = new TextEncoder().encode('EXTERNAL-MARKER-99');
      let leak = false;
      let count = 0;
      async function walk(d) {
        for await (const [, h] of d.entries()) {
          if (h.kind === 'directory') await walk(h);
          else {
            count++;
            const b = new Uint8Array(await (await h.getFile()).arrayBuffer());
            outer: for (let i = 0; i + enc.length <= b.length; i++) {
              for (let j = 0; j < enc.length; j++) if (b[i + j] !== enc[j]) continue outer;
              leak = true;
            }
          }
        }
      }
      await walk(await navigator.storage.getDirectory());
      return { leak, count };
    });
    check(scan.count >= 3 && !scan.leak, `${label}: saveEncrypted → recovery phrase → encrypted in OPFS`, `${scan.count} files, plaintext found: ${scan.leak}`);
    await page.$eval('textarea', (t) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'overwritten');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Open encrypted');
    await page.waitForSelector('button[aria-label="Open note.md"]', { timeout: 10000 });
    await page.click('button[aria-label="Open note.md"]');
    await page.waitForFunction(() => document.querySelector('textarea').value.includes('EXTERNAL-MARKER-99'), { timeout: 10000 });
    check(true, `${label}: openEncrypted → file browser → decrypted back into the app`);
    check(problems.length === 0, `${label}: no page errors or failed requests`, problems.join(' | '));
  } catch (e) {
    check(false, `${label}: browser flow`, e.message.split('\n')[0]);
  } finally {
    await browser.close();
    srv.close();
  }
}

async function viteVariant(name, reactVersions) {
  console.log(`\nStandalone Vite + React ${reactVersions.react} project (outside the monorepo)`);
  const dir = join(WORK, `vite-${name}`);
  writeViteProject(dir, reactVersions);
  if (!tryRun('npm install (tarball + React + Vite)', 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir)) return;
  const installed = join(dir, 'node_modules', '@vaulty', 'core');
  check(!lstatSync(installed).isSymbolicLink() && !existsSync(join(installed, 'tests')), 'installed as a real package copy (not a workspace symlink)');
  check(readFileSync(join(installed, 'dist', 'react.js'), 'utf8').startsWith('"use client";'), 'installed dist/react.js starts with "use client"');
  check(!existsSync(join(installed, 'src')), 'installed package ships no source folder');
  tryRun('strict TypeScript typecheck against the packed .d.ts (skipLibCheck: false)', 'npx', ['tsc', '-p', 'tsconfig.json'], dir);
  tryRun('Node: ESM import + CJS require of @vaulty/core, real unlock + record', 'node', ['node-check.mjs'], dir);
  if (!tryRun('vite build of the 6-line app', 'npx', ['vite', 'build'], dir)) return;
  await browserCheck(`React ${reactVersions.react}`, join(dir, 'dist'));
}

/* ------------------------------------------------------------------------------------------ */
/* 3. Next.js App Router project                                                               */
/* ------------------------------------------------------------------------------------------ */

async function nextVariant() {
  console.log(`\nStandalone Next.js ${VERSIONS.next} App Router project (SSR prerender, static export)`);
  const dir = join(WORK, 'next');
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'external-vaulty-next',
        private: true,
        scripts: { build: 'next build' },
        dependencies: { next: VERSIONS.next, '@vaulty/core': `file:${TARBALL}`, react: VERSIONS.react19.react, 'react-dom': VERSIONS.react19['react-dom'] },
        devDependencies: {
          typescript: VERSIONS.tooling.typescript,
          '@types/react': VERSIONS.react19['@types/react'],
          '@types/react-dom': VERSIONS.react19['@types/react-dom'],
          '@types/node': '22.20.5',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'next.config.mjs'), "export default { output: 'export' };\n");
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'], strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler',
        jsx: 'preserve', esModuleInterop: true, isolatedModules: true, resolveJsonModule: true, skipLibCheck: true, incremental: false,
        plugins: [{ name: 'next' }], allowJs: false,
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    }),
  );
  writeFileSync(join(dir, 'app', 'layout.tsx'), "export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang=\"en\"><body>{children}</body></html>;\n}\n");
  // A SERVER component: imports the server-safe core entry and renders a client component straight from @vaulty/core/react.
  writeFileSync(
    join(dir, 'app', 'page.tsx'),
    `import { RECOVERY_WORD_COUNT } from '@vaulty/core';
import { PatternGrid } from '@vaulty/core/react';
import { Editor } from './editor';

export default function Page() {
  return (
    <main>
      <p>Server rendered: recovery phrases have {RECOVERY_WORD_COUNT} words.</p>
      <div data-testid="server-grid"><PatternGrid size={120} /></div>
      <Editor />
    </main>
  );
}
`,
  );
  writeFileSync(join(dir, 'app', 'editor.tsx'), `'use client';\n${APP_TSX.replace('export function App', 'export function Editor')}`);
  if (!tryRun('npm install (tarball + Next.js)', 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir)) return;
  if (!tryRun('next build (type-checks, SSR-prerenders the page, static export)', 'npx', ['next', 'build'], dir, { NEXT_TELEMETRY_DISABLED: '1' })) return;
  const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
  check(html.includes('recovery phrases have <!-- -->9<!-- --> words') || html.includes('recovery phrases have 9 words'), 'prerendered HTML contains server output from @vaulty/core');
  check((html.match(/data-node=/g) ?? []).length === 25, 'prerendered HTML contains the <PatternGrid /> from the Server Component');
  await browserCheck('Next.js', join(dir, 'out'), { serverText: 'recovery phrases have 9 words' });
}

/* ------------------------------------------------------------------------------------------ */

await viteVariant('react19', VERSIONS.react19);
if (wantReact18) await viteVariant('react18', VERSIONS.react18);
if (wantNext) await nextVariant();

console.log(`\n${passed}/${passed + failed} external-consumer checks passed${CHROME ? '' : ' (browser steps skipped)'}`);
console.log(`Workspace kept for inspection: ${WORK}`);
process.exit(failed ? 1 : 0);
