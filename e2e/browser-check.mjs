/**
 * Real-browser end-to-end verification of the Vaulty showcase apps (GhostDrop + CryptKeep + InkVault).
 *
 *   npm run e2e                      # builds everything, then drives real Chrome
 *   CHROME_PATH=/path/to/chrome npm run e2e
 *   E2E_SHOTS=docs/screenshots npm run e2e   # keep screenshots somewhere specific
 *
 * It hosts the built `dist/` folders on ephemeral localhost ports (a secure context, so OPFS and Web Crypto
 * are available), uses real PBKDF2 (600,000 iterations), real OPFS, a fake microphone device, the real
 * clipboard and a real 15-second auto-clear wait. Requires Chrome/Chromium and `puppeteer-core`.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(tmpdir(), 'vaulty-e2e');
const SHOTS = resolve(process.env.E2E_SHOTS ?? join(WORK, 'shots'));
const DOWNLOADS = join(WORK, 'downloads');
mkdirSync(WORK, { recursive: true });
const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) throw new Error('Chrome/Chromium not found. Set CHROME_PATH.');
for (const app of ['ghostdrop', 'cryptkeep', 'inkvault']) {
  if (!existsSync(join(REPO, 'apps', app, 'dist', 'index.html'))) throw new Error(`apps/${app}/dist missing — run \`npm run build:all\` first`);
}
rmSync(SHOTS, { recursive: true, force: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function serve(dir, prefix = '') {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end('outside base path'); return; }
      let p = normalize(join(dir, decodeURIComponent(url.pathname.slice(prefix.length))));
      if (!p.startsWith(dir)) { res.writeHead(403).end(); return; }
      if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
      if (!existsSync(p)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, origin: `http://localhost:${srv.address().port}` }));
  });
}

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ ok: true, name });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)${note ? ' — ' + note : ''}`);
  } catch (e) {
    results.push({ ok: false, name, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitText(page, re, timeout = 15000) {
  await page.waitForFunction((src) => new RegExp(src, 'i').test(document.body.innerText), { timeout }, re.source);
}
async function clickButton(page, text) {
  const h = await page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t || b.getAttribute('aria-label') === t || (t instanceof RegExp)), text);
  const el = h.asElement();
  assert(el, `button not found: ${text}`);
  await el.click();
}
async function clickByLabel(page, label) {
  const el = await page.$(`button[aria-label="${label}"]`);
  assert(el, `button[aria-label] not found: ${label}`);
  await el.click();
}
async function drawPattern(page, nodes, scopeSelector = '') {
  const sel = scopeSelector.includes('data-e2e') ? scopeSelector : `${scopeSelector} svg[role="application"]`.trim();
  await page.waitForSelector(sel);
  await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }));
  const rect = await page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const at = (n) => ({ x: rect.x + ((10 + (n % 5) * 20) / 100) * rect.w, y: rect.y + ((10 + Math.floor(n / 5) * 20) / 100) * rect.h });
  const first = at(nodes[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const n of nodes.slice(1)) { const p = at(n); await page.mouse.move(p.x, p.y, { steps: 6 }); }
  await page.mouse.up();
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

async function opfsDump(page, marker) {
  return page.evaluate(async (needle) => {
    const out = { files: [], leak: false };
    const enc = new TextEncoder().encode(needle);
    const has = (buf) => { outer: for (let i = 0; i + enc.length <= buf.length; i++) { for (let j = 0; j < enc.length; j++) if (buf[i + j] !== enc[j]) continue outer; return true; } return false; };
    async function walk(dir, prefix) {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') await walk(h, prefix + name + '/');
        else { const f = await h.getFile(); const buf = new Uint8Array(await f.arrayBuffer()); out.files.push({ path: prefix + name, size: f.size }); if (needle && has(buf)) out.leak = true; }
      }
    }
    await walk(await navigator.storage.getDirectory(), '');
    return out;
  }, marker ?? '');
}

const consoleProblems = [];
function watch(page, label) {
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleProblems.push(`[${label}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleProblems.push(`[${label}] pageerror: ${e.message}`));
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

const ghost = await serve(join(REPO, 'apps/ghostdrop/dist'));
const crypt = await serve(join(REPO, 'apps/cryptkeep/dist'));
console.log(`GhostDrop → ${ghost.origin}\nCryptKeep → ${crypt.origin}\n`);

const PATTERN_A = [0, 1, 2, 3, 4, 9];
const PATTERN_B = [24, 23, 22, 21, 20, 15];
const DURESS = [10, 11, 12, 13, 14, 19];
const NEW_PATTERN = [20, 21, 22, 23, 24, 19];

/* ============================== GHOSTDROP ============================== */
console.log('GhostDrop (real Chrome, real OPFS, 600,000-iteration PBKDF2)');
{
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  watch(page, 'ghostdrop');
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, browserContextId: ctx.id });
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(ghost.origin, { waitUntil: 'networkidle0' });

  await step('lock screen renders, CSP meta present, manifest valid', async () => {
    await page.waitForSelector('svg[role="application"]');
    const csp = await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content);
    assert(/default-src 'self'/.test(csp) && !/unsafe-eval/.test(csp), 'CSP missing/weak');
    const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
    assert(manifest.display === 'standalone' && manifest.icons.length === 2, 'manifest');
    await shot(page, 'ghostdrop-1-lock');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await shot(page, 'ghostdrop-1b-lock-mobile');
    await page.setViewport({ width: 1280, height: 860 });
  });

  await step('service worker registers and caches the offline shell', async () => {
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()), { timeout: 10000 });
    await page.waitForFunction(async () => (await caches.keys()).includes('ghostdrop-shell-v1'), { timeout: 10000 });
  });

  let phrase;
  await step('pattern A silently creates a vault; one-time 9-word phrase; badge shown', async () => {
    const t0 = Date.now();
    await drawPattern(page, PATTERN_A);
    await page.waitForSelector('[role="dialog"] [data-testid="recovery-words"]', { timeout: 15000 });
    const unlockMs = Date.now() - t0;
    phrase = await page.$$eval('[data-testid="recovery-words"] li', (lis) => lis.map((l) => l.textContent.replace(/^\d+/, '')));
    assert(phrase.length === 9, 'expected 9 words');
    await shot(page, 'ghostdrop-2-recovery');
    await clickButton(page, 'I have written this down');
    await page.waitForSelector('[data-testid="ns-fingerprint"]');
    const fp = await page.$eval('[data-testid="ns-fingerprint"]', (e) => e.textContent);
    assert(/^[0-9A-F]{4}·[0-9A-F]{4}$/.test(fp), 'fingerprint ' + fp);
    return `vault ${fp}, create+unlock ≈ ${unlockMs}ms`;
  });

  const MARKER = 'TOP-SECRET-FIELD-NOTE-8841';
  await step('drag-and-drop style upload encrypts into OPFS (no plaintext on disk)', async () => {
    const txt = join(WORK, 'note.txt');
    writeFileSync(txt, `payload ${MARKER}`);
    const input = await page.$('[data-testid="file-input"]');
    await input.uploadFile(txt, join(REPO, 'apps/ghostdrop/public/icons/icon-192.png'));
    await waitText(page, /2 files sealed/);
    await shot(page, 'ghostdrop-3-vault');
    const dump = await opfsDump(page, MARKER);
    assert(!dump.leak, 'PLAINTEXT FOUND IN OPFS');
    const names = dump.files.map((f) => f.path);
    assert(names.some((n) => /^ghostdrop\/[0-9a-f]{64}\/keys\.bin$/.test(n)), 'no keys.bin: ' + names);
    assert(names.some((n) => /\/index\.enc$/.test(n)), 'no index.enc');
    assert(names.filter((n) => /[0-9a-f-]{36}$/.test(n)).length === 2, 'expected 2 UUID blobs: ' + names);
    assert(!(await page.evaluate(() => localStorage.length + sessionStorage.length)), 'web storage used');
    return `${dump.files.length} OPFS files, 0 plaintext matches`;
  });

  await step('encrypted voice note: real MediaRecorder → memory → vault', async () => {
    await clickButton(page, '● Record');
    await page.waitForFunction(() => /■ Stop/i.test(document.body.innerText), { timeout: 8000 });
    await sleep(1500);
    await clickButton(page, '■ Stop & seal');
    await waitText(page, /Voice note sealed/, 15000);
    const names = await page.$$eval('[data-testid="evidence-list"] li p.truncate', (ps) => ps.map((p) => p.textContent));
    assert(names.some((n) => /^voice-note-\d{8}-\d{4}\.webm$/.test(n)), 'voice note not listed: ' + names);
    await shot(page, 'ghostdrop-4-voice');
    return names.find((n) => n.startsWith('voice-note'));
  });

  await step('zero-leak previewer: image decodes from blob: URL, URL revoked and vault locked on close', async () => {
    await clickByLabel(page, 'Preview icon-192.png');
    await page.waitForSelector('[role="dialog"] img[src^="blob:"]', { timeout: 10000 });
    const w = await page.$eval('[role="dialog"] img', (img) => new Promise((r) => (img.complete ? r(img.naturalWidth) : (img.onload = () => r(img.naturalWidth)))));
    assert(w === 192, 'image did not decode, width=' + w);
    const url = await page.$eval('[role="dialog"] img', (i) => i.src);
    await shot(page, 'ghostdrop-5-preview');
    await clickButton(page, 'Close & lock');
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { hidden: true, timeout: 5000 });
    const stillLoads = await page.evaluate((u) => new Promise((res) => { const i = new Image(); i.onload = () => res(true); i.onerror = () => res(false); i.src = u; }), url);
    assert(stillLoads === false, 'blob URL still loads after close (not revoked)');
  });

  await step('voice note plays back after decrypt (audio element gets a blob: URL)', async () => {
    await drawPattern(page, PATTERN_A);
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { timeout: 15000 });
    const label = await page.$$eval('button[aria-label^="Preview voice-note"]', (b) => b[0]?.getAttribute('aria-label'));
    assert(label, 'no voice note preview button');
    await clickByLabel(page, label);
    await page.waitForSelector('[role="dialog"] audio[src^="blob:"]', { timeout: 10000 });
    await clickButton(page, 'Close & lock');
  });

  await step('pattern B opens a separate empty vault with no errors; A is intact', async () => {
    await drawPattern(page, PATTERN_B);
    await page.waitForSelector('[role="dialog"] [data-testid="recovery-words"]', { timeout: 15000 });
    await clickButton(page, 'I have written this down');
    await page.waitForSelector('[data-testid="ns-fingerprint"]');
    const fpB = await page.$eval('[data-testid="ns-fingerprint"]', (e) => e.textContent);
    const body = await page.evaluate(() => document.body.innerText);
    assert(/Vault is empty/i.test(body) && !/incorrect|wrong|invalid/i.test(body), 'B not empty / error shown');
    await clickButton(page, 'Quick lock the vault now');
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { hidden: true });
    await drawPattern(page, PATTERN_A);
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { timeout: 15000 });
    const fpA = await page.$eval('[data-testid="ns-fingerprint"]', (e) => e.textContent);
    assert(fpA !== fpB, 'same fingerprint');
    await waitText(page, /icon-192\.png/);
    return `A=${fpA} B=${fpB}`;
  });

  await step('export .vault downloads a ciphertext-only VLT1 bundle', async () => {
    await clickButton(page, 'Export .vault');
    await waitText(page, /Exported ghostdrop-/);
    await sleep(800);
    const f = readdirSync(DOWNLOADS).find((n) => n.endsWith('.vault'));
    assert(f, 'no downloaded .vault file');
    const bytes = readFileSync(join(DOWNLOADS, f));
    assert(bytes.subarray(0, 4).toString() === 'VLT1', 'bad magic');
    assert(!bytes.includes(Buffer.from(MARKER)) && !bytes.includes(Buffer.from('note.txt')), 'plaintext in archive');
    return `${f} (${bytes.length} bytes)`;
  });

  await step('arm duress pattern, then entering it destroys OPFS + caches + IndexedDB', async () => {
    await page.waitForFunction(() => /Duress pattern/i.test(document.body.innerText));
    await page.evaluate(() => {
      const s = [...document.querySelectorAll('section')].find((x) => /Duress pattern/i.test(x.textContent) && x.querySelector('svg[role="application"]'));
      s.querySelector('svg[role="application"]').setAttribute('data-e2e', 'duress-grid');
    });
    await drawPattern(page, DURESS, '[data-e2e="duress-grid"]');
    await sleep(300);
    await drawPattern(page, DURESS, '[data-e2e="duress-grid"]');
    await waitText(page, /Duress pattern armed/, 20000);
    await shot(page, 'ghostdrop-6-duress-armed');
    const before = await opfsDump(page);
    const namespaces = new Set(before.files.map((f) => f.path.split('/')[1]));
    assert(namespaces.size === 3, 'expected A + decoy B + duress namespaces, got ' + namespaces.size);

    await clickButton(page, 'Quick lock the vault now');
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { hidden: true });
    await page.evaluate(() => { localStorage.setItem('sentinel', '1'); });
    await drawPattern(page, DURESS);
    await sleep(2500);
    const after = await opfsDump(page);
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).length);
    const caches_ = await page.evaluate(async () => (await caches.keys()).length);
    const ls = await page.evaluate(() => localStorage.length);
    const onLock = await page.$('svg[role="application"]');
    await shot(page, 'ghostdrop-7-after-duress');
    assert(after.files.length === 0, `OPFS not empty: ${after.files.map((f) => f.path)}`);
    assert(dbs === 0, 'IndexedDB databases left: ' + dbs);
    assert(caches_ === 0, 'Cache API entries left');
    assert(ls === 0, 'localStorage not cleared');
    assert(onLock, 'did not return to a clean lock screen');
    const body = await page.evaluate(() => document.body.innerText);
    assert(!/duress|wipe|destroy/i.test(body), 'lock screen leaks duress wording');
    return 'OPFS=0 files, IndexedDB=0, Cache API=0, localStorage=0, clean lock screen';
  });

  await ctx.close();
}

