import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Strict Content-Security-Policy, injected into the production build only (the dev server needs
 * inline HMR scripts). No remote origins at all: a zero-knowledge editor never talks to a server,
 * and the Markdown preview never loads remote images.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
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
  // Set VITE_BASE_PATH (e.g. "/vaulty-skeleton/inkvault/") when hosting under a sub-path.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss(), cspPlugin()],
  // Fixed ports so the apps never collide with each other or with other local dev servers.
  server: { port: 5183, strictPort: true },
  preview: { port: 4183, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
  },
});
