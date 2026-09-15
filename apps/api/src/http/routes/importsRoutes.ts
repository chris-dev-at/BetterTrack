import { Router } from 'express';

import {
  applyImportRequestSchema,
  createImportBatchFieldsSchema,
  importBatchIdParamSchema,
  importRowIdParamSchema,
  resolveImportRowRequestSchema,
  type ApplyImportRequest,
  type CreateImportBatchFields,
  type ResolveImportRowRequest,
} from '@bettertrack/contracts';

import { badRequest } from '../../errors';
import { uploadCsvFile } from '../uploads';
import { createIdempotency, withIdempotencyExecution } from '../middleware/idempotency';
import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Broker CSV imports (PROJECTPLAN.md §13.4 V4-P8). Controllers stay thin:
 * multipart parse → zod-validate the text fields → service → respond. Every
 * `/:batchId` handler is owner-scoped in the service (a foreign batch is a 404,
 * never a 403 — no IDOR, §8). Uploads are staging only — nothing reaches the
 * portfolio before the explicit `POST /:batchId/apply` confirm.
 *
 * Imports are a portfolio surface, so the bearer middleware maps `/imports` to
 * the `portfolio:read` / `portfolio:write` scope pair.
 */
export function createImportsRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  // Idempotency (§13.4 V4-P2a): apply is a portfolio mutation like any other —
  // a retrying bearer client (the mobile offline queue) replays the memoized
  // response instead of racing the batch's atomic claim into a 409.
  const idempotency = createIdempotency(ctx);

  const uploadFile = uploadCsvFile('IMPORT_FILE_INVALID');

  // GET /imports/brokers — the supported broker mappers, for the manual picker.
  router.get('/brokers', (_req, res) => {
    res.json(ctx.imports.listBrokers());
  });

  // POST /imports — upload a CSV (multipart: `file` + portfolioId [+ brokerId]);
  // parses/normalizes/resolves/dedupes into a staged batch and returns the preview.
  //
  // Cost-metered (§10 COST TABLE, #1643) at 100 work units: staging one batch
  // drives the row classifier through ≈450 `pg_trgm` scans. The guard runs
  // BEFORE multer, so an over-budget caller is turned away without the API
  // reading (or buffering) the upload at all. The price of that ordering is on
  // the wire, not in the contract: the 429 is written while the multipart body
  // is still in flight, so Node closes the connection rather than draining it
  // and a client may observe a reset instead of the response. Accepted — not
  // buffering an unbounded upload we have already decided to refuse is worth
  // more than a graceful close on a request that is over budget anyway.
  router.post(
    '/',
    limiters.cost('importCreate'),
    uploadFile,
    validateBody(createImportBatchFieldsSchema),
    async (req, res) => {
      const fields = req.valid?.body as CreateImportBatchFields;
      if (!req.file) {
        throw badRequest('A CSV file is required.', 'IMPORT_FILE_REQUIRED');
      }
      const result = await ctx.imports.createBatch(req.authUser!.id, {
        portfolioId: fields.portfolioId,
        brokerId: fields.brokerId,
        filename: req.file.originalname || 'import.csv',
        content: req.file.buffer.toString('utf8'),
        // The generic path sniffs the encoding itself, so it needs the bytes: a
        // UTF-16LE or windows-1252 statement has already lost that evidence once
        // it is a UTF-8 string. The broker mappers keep reading `content`.
        contentBytes: req.file.buffer,
      });
      res.status(201).json(result);
    },
  );

  // GET /imports/:batchId — re-read a staged batch's preview.
  router.get('/:batchId', validateParams(importBatchIdParamSchema), async (req, res) => {
    const { batchId } = req.valid?.params as { batchId: string };
    const result = await ctx.imports.getBatch(req.authUser!.id, batchId);
    res.json(result);
  });

  // POST /imports/:batchId/apply — the explicit confirm: applies the batch's
  // valid rows into its portfolio (+ chosen cash source); per-row outcomes.
  router.post(
    '/:batchId/apply',
    validateParams(importBatchIdParamSchema),
    idempotency,
    withIdempotencyExecution(validateBody(applyImportRequestSchema), async (req, res) => {
      const { batchId } = req.valid?.params as { batchId: string };
      const body = req.valid?.body as ApplyImportRequest;
      const result = await ctx.imports.applyBatch(req.authUser!.id, batchId, body);
      res.json(result);
    }),
  );

  // PATCH /imports/:batchId/rows/:rowId — finish ONE row a person had to decide
  // about: `{ assetId }` pins an unresolved instrument (§16 2026-07-31 point 4),
  // `{ kind }` confirms what an undecided row is (§16 2026-08-29 gap (b));
  // exactly one per request, enforced by the contract and again in the service.
  // Owner-scoped in the service, batch must still be pending. Returns the
  // refreshed preview, so the client never recomputes counts locally and never
  // drifts from what staging now holds.
  //
  // Cost-metered (§10 COST TABLE) at 6 work units: a confirmation is cheap for
  // a client to repeat — the wizard's bulk sweep is one call per row — and each
  // one re-derives the row's instrument, hash and duplicate verdict against the
  // portfolio's recorded entities. The service memoizes those per batch, so the
  // sweep's SECOND call onwards is a few indexed reads; the weight prices the
  // first one and keeps a caller who reopens batches in a loop bounded by the
  // work it asks for rather than by how many requests it arrives in.
  router.patch(
    '/:batchId/rows/:rowId',
    limiters.cost('importRowResolve'),
    validateParams(importRowIdParamSchema),
    validateBody(resolveImportRowRequestSchema),
    async (req, res) => {
      const { batchId, rowId } = req.valid?.params as { batchId: string; rowId: string };
      const body = req.valid?.body as ResolveImportRowRequest;
      const result = await ctx.imports.resolveRow(req.authUser!.id, batchId, rowId, body);
      res.json(result);
    },
  );

  // DELETE /imports/:batchId — discard a staged batch (staging data only).
  router.delete('/:batchId', validateParams(importBatchIdParamSchema), async (req, res) => {
    const { batchId } = req.valid?.params as { batchId: string };
    await ctx.imports.discardBatch(req.authUser!.id, batchId);
    res.status(204).send();
  });

  return router;
}