/* ============================== CRYPTKEEP ============================== */
console.log('\nCryptKeep (real Chrome, real clipboard, live 15s auto-clear)');
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const refTotp = (t) => {
  const key = Buffer.from('12345678901234567890');
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const mac = createHmac('sha1', key).update(msg).digest();
  const o = mac[19] & 0xf;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1e6).padStart(6, '0');
};

let snapshotPath;
let recoveryPhrase;
{
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(crypt.origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await ctx.newPage();
  watch(page, 'cryptkeep');
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, browserContextId: ctx.id });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(crypt.origin, { waitUntil: 'networkidle0' });

  await step('lock screen: hardware-style keypad, keyboard hints, recover button', async () => {
    await page.waitForSelector('svg[role="application"]');
    const kbds = await page.$$eval('kbd', (k) => k.map((x) => x.textContent));
    assert(kbds.length === 5, 'kbd hints ' + kbds);
    assert(await page.evaluate(() => /Recover Vault with 9-Word Phrase/i.test(document.body.innerText)), 'no recover button');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(bg === 'rgb(248, 250, 252)', 'paper background ' + bg);
    await shot(page, 'cryptkeep-1-lock');
  });

  await step('keyboard-only unlock works (arrows, Space, Enter)', async () => {
    await page.$eval('svg[role="application"]', (el) => el.focus());
    // centre node 12 → select, then walk: right(13) select, right(14) select, down(19) select, left(18) select, left(17) select
    const seq = [' ', 'ArrowRight', ' ', 'ArrowRight', ' ', 'ArrowDown', ' ', 'ArrowLeft', ' ', 'ArrowLeft', ' ', 'Enter'];
    for (const k of seq) await page.keyboard.press(k === ' ' ? 'Space' : k);
    await page.waitForSelector('[role="dialog"] [data-testid="recovery-words"]', { timeout: 15000 });
    recoveryPhrase = await page.$$eval('[data-testid="recovery-words"] li', (lis) => lis.map((l) => l.textContent.replace(/^\d+/, '')).join(' '));
    await clickButton(page, 'I have written this down');
    await page.waitForSelector('[data-testid="ns-fingerprint"]');
  });

  await step('seed phrase: masked by default, per-word reveal, encrypted at rest', async () => {
    await page.type('form[aria-label="Add seed phrase"] input:not([type])', 'Cold wallet #1');
    await page.type('[data-testid="seed-words-input"]', SEED);
    await clickButton(page, 'Seal seed phrase');
    await page.waitForSelector('[data-testid="seed-card"]', { timeout: 10000 });
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/abandon|about/.test(text.replace('Cold wallet', '')), 'seed words visible while masked');
    await (await page.$('[data-testid="seed-word-12"]')).click();
    assert((await page.$eval('[data-testid="seed-word-12"]', (e) => e.textContent)) === 'about', 'reveal failed');
    assert((await page.$eval('[data-testid="seed-word-1"]', (e) => e.textContent)) === '•••••', 'other word revealed');
    await shot(page, 'cryptkeep-2-seed');
    const dump = await opfsDump(page, 'abandon');
    assert(!dump.leak, 'PLAINTEXT SEED FOUND IN OPFS');
  });

  await step('clipboard: copy puts the phrase on the real clipboard, then it is wiped after 15s', async () => {
    await clickByLabel(page, 'Copy seed phrase for Cold wallet #1');
    await page.waitForSelector('[data-testid="clipboard-banner"]');
    const t0 = Date.now();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied === SEED, 'clipboard content mismatch');
    await shot(page, 'cryptkeep-3-clipboard');
    await page.waitForSelector('[data-testid="clipboard-banner"]', { hidden: true, timeout: 20000 });
    const elapsed = Date.now() - t0;
    const after = await page.evaluate(() => navigator.clipboard.readText());
    assert(after === '', 'clipboard not cleared: ' + JSON.stringify(after));
    assert(elapsed >= 13500 && elapsed <= 17500, 'cleared at unexpected time ' + elapsed);
    return `cleared after ${(elapsed / 1000).toFixed(1)}s`;
  });

  await step('TOTP: live RFC 6238 code matches an independent HMAC-SHA1 implementation', async () => {
    await clickButton(page, 'Authenticator');
    await page.type('[data-testid="totp-source"]', RFC_SECRET);
    const inputs = await page.$$('form[aria-label="Add authenticator"] input');
    await inputs[1].type('ACME');
    await inputs[2].type('me@example.com');
    await clickButton(page, 'Add authenticator');
    await page.waitForSelector('[data-testid="totp-card"]', { timeout: 10000 });
    await page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.querySelector('[data-testid="totp-code"]')?.textContent ?? ''), { timeout: 5000 });
    const shown = await page.$eval('[data-testid="totp-code"]', (e) => e.textContent.replace(' ', ''));
    const now = Date.now();
    const ok = [refTotp(now), refTotp(now - 1000), refTotp(now - 30000)].includes(shown);
    assert(ok, `code ${shown} does not match reference ${refTotp(now)}`);
    const remaining = Number(await page.$eval('[data-testid="totp-remaining"]', (e) => e.textContent));
    assert(remaining >= 1 && remaining <= 30, 'countdown ' + remaining);
    await shot(page, 'cryptkeep-4-totp');
    // The ring really counts down.
    await sleep(2200);
    const later = Number(await page.$eval('[data-testid="totp-remaining"]', (e) => e.textContent));
    assert(later !== remaining, 'countdown did not move');
    return `code ${shown}, ring ${remaining}s → ${later}s`;
  });

  await step('export encrypted snapshot (.vault)', async () => {
    await clickButton(page, 'Snapshot');
    await clickButton(page, 'Export snapshot');
    await waitText(page, /Exported cryptkeep-/);
    await sleep(800);
    const f = readdirSync(DOWNLOADS).find((n) => n.startsWith('cryptkeep-') && n.endsWith('.vault'));
    assert(f, 'no snapshot downloaded');
    snapshotPath = join(DOWNLOADS, f);
    const bytes = readFileSync(snapshotPath);
    assert(bytes.subarray(0, 4).toString() === 'VLT1', 'bad magic');
    for (const s of ['abandon', 'Cold wallet', RFC_SECRET, 'ACME']) assert(!bytes.includes(Buffer.from(s)), 'plaintext in snapshot: ' + s);
    await shot(page, 'cryptkeep-5-snapshot');
    return `${f} (${bytes.length} bytes)`;
  });
  await ctx.close();
}

