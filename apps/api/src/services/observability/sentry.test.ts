import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../config/env';
import { handleWorkerFailure } from '../../jobs/worker';
import { createLogger, type Logger } from '../../logger';

import { initObservability, type Observability } from './sentry';

// A well-formed but inert DSN — the stub transport captures envelopes in memory,
// so nothing is ever sent over the network.
const TEST_DSN = 'https://abc123def4567890abcdef1234567890@o1234567.ingest.sentry.io/7654321';

interface CapturedEvent {
  release?: string;
  [key: string]: unknown;
}

/** A Sentry transport factory that records the event payloads it is handed. */
function makeStubTransport(sink: CapturedEvent[]) {
  return () => ({
    // Envelope shape: [headers, items[]]; each item is [itemHeader, payload].
    send(envelope: unknown) {
      const items = (envelope as [unknown, [{ type?: string }, CapturedEvent][]])[1];
      for (const [itemHeader, payload] of items) {
        if (itemHeader?.type === 'event') sink.push(payload);
      }
      return Promise.resolve({ statusCode: 200 });
    },
    flush() {
      return Promise.resolve(true);
    },
  });
}

function configWithSentry(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://sentry-test',
    REDIS_URL: 'redis://sentry-test',
    SESSION_SECRET: 'sentry-test-session-secret-0123456789',
    BT_SENTRY_DSN: TEST_DSN,
  });
}

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  SESSION_SECRET: 'sentry-test-session-secret-0123456789',
};

describe('initObservability', () => {
  let logger: Logger;
  let obs: Observability | null = null;

  beforeEach(() => {
    logger = createLogger(loadConfig({ ...baseEnv }));
  });

  afterEach(async () => {
    await obs?.close();
    obs = null;
  });

  it('is a disabled no-op when no DSN is configured', () => {
    const config = loadConfig({ ...baseEnv });
    obs = initObservability(config, logger);
    expect(obs.enabled).toBe(false);
    // Never throws even without an SDK behind it.
    expect(() => obs!.captureException(new Error('x'))).not.toThrow();
  });

  it('captures an Express-error-handler exception with the release tag and zero PII', async () => {
    const sink: CapturedEvent[] = [];
    const config = configWithSentry();
    obs = initObservability(config, logger, {
      serverName: 'api',
      transport: makeStubTransport(sink),
    });
    expect(obs.enabled).toBe(true);

    // The error a request handler would throw, carrying PII in its message.
    obs.captureException(new Error('boom for user@example.com with token btk_leaksecret'));
    await obs.flush();

    expect(sink.length).toBeGreaterThan(0);
    const event = sink[0]!;
    // Release tag is the deployed API version.
    expect(event.release).toBe('bettertrack-api@0.1.0');
    // Zero PII survived into the event payload.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('btk_leaksecret');
    expect(serialized).toContain('[redacted-email]');
    expect(serialized).toContain('[redacted-token]');
  });

  it('captures a permanently-failed BullMQ job with the release tag and zero PII', async () => {
    const sink: CapturedEvent[] = [];
    const config = configWithSentry();
    obs = initObservability(config, logger, {
      serverName: 'worker',
      transport: makeStubTransport(sink),
    });

    const recorded: unknown[] = [];
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
      onPermanentFailure: (err, meta) => obs!.captureException(err, meta),
    });
    await obs.flush();

    // The failure was still dead-lettered AND reported to Sentry.
    expect(recorded).toHaveLength(1);
    expect(sink.length).toBeGreaterThan(0);
    expect(sink[0]!.release).toBe('bettertrack-api@0.1.0');
    expect(JSON.stringify(sink[0])).not.toContain('admin@bettertrack.at');
  });

  it('does not report a still-retryable job attempt failure', async () => {
    const sink: CapturedEvent[] = [];
    obs = initObservability(configWithSentry(), logger, {
      transport: makeStubTransport(sink),
    });
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
    await obs.flush();
    expect(reported).toBe(false);
    expect(sink).toHaveLength(0);
  });
});
