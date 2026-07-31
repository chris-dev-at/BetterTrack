import { readFileSync } from 'node:fs';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Release tag baked into the bundle at build time. An explicit
// VITE_APP_RELEASE (e.g. a git SHA from CI) wins; otherwise it derives from this
// package's version. Injected via `define` as a global constant so it is a
// compile-time literal with zero runtime env lookup.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const release = process.env.VITE_APP_RELEASE ?? `bettertrack-web@${pkg.version}`;

/** Dev-server proxy target for `/api` and `/ws` — the local API's origin. */
const apiProxyTarget = process.env.BT_WEB_DEV_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_RELEASE__: JSON.stringify(release),
  },
  server: {
    port: 5173,
    // In dev, the API runs separately; same-origin proxy keeps cookies simple
    // (mirrors the nginx topology described in PROJECTPLAN.md §4.6).
    // `BT_WEB_DEV_PROXY_TARGET` retargets both hops together so a second stack
    // (the Playwright e2e boot) can run its own API on another port without its
    // browser traffic being proxied into the dev stack's API — and its database.
    proxy: {
      '/api': apiProxyTarget,
      // Realtime gateway websocket (§4.5, V3-P7a) — same-origin in dev, like /api.
      '/ws': { target: apiProxyTarget, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The paranoid vault suites run the production Argon2id profile (64 MiB,
    // t=3) plus real AES-GCM/zip work, and a shared CI runner needs seconds per
    // derivation — one crypto vector test already spends >7s there. The 5s
    // default would fail those on runner load rather than on a defect, so this
    // matches apps/api's budget.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