{
  console.log('\nCryptKeep recovery on a clean device (fresh browser profile)');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  watch(page, 'cryptkeep-recover');
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(crypt.origin, { waitUntil: 'networkidle0' });

  await step('wrong 9-word phrase is rejected with no vault imported', async () => {
    await clickButton(page, 'Recover Vault with 9-Word Phrase');
    await page.waitForSelector('[role="dialog"]');
    await (await page.$('[data-testid="restore-file"]')).uploadFile(snapshotPath);
    await page.type('[data-testid="restore-phrase"]', 'abandon abandon abandon abandon abandon abandon abandon abandon zoo');
    await drawPattern(page, NEW_PATTERN, '[role="dialog"]');
    await sleep(300);
    await drawPattern(page, NEW_PATTERN, '[role="dialog"]');
    await waitText(page, /Unable to open archive/, 20000);
    assert((await opfsDump(page)).files.length === 0, 'wrong phrase wrote data');
    await shot(page, 'cryptkeep-6-recover-wrong');
  });

  await step('correct phrase recovers seeds + 2FA and sets a new pattern', async () => {
    await page.$eval('[data-testid="restore-phrase"]', (t) => { t.value = ''; });
    await page.focus('[data-testid="restore-phrase"]');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('[data-testid="restore-phrase"]', recoveryPhrase);
    await drawPattern(page, NEW_PATTERN, '[role="dialog"]');
    await sleep(300);
    await drawPattern(page, NEW_PATTERN, '[role="dialog"]');
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { timeout: 30000 });
    await waitText(page, /Cold wallet #1/);
    await clickButton(page, 'Authenticator');
    await page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.querySelector('[data-testid="totp-code"]')?.textContent ?? ''), { timeout: 8000 });
    await shot(page, 'cryptkeep-7-recovered');
  });

  await step('new pattern re-opens the recovered vault after a lock', async () => {
    await clickButton(page, 'Lock the vault now');
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { hidden: true });
    await drawPattern(page, NEW_PATTERN);
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { timeout: 15000 });
    assert(!(await page.$('[role="dialog"]')), 'unexpected recovery dialog for an existing vault');
    await waitText(page, /Cold wallet #1/);
  });

  await step('hidden tab locks the vault immediately (visibilitychange)', async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForSelector('[data-testid="ns-fingerprint"]', { hidden: true, timeout: 5000 });
  });
  await ctx.close();
}


