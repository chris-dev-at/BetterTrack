import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from './health';

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
