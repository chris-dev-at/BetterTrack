import { defineConfig } from 'vitest/config';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required for vitest.config.integration.ts; the real Postgres suite must not silently skip.',
  );
}

if (!process.env.TEST_REDIS_URL) {
  throw new Error(
    'TEST_REDIS_URL is required for vitest.config.integration.ts; the real Redis suites must not silently degrade to ioredis-mock.',
  );
}

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
      // #1443: the feedback tombstone repeated exactly that shape and shipped a
      // bare `Date` param inside its COALESCE/CASE — postgres-js threw at Bind
      // and EVERY production delete answered 500 while the PGlite suite stayed
      // green. The delete-per-status matrix lives here so the engine that broke
      // is the engine that proves it.
      'src/__tests__/feedbackDeleteMatrix.test.ts',
      // #417 P1 follow-up: keep the idempotency claim/replay/mismatch/concurrent
      // semantics proven against real postgres + postgres-js (migration 0034 was
      // silently skipped on prod while every fresh-database run stayed green).
      'src/__tests__/idempotency.test.ts',
      // #1096: parent delete + tax-correction rollback and the real two-session
      // advisory-lock ordering against open-year reconciliation.
      'src/__tests__/atomicTaxDelete.test.ts',
      // #1097: two truly concurrent cash outflows must serialize around the
      // post-lock solvency replay; PGlite intentionally has only one session.
      'src/__tests__/cashSources.test.ts',
      // #1124: a HOT update can reverse same-instant transaction heap order;
      // the oversell and tax replays must retain their (executed_at, id) order.
      'src/__tests__/transactionOrdering.test.ts',
      // #1128: replica force-delete and a direct withdrawal must serialize on
      // the real two-session advisory lock before either mutates the ledger.
      'src/__tests__/mirrorReplication.test.ts',
      // #1348: Vitest keeps NODE_ENV=test even here, so this suite explicitly
      // selects withLockedPrivacyModes' production branch and proves the users
      // row's KEY SHARE / UPDATE conflicts on separate Postgres sessions.
      'src/__tests__/paranoidPrivacyLocks.test.ts',
      // …and the journal-ordering invariant that was the actual root cause (a
      // misordered `when` makes drizzle skip a migration on any database that
      // already applied a later-stamped one).
      'src/__tests__/migrationJournal.test.ts',
      'src/services/account/__tests__/portfolioVaultTransitionService.test.ts',
      'src/data/repositories/__tests__/portfolioVaultTransitionRepository.test.ts',
      'src/data/repositories/__tests__/portfolioVaultRestoreRepository.test.ts',
      'src/__tests__/vaultsE1.test.ts',
      // #1485: disposing one harness must never close the worker-shared Redis
      // singleton that another harness is still using.
      'src/testing/createTestApp.test.ts',
    ],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
