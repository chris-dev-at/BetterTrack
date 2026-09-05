import * as Sentry from '@sentry/node';
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

  it('constructs no network client even with the DSN set, in either process', () => {
    const config = configWithSentry();
    initObservability(config, testLogger(), { serverName: 'api' });
    initObservability(config, testLogger(), { serverName: 'worker' });

    // The SDK was never initialised, so it holds no client — and therefore no
    // transport pointed at an ingest endpoint.
    expect(Sentry.getClient()).toBeUndefined();
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
