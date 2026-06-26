import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The integration tests spin up PGlite (WASM migrations) and hash passwords
    // with argon2 — both deliberately heavy. Under the forked-pool contention of
    // the full suite the slowest of these can brush past Vitest's 5 s default, so
    // we give every test/hook generous headroom; a genuinely hung test still
    // fails at this bound.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
