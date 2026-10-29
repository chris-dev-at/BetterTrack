import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { VALIDATION_ERROR_ISSUES_MAX, validationErrorDetailsSchema } from '@bettertrack/contracts';

import { loadConfig } from '../../../config/env';
import { createLogger } from '../../../logger';
import { createErrorHandler } from '../../errorHandler';
import { validateBody } from '../validate';

const logger = createLogger(
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    SESSION_SECRET: 'validate-cap-test-secret-0123456789',
  }),
);

const shownMessages = (details: z.infer<typeof validationErrorDetailsSchema>): number =>
  details.formErrors.length +
  Object.values(details.fieldErrors).reduce((sum, messages) => sum + (messages?.length ?? 0), 0);

function app() {
  const server = express();
  server.use(express.json({ limit: '100kb' }));
  server.post(
    '/ids',
    validateBody(z.object({ ids: z.array(z.string().uuid()).max(20) }).strict()),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  server.post('/strict', validateBody(z.object({ a: z.string() }).strict()), (_req, res) => {
    res.json({ ok: true });
  });
  server.post('/thrown', (req) => {
    // A handler-thrown ZodError travels the terminal handler's own branch.
    z.array(z.object({ n: z.number() })).parse(req.body.items);
  });
  server.use(createErrorHandler(logger));
  return server;
}

// GHSA-mrhx-c7xc-m3w5: zod 3 reports every failing element even past `.max()`.
describe('validation error details are capped', () => {
  it('returns the first 20 issues plus the total count from validateBody', async () => {
    const response = await request(app())
      .post('/ids')
      .send({ ids: new Array(200).fill(0) });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    const details = validationErrorDetailsSchema.parse(response.body.error.details);
    // 200 non-strings + the failed `.max(20)` itself.
    expect(details.issueCount).toBe(201);
    expect(shownMessages(details)).toBe(VALIDATION_ERROR_ISSUES_MAX);
    expect(details.fieldErrors.ids).toHaveLength(VALIDATION_ERROR_ISSUES_MAX);
  });

  it('keeps an under-cap failure whole, so small errors read exactly as before', async () => {
    const response = await request(app())
      .post('/ids')
      .send({ ids: ['not-a-uuid'] });
    expect(response.status).toBe(400);
    const details = validationErrorDetailsSchema.parse(response.body.error.details);
    expect(details).toEqual({
      formErrors: [],
      fieldErrors: { ids: ['Invalid uuid'] },
      issueCount: 1,
    });
  });

  it('caps the one message that grows with the input', async () => {
    const body: Record<string, string> = { a: 'x' };
    for (let index = 0; index < 2_000; index += 1) body[`unknown_key_${index}`] = '';
    const response = await request(app()).post('/strict').send(body);
    expect(response.status).toBe(400);
    const details = validationErrorDetailsSchema.parse(response.body.error.details);
    expect(details.issueCount).toBe(1);
    expect(details.formErrors[0]!.length).toBeLessThanOrEqual(1001);
    expect(JSON.stringify(response.body).length).toBeLessThan(2_000);
  });

  it('caps a handler-thrown ZodError the same way', async () => {
    const response = await request(app())
      .post('/thrown')
      .send({ items: new Array(100).fill({}) });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    const details = validationErrorDetailsSchema.parse(response.body.error.details);
    expect(details.issueCount).toBe(100);
    expect(shownMessages(details)).toBe(VALIDATION_ERROR_ISSUES_MAX);
  });
});
