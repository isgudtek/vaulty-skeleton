import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Strict Content-Security-Policy, injected into the production build only (the dev server needs
 * inline HMR scripts). No remote origins at all: a zero-knowledge vault never talks to a server.
 * `blob:` is required solely for the in-memory decrypted previews.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "frame-src blob:",
  "object-src blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'vaulty-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  // Set VITE_BASE_PATH (e.g. "/vaulty-skeleton/ghostdrop/") when hosting under a sub-path such as GitHub Pages.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss(), cspPlugin()],
  // Fixed ports so the two apps never collide with each other or with other local dev servers.
  server: { port: 5181, strictPort: true },
  preview: { port: 4181, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
  },
});
