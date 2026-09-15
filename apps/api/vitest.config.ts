import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Every test file gets the #1936 harness reaper: an `afterAll` that
    // releases any `createTestApp()` harness the file did not dispose itself.
    // Registered from a setup file so it is the first `afterAll` collected and
    // — under Vitest's default `sequence.hooks: "stack"` — therefore the last
    // to run, after any hook of the file's own that still uses its harness.
    setupFiles: ['src/testing/setupHarnessReaper.ts'],
    // The integration tests spin up PGlite (WASM migrations) and hash passwords
    // with argon2 — both deliberately heavy. Under the forked-pool contention of
    // the full suite the slowest of these can brush past Vitest's 5 s default, so
    // we give every test/hook generous headroom; a genuinely hung test still
    // fails at this bound.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Each forked worker boots its own PGlite (WASM Postgres) — several hundred
    // MB apiece once the suite warms up. Unbounded forks scale with CPU count,
    // so a many-core/moderate-RAM machine (e.g. 10 cores / 8 GB) gets its
    // workers OOM-killed mid-run ("Channel closed" pool errors). Four forks
    // matches the GitHub-runner shape CI uses and keeps peak memory ~2 GB.
    maxWorkers: 4,
  },
});
