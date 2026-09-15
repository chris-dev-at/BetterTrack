import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { IMPORT_MAX_FILE_BYTES } from '@bettertrack/contracts';

import { loadConfig } from '../config/env';
import { createLogger } from '../logger';

import { createErrorHandler } from './errorHandler';
import { csvUploadLimits, uploadCsvFile } from './uploads';

/**
 * Unit cover for the shared CSV upload middleware (issue #1931).
 *
 * `/imports` exercises this through its own route tests. The other caller,
 * `/expenses`, cannot: every upload route there sits below
 * `refuseRetiredExpenseWrite`, which answers 410 to every POST before multer
 * runs, so `EXPENSE_IMPORT_FILE_INVALID` has no reachable path at all. Since
 * extracting the module is exactly what makes it possible to silently change
 * that dead half, the tests below drive the middleware directly under the
 * expenses error code — the only thing that proves the retired surface still
 * refuses the way its own contract says it does.
 */
const logger = createLogger(
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    SESSION_SECRET: 'uploads-test-secret-0123456789abcd',
  }),
);

function uploadApp(errorCode: string) {
  const app = express();
  app.post('/upload', uploadCsvFile(errorCode), (req, res) => {
    res.json({
      body: req.body as unknown,
      file: req.file ? { field: req.file.fieldname, bytes: req.file.size } : null,
    });
  });
  app.use(createErrorHandler(logger));
  return app;
}

const CSV = 'Datum;Betrag\n2026-01-02;10,00\n';

describe('uploadCsvFile', () => {
  it('accepts the shape both routes send and hands the parts on', async () => {
    const res = await request(uploadApp('EXPENSE_IMPORT_FILE_INVALID'))
      .post('/upload')
      .field('bankId', 'george')
      .field('overrides', '[]')
      .attach('file', Buffer.from(CSV, 'utf8'), 'statement.csv');

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ bankId: 'george', overrides: '[]' });
    expect(res.body.file).toEqual({ field: 'file', bytes: Buffer.byteLength(CSV, 'utf8') });
  });

  it('refuses a nested field name under the caller-supplied contract code', async () => {
    // `fieldNestingDepth` is multer's second opt-in guard and, like
    // `fieldArrayIndexLimit`, is consulted ONLY when `limits` carries the key as
    // an own property. Without it `append-field` walks `a[b][c]` into a nested
    // object inside `req.body` and the request survives to the body schema;
    // with it the upload is refused where every other multipart breach is.
    const res = await request(uploadApp('EXPENSE_IMPORT_FILE_INVALID'))
      .post('/upload')
      .field('bankId', 'george')
      .field('a[b][c]', '1')
      .attach('file', Buffer.from(CSV, 'utf8'), 'statement.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'EXPENSE_IMPORT_FILE_INVALID',
      message: 'Invalid file upload.',
    });
  });

  it('refuses a sparse-array field index under the caller-supplied contract code', async () => {
    const res = await request(uploadApp('EXPENSE_IMPORT_FILE_INVALID'))
      .post('/upload')
      .field('bankId', 'george')
      .field('a[4294967294]', 'x')
      .attach('file', Buffer.from(CSV, 'utf8'), 'statement.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'EXPENSE_IMPORT_FILE_INVALID',
      message: 'Invalid file upload.',
    });
  });

  it('keeps the file-size guidance specific and every other breach generic', async () => {
    const app = uploadApp('EXPENSE_IMPORT_FILE_INVALID');

    const oversized = await request(app)
      .post('/upload')
      .attach('file', Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1, 0x78), 'statement.csv');
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toEqual({
      code: 'EXPENSE_IMPORT_FILE_INVALID',
      message: 'The file exceeds the 5 MB upload limit.',
    });

    const tooManyFields = await request(app)
      .post('/upload')
      .field('bankId', 'george')
      .field('overrides', '[]')
      .field('unexpected', 'amplification')
      .attach('file', Buffer.from(CSV, 'utf8'), 'statement.csv');
    expect(tooManyFields.status).toBe(400);
    expect(tooManyFields.body.error).toEqual({
      code: 'EXPENSE_IMPORT_FILE_INVALID',
      message: 'Invalid file upload.',
    });
  });

  it('carries the caller-supplied code, so the two routes stay distinguishable', async () => {
    const res = await request(uploadApp('IMPORT_FILE_INVALID'))
      .post('/upload')
      .field('a[b][c]', '1')
      .attach('file', Buffer.from(CSV, 'utf8'), 'statement.csv');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_FILE_INVALID');
  });

  it('keeps both opt-in guards as own properties of one limits object', () => {
    // Both are opt-in: multer consults them only via `hasOwnProperty`, so a
    // limits object that merely types them is not protected by them. The single
    // definition is the point of #1931 — one object, both keys present on it.
    expect(Object.prototype.hasOwnProperty.call(csvUploadLimits, 'fieldArrayIndexLimit')).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(csvUploadLimits, 'fieldNestingDepth')).toBe(true);
    // …and frozen, because multer keeps the reference rather than copying it:
    // an unfrozen export is a live handle on the running middleware's limits.
    expect(Object.isFrozen(csvUploadLimits)).toBe(true);
  });
});
