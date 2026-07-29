import { describe, expect, it } from 'vitest';

import { healthResponseSchema, readinessResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a well-formed health payload', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'bettertrack-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: 12.34,
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = healthResponseSchema.safeParse({
      status: 'degraded',
      service: 'bettertrack-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: 1,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'bettertrack-api',
      version: '0.1.0',
      timestamp: 'not-a-timestamp',
      uptime: 1,
    });

    expect(result.success).toBe(false);
  });
});

describe('readinessResponseSchema', () => {
  it('accepts ready and dependency-down payloads', () => {
    const base = {
      service: 'bettertrack-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    };

    expect(
      readinessResponseSchema.safeParse({
        ...base,
        status: 'ready',
        checks: {
          database: { status: 'ok', latencyMs: 2 },
          redis: { status: 'ok', latencyMs: 1 },
        },
      }).success,
    ).toBe(true);

    expect(
      readinessResponseSchema.safeParse({
        ...base,
        status: 'not_ready',
        checks: {
          database: { status: 'down', latencyMs: 1_500 },
          redis: { status: 'ok', latencyMs: 1 },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown dependency states and negative latencies', () => {
    const result = readinessResponseSchema.safeParse({
      status: 'not_ready',
      service: 'bettertrack-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      checks: {
        database: { status: 'unknown', latencyMs: -1 },
        redis: { status: 'ok', latencyMs: 1 },
      },
    });

    expect(result.success).toBe(false);
  });
});