/* ============================== INKVAULT ============================== */
console.log('\nInkVault (real Chrome: normal mode → Save As Encrypted → lock → Open from Vault)');
{
  const ink = await serve(join(REPO, 'apps/inkvault/dist'));
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  watch(page, 'inkvault');
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, browserContextId: ctx.id });
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(ink.origin, { waitUntil: 'networkidle0' });

  const MARK = 'INK-SECRET-DRAFT-7731';
  const NOTE = `# Field plan\n\nMeet at **dawn**. ${MARK}\n\n- bring map\n- [x] charge phone`;
  const setEditor = (v) =>
    page.$eval('[data-testid="editor"]', (el, val) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
  const editorValue = () => page.$eval('[data-testid="editor"]', (el) => el.value);

  await step('opens straight into the editor: no lock screen, no pattern grid; CSP, manifest, service worker present', async () => {
    await page.waitForSelector('[data-testid="editor"]');
    assert(!(await page.$('svg[role="application"]')), 'a pattern grid is visible in normal mode');
    assert(!(await page.$('[role="dialog"]')), 'a dialog blocks normal mode');
    const buttons = await page.$$eval('nav button', (bs) => bs.map((b) => b.textContent.trim()));
    assert(JSON.stringify(buttons) === JSON.stringify(['New Note', 'Download .md (Plaintext)', 'Save to Encrypted Vault', 'Open from Vault']), 'toolbar: ' + buttons);
    const csp = await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content);
    assert(/default-src 'self'/.test(csp) && !/unsafe-eval/.test(csp) && /img-src 'self' data:/.test(csp), 'CSP: ' + csp);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.waitForFunction(async () => (await caches.keys()).includes('inkvault-shell-v1'), { timeout: 10000 });
    await shot(page, 'inkvault-1-empty');
    return `paper background ${bg}`;
  });

  await step('live Markdown preview; raw HTML, javascript: links and remote images are inert', async () => {
    await setEditor(`${NOTE}\n\n<img src=x onerror="window.__pwned=1">\n\n[bad](javascript:window.__pwned=2)\n\n![px](https://evil.example/p.png)`);
    await page.waitForFunction(() => document.querySelector('[data-testid="preview"] h1')?.textContent === 'Field plan', { timeout: 5000 });
    const r = await page.evaluate(() => ({
      imgs: document.querySelectorAll('[data-testid="preview"] img').length,
      links: document.querySelectorAll('[data-testid="preview"] a').length,
      pwned: window.__pwned,
      strong: document.querySelector('[data-testid="preview"] strong')?.textContent,
    }));
    assert(r.imgs === 0 && r.links === 0 && r.pwned === undefined, 'unsafe content became active: ' + JSON.stringify(r));
    assert(r.strong === 'dawn', 'bold not rendered');
    await setEditor(NOTE);
    await shot(page, 'inkvault-2-editing');
  });

  await step('Download .md writes the plaintext exactly as written (explicit, user-initiated)', async () => {
    const before = new Set(readdirSync(DOWNLOADS));
    await clickButton(page, 'Download .md (Plaintext)');
    await sleep(800);
    const f = readdirSync(DOWNLOADS).find((n) => !before.has(n) && n.endsWith('.md'));
    assert(f === 'Field plan.md', 'downloaded: ' + f);
    assert(readFileSync(join(DOWNLOADS, f), 'utf8') === NOTE, 'downloaded content differs');
  });

  await step('Save to Encrypted Vault → pattern modal → 6+ nodes → one-time phrase banner; only ciphertext reaches OPFS', async () => {
    await clickButton(page, 'Save to Encrypted Vault');
    await page.waitForSelector('[role="dialog"] svg[role="application"]');
    await shot(page, 'inkvault-3-unlock-modal');
    const t0 = Date.now();
    await drawPattern(page, PATTERN_A, '[role="dialog"]');
    await page.waitForSelector('[data-testid="recovery-banner"]', { timeout: 15000 });
    const ms = Date.now() - t0;
    const words = await page.$$eval('[data-testid="recovery-words"] li', (l) => l.length);
    assert(words === 9, 'phrase words ' + words);
    await waitText(page, /Saved .Field plan\.md./);
    assert(!(await page.$('[role="dialog"]')), 'modal still open after save');
    await page.waitForSelector('button[aria-label="Lock the vault and clear the editor"]');
    const dump = await opfsDump(page, MARK);
    assert(!dump.leak, 'PLAINTEXT FOUND IN OPFS');
    assert(dump.files.length === 3, 'expected keys.bin + index.enc + 1 note, got ' + dump.files.map((f) => f.path));
    assert(!(await page.evaluate(() => localStorage.length + sessionStorage.length)), 'web storage used');
    await shot(page, 'inkvault-4-saved');
    return `unlock+save ≈ ${ms}ms, 3 OPFS files, 0 plaintext matches`;
  });

  await step('Ctrl+S re-saves the same note without asking for the pattern again', async () => {
    await setEditor(NOTE + '\n\nSecond paragraph.');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => /✓ saved in vault/.test(document.body.innerText), { timeout: 8000 });
    assert(!(await page.$('[role="dialog"]')), 'unexpected prompt');
    assert((await opfsDump(page)).files.length === 3, 'a duplicate note was created');
  });

  await step('Lock Vault wipes keys and clears the editor, preview and recovery phrase', async () => {
    // Click and inspect in the SAME page task (no awaits in between): the preview must already be empty —
    // decrypted text may not linger even for one frame after the vault reports "locked".
    const instant = await page.evaluate(() => {
      document.querySelector('button[aria-label="Lock the vault and clear the editor"]').click();
      return new Promise((res) => requestAnimationFrame(() => res(document.querySelector('[data-testid="preview"]').innerText)));
    });
    assert(!instant.includes('Field plan'), 'decrypted note still in the preview on the first frame after lock');
    await page.waitForSelector('button[aria-label="Lock the vault and clear the editor"]', { hidden: true });
    assert((await editorValue()) === '', 'editor not cleared');
    const text = await page.evaluate(() => document.body.innerText);
    assert(!text.includes(MARK) && !text.includes('Field plan'), 'plaintext still on screen');
    assert(!(await page.$('[data-testid="recovery-banner"]')), 'recovery phrase still shown');
    assert(/Vault locked/i.test(text), 'no lock notice');
    assert((await opfsDump(page)).files.length === 3, 'vault data vanished');
    await shot(page, 'inkvault-5-locked');
  });

  await step('Open from Vault → pattern → encrypted notes list → decrypts the note back into the editor', async () => {
    await clickButton(page, 'Open from Vault');
    await page.waitForSelector('[role="dialog"] svg[role="application"]');
    await drawPattern(page, PATTERN_A, '[role="dialog"]');
    await page.waitForSelector('[data-testid="vault-notes"]', { timeout: 15000 });
    assert(!(await page.$('[data-testid="recovery-banner"]')), 'phrase shown again for an existing vault');
    await shot(page, 'inkvault-6-vault-list');
    await clickByLabel(page, 'Open Field plan.md');
    await page.waitForFunction((m) => document.querySelector('[data-testid="editor"]').value.includes(m), { timeout: 8000 }, MARK);
    assert((await editorValue()).includes('Second paragraph.'), 'latest saved edit not restored');
    await page.waitForFunction(() => document.querySelector('[data-testid="preview"] h1')?.textContent === 'Field plan');
  });

  await step('hidden tab locks the vault and clears the editor immediately', async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForSelector('button[aria-label="Lock the vault and clear the editor"]', { hidden: true, timeout: 5000 });
    assert((await editorValue()) === '', 'editor not cleared on hide');
    assert(!(await page.evaluate(() => document.body.innerText)).includes(MARK), 'plaintext visible after hide');
  });
  await ctx.close();
  ink.srv.close();

  // Sub-path hosting (e.g. GitHub Pages): VITE_BASE_PATH rewrites every asset URL.
  const SUB = '/vaulty-skeleton/inkvault/';
  const subDir = join(WORK, 'inkvault-subpath');
  rmSync(subDir, { recursive: true, force: true });
  execFileSync('npx', ['vite', 'build', '--outDir', subDir, '--emptyOutDir'], {
    cwd: join(REPO, 'apps/inkvault'),
    env: { ...process.env, VITE_BASE_PATH: SUB },
    stdio: 'ignore',
  });
  const sub = await serve(subDir, SUB.slice(0, -1));
  const ctx2 = await browser.createBrowserContext();
  const page2 = await ctx2.newPage();
  const failed = [];
  page2.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
  await step(`VITE_BASE_PATH=${SUB}: app loads and works from a sub-path with no 404s`, async () => {
    await page2.goto(sub.origin + SUB, { waitUntil: 'networkidle0' });
    await page2.waitForSelector('[data-testid="editor"]');
    const srcs = await page2.$$eval('script[src], link[rel="stylesheet"]', (els) => els.map((e) => e.getAttribute('src') ?? e.getAttribute('href')));
    assert(srcs.length >= 2 && srcs.every((u) => u.startsWith(SUB)), 'assets not under base: ' + srcs);
    assert(failed.length === 0, 'failed requests: ' + failed.join(', '));
    const bg = await page2.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(bg === 'rgb(250, 249, 246)', 'stylesheet not applied from sub-path: ' + bg);
  });
  await ctx2.close();
  sub.srv.close();
  rmSync(subDir, { recursive: true, force: true });
}

await browser.close();
ghost.srv.close();
crypt.srv.close();

console.log('\nConsole warnings/errors captured from the apps:');
// ERR_FILE_NOT_FOUND is expected: the previewer check loads a *revoked* blob: URL on purpose to prove revocation.
const filtered = consoleProblems.filter((p) => !/favicon|ERR_FILE_NOT_FOUND/i.test(p));
console.log(filtered.length ? filtered.map((p) => '  ' + p).join('\n') : '  none');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
