import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from '@bettertrack/contracts';

import { createApp } from './app';

describe('GET /api/v1/health', () => {
  it('returns a 200 with a contract-valid health payload', async () => {
    const response = await request(createApp()).get('/api/v1/health');

    expect(response.status).toBe(200);

    const result = healthResponseSchema.safeParse(response.body);
    expect(result.success).toBe(true);
  });
});
