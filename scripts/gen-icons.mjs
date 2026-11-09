#!/usr/bin/env node
/**
 * Dependency-free PWA icon generator (pure Node: zlib + a tiny PNG encoder).
 * Draws a 5x5 pattern grid with a highlighted connected path — the Vaulty motif — in each app's palette.
 *
 *   node scripts/gen-icons.mjs        # writes apps/<app>/public/icons/icon-192.png and icon-512.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** @param {{bg:string, node:string, active:string, path:number[]}} theme */
function render(size, theme) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = hex(theme.bg);
  const node = hex(theme.node);
  const active = hex(theme.active);
  // Content lives inside the maskable safe zone (centre 62%).
  const span = size * 0.62;
  const origin = (size - span) / 2;
  const step = span / 4;
  const centre = (i) => [origin + (i % 5) * step, origin + Math.floor(i / 5) * step];
  const lineW = size * 0.028;
  const nodeR = size * 0.032;
  const activeR = size * 0.05;

  const blend = (i, color, a) => {
    for (let c = 0; c < 3; c++) buf[i + c] = Math.round((buf[i + c] ?? 0) * (1 - a) + (color[c] ?? 0) * a);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[i] = bg[0] ?? 0;
      buf[i + 1] = bg[1] ?? 0;
      buf[i + 2] = bg[2] ?? 0;
      buf[i + 3] = 255;

      for (let n = 0; n < theme.path.length - 1; n++) {
        const [ax, ay] = centre(theme.path[n]);
        const [bx, by] = centre(theme.path[n + 1]);
        const d = segDist(x + 0.5, y + 0.5, ax, ay, bx, by);
        blend(i, active, 1 - smooth(lineW / 2 - 1, lineW / 2 + 1, d));
      }
      for (let n = 0; n < 25; n++) {
        const [cx, cy] = centre(n);
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const on = theme.path.includes(n);
        const r = on ? activeR : nodeR;
        blend(i, on ? active : node, 1 - smooth(r - 1, r + 1, d));
      }
    }
  }
  return buf;
}

const targets = {
  ghostdrop: { bg: '#090D16', node: '#334155', active: '#10B981', path: [0, 6, 12, 18, 24, 23, 22] },
  cryptkeep: { bg: '#18181B', node: '#52525B', active: '#F59E0B', path: [4, 8, 12, 16, 20, 21, 22, 23, 24] },
};

for (const [app, theme] of Object.entries(targets)) {
  const dir = join(root, 'apps', app, 'public', 'icons');
  mkdirSync(dir, { recursive: true });
  for (const size of [192, 512]) {
    writeFileSync(join(dir, `icon-${size}.png`), encodePng(size, render(size, theme)));
  }
  console.log(`✔ ${app}: icon-192.png, icon-512.png`);
}
