import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig, type AppConfig } from '../../config/env';
import { handleWorkerFailure } from '../../jobs/worker';
import { createLogger, type Logger } from '../../logger';

import { initObservability, SENTRY_REFUSED_MESSAGE } from './sentry';

/**
 * External Sentry is RETIRED (§16 2026-07-17; §13.5 V5-P2 arc (d) — the admin
 * Problems page is the replacement). A DSN restored from an old `.env` must not
 * quietly resume shipping BetterTrack errors to a third party: boot refuses it,
 * loudly, and no SDK client is constructed on any code path.
 */

// A well-formed DSN. If anything here still honoured it, an SDK client would
// exist after the call below — which is exactly what is asserted against.
const TEST_DSN = 'https://abc123def4567890abcdef1234567890@o1234567.ingest.sentry.io/7654321';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  SESSION_SECRET: 'sentry-test-session-secret-0123456789',
};

function configWithSentry(): AppConfig {
  return loadConfig({ ...baseEnv, BT_SENTRY_DSN: TEST_DSN });
}

function testLogger(): Logger {
  return createLogger(loadConfig({ ...baseEnv }));
}

describe('initObservability (retired external tracker)', () => {
  it('is a disabled no-op when no DSN is configured', () => {
    const obs = initObservability(loadConfig({ ...baseEnv }), testLogger());
    expect(obs.enabled).toBe(false);
    expect(obs.refusedDsn).toBe(false);
    // Never throws even without an SDK behind it.
    expect(() => obs.captureException(new Error('x'))).not.toThrow();
  });

  it('refuses a configured DSN instead of initialising the SDK', () => {
    const logger = testLogger();
    const error = vi.spyOn(logger, 'error');

    const obs = initObservability(configWithSentry(), logger, { serverName: 'api' });

    expect(obs.enabled).toBe(false);
    // The refusal is reported, so the caller captures it as a problem row.
    expect(obs.refusedDsn).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'api' }),
      SENTRY_REFUSED_MESSAGE,
    );
    // The operator is told where the errors actually go.
    expect(SENTRY_REFUSED_MESSAGE).toContain('admin Problems page');
  });

  it('is disabled in both the api and worker process, even with a DSN configured', () => {
    const config = configWithSentry();
    const obsApi = initObservability(config, testLogger(), { serverName: 'api' });
    const obsWorker = initObservability(config, testLogger(), { serverName: 'worker' });

    // No client can exist to construct in either process — enabled is always
    // false, on the same inert handle shape whichever server calls it.
    expect(obsApi.enabled).toBe(false);
    expect(obsWorker.enabled).toBe(false);
  });

  it('never carries the DSN onto the config, so no code path can reach it', () => {
    const config = configWithSentry();
    expect(config.sentry.dsnConfigured).toBe(true);
    expect(JSON.stringify(config.sentry)).not.toContain('ingest.sentry.io');
  });

  it('is an inert handle that still flushes and closes', async () => {
    const obs = initObservability(configWithSentry(), testLogger());
    await expect(obs.flush()).resolves.toBe(true);
    await expect(obs.close()).resolves.toBe(true);
    expect(() => obs.captureException(new Error('ignored'))).not.toThrow();
  });
});

/**
 * The dependency itself is gone too (#1925), not just unused: no code path
 * needs `@sentry/*` installed, so it cannot quietly come back as production
 * weight (the SDK plus its OpenTelemetry tree) shipped for nothing.
 */
describe('the retired SDK stays gone (#1925)', () => {
  const apiPackageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../package.json',
  );

  it('is declared nowhere in apps/api/package.json', () => {
    const apiPackage = JSON.parse(readFileSync(apiPackageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(apiPackage.dependencies ?? {}),
      ...Object.keys(apiPackage.devDependencies ?? {}),
    ];
    // Guard the fixture itself: an empty package.json would make this vacuous.
    expect(declared.length).toBeGreaterThan(10);

    expect(declared.filter((name) => /^@sentry\//.test(name))).toEqual([]);
  });

  it('is imported by no source file under services/observability/', () => {
    const observabilityDir = path.dirname(fileURLToPath(import.meta.url));

    // Source only — test files legitimately talk ABOUT the retired SDK (this
    // one included) without importing it, so scanning them risks a false
    // positive on prose rather than a real import.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
          ? [full]
          : [];
      });

    const sourceFiles = walk(observabilityDir);
    // Guard the scanner itself: an empty sweep would make the assertion vacuous.
    expect(sourceFiles.length).toBeGreaterThan(3);

    // Matches `@sentry/node`, `@sentry/core`, or any other scoped entry point.
    const importers = sourceFiles.filter((file) => /@sentry\//.test(readFileSync(file, 'utf8')));
    expect(importers.map((file) => path.relative(observabilityDir, file))).toEqual([]);
  });
});

/**
 * The failure classification the retired SDK used to consume is unchanged — it
 * now feeds the DB capture instead (`onPermanentFailure` → `captureJobFailure`).
 */
describe('BullMQ failure reporting seam', () => {
  it('reports a permanently-failed job once, after dead-lettering it', async () => {
    const logger = testLogger();
    const recorded: unknown[] = [];
    const reported: unknown[] = [];

    handleWorkerFailure({
      queue: 'system.heartbeat',
      // A job that has exhausted its attempts ⇒ permanent failure.
      job: {
        id: 'job-1',
        name: 'system.heartbeat',
        data: {},
        attemptsMade: 3,
        opts: { attempts: 3 },
        failedReason: 'boom',
      } as never,
      err: new Error('job crashed processing admin@bettertrack.at'),
      ctx: {
        deadLetter: {
          record: async (entry: unknown) => {
            recorded.push(entry);
          },
        },
        logger,
        events: {} as never,
        redis: {} as never,
      } as never,
      logger,
      onPermanentFailure: (err) => reported.push(err),
    });
    // The dead-letter write is awaited inside the handler's own promise chain.
    await new Promise((resolve) => setImmediate(resolve));

    expect(recorded).toHaveLength(1);
    expect(reported).toHaveLength(1);
  });

  it('does not report a still-retryable job attempt failure', () => {
    const logger = testLogger();
    let reported = false;
    handleWorkerFailure({
      queue: 'system.heartbeat',
      job: {
        id: 'job-2',
        name: 'system.heartbeat',
        data: {},
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as never,
      err: new Error('transient'),
      ctx: { deadLetter: { record: async () => {} }, logger } as never,
      logger,
      onPermanentFailure: () => {
        reported = true;
      },
    });
    expect(reported).toBe(false);
  });
});
