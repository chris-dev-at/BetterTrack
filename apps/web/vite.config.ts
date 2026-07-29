import { readFileSync } from 'node:fs';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Release tag baked into the bundle at build time (§13.4 V4-P5a), so every
// Sentry event the SPA reports carries the same `name@version` release as the
// API. An explicit VITE_SENTRY_RELEASE (e.g. a git SHA from CI) wins; otherwise
// it derives from this package's version. Injected via `define` as a global
// constant so it is a compile-time literal with zero runtime env lookup.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const release = process.env.VITE_SENTRY_RELEASE ?? `bettertrack-web@${pkg.version}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_RELEASE__: JSON.stringify(release),
  },
  server: {
    port: 5173,
    // In dev, the API runs separately; same-origin proxy keeps cookies simple
    // (mirrors the nginx topology described in PROJECTPLAN.md §4.6).
    proxy: {
      '/api': 'http://localhost:3000',
      // Realtime gateway websocket (§4.5, V3-P7a) — same-origin in dev, like /api.
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
