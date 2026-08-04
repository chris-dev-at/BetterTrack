import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Release tag baked into the bundle at build time. An explicit
// VITE_APP_RELEASE wins, followed by the deploy's Git SHA and then this
// package's version. Injected via `define` as a global constant so it is a
// compile-time literal with zero runtime env lookup.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const buildSha = process.env.VITE_BUILD_SHA;
const release =
  process.env.VITE_APP_RELEASE ??
  (buildSha && buildSha !== 'unknown' ? buildSha : `bettertrack-web@${pkg.version}`);

const SERVICE_WORKER_BUILD_HASH_TOKEN = '__BETTERTRACK_BUILD_HASH__';
const webRoot = fileURLToPath(new URL('.', import.meta.url));
const buildOutput = join(webRoot, 'dist');

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(path);
    return entry.isFile() ? [path] : [];
  });
}

/**
 * Put a fingerprint of the completed web build into the worker itself. Public
 * files bypass Vite transforms, so this runs after they and the hashed bundles
 * have been written. The worker template is hashed before its token is replaced
 * so its own source participates without creating a circular fingerprint.
 */
function versionServiceWorker(): Plugin {
  return {
    name: 'bettertrack-version-service-worker',
    apply: 'build',
    closeBundle() {
      const serviceWorkerPath = join(buildOutput, 'service-worker.js');
      const source = readFileSync(serviceWorkerPath, 'utf8');
      if (!source.includes(SERVICE_WORKER_BUILD_HASH_TOKEN)) {
        throw new Error('Service-worker build hash placeholder is missing');
      }

      const hash = createHash('sha256');
      hash.update('service-worker.js');
      hash.update('\0');
      hash.update(source);
      hash.update('\0');
      for (const path of filesBelow(buildOutput).sort()) {
        if (path === serviceWorkerPath) continue;
        hash.update(relative(buildOutput, path));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
      }

      const buildHash = hash.digest('hex').slice(0, 20);
      writeFileSync(
        serviceWorkerPath,
        source.replaceAll(SERVICE_WORKER_BUILD_HASH_TOKEN, buildHash),
        'utf8',
      );
    },
  };
}

/** Dev-server proxy target for `/api` and `/ws` — the local API's origin. */
const apiProxyTarget = process.env.BT_WEB_DEV_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss(), versionServiceWorker()],
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
