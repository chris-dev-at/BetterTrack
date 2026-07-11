import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the real-service integration job (postgres:17 + redis:7).
 * Run via: TEST_DATABASE_URL=... TEST_REDIS_URL=... pnpm test:integration
 *
 * singleFork keeps all test files in one process so the module-level DB/Redis
 * singletons in createTestApp.ts (migrations + connection reuse) are shared —
 * migrations run once, each beforeEach only truncates tables.
 *
 * The focused include list covers the auth/session/admin paths that exercise
 * the most SQL and the workboard repo. The full PGlite suite remains the fast
 * default path (pnpm test / vitest.config.ts).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/__tests__/auth.test.ts',
      'src/__tests__/admin.test.ts',
      'src/__tests__/workboard.test.ts',
      'src/__tests__/password.test.ts',
      // #437: the archive/delete repo methods carry raw SQL fragments
      // (COALESCE + ::timestamptz casts) whose param typing differs between
      // PGlite and postgres-js — keep them proven on the real engine.
      'src/__tests__/notificationsArchive.test.ts',
    ],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
