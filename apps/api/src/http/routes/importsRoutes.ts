import { Router, type RequestHandler } from 'express';
import multer, { MulterError } from 'multer';

import {
  applyImportRequestSchema,
  createImportBatchFieldsSchema,
  importBatchIdParamSchema,
  importRowIdParamSchema,
  resolveImportRowRequestSchema,
  IMPORT_MAX_FILE_BYTES,
  type ApplyImportRequest,
  type CreateImportBatchFields,
  type ResolveImportRowRequest,
} from '@bettertrack/contracts';

import { badRequest } from '../../errors';
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

  // In-memory multipart parsing for the one CSV part — files are capped well
  // below anything worth streaming to disk, and staging wants the text anyway.
  // Multipart budget: two text fields (portfolioId + optional brokerId), one
  // file, a parts-limit sentinel of four (Busboy emits at equality, so this
  // admits exactly the three allowed parts), a field-size sentinel of 1,000,001
  // (Busboy truncates at equality, so this admits 1,000,000 payload bytes), and
  // 32 header pairs per part (well above browser form data's usual 1–2).
  //
  // `headerPairs` is declarative: Busboy 1.6 ignores it and hard-codes
  // MAX_HEADER_PAIRS = 2000 (lib/types/multipart.js:21). The bound that actually
  // holds is its MAX_HEADER_SIZE = 16 KiB per part header block (:22), enforced
  // by a hard `Malformed part header` error (:395-398) and reset per part, so
  // header memory stays under 16 KiB x `parts`. That error is a plain Error, not
  // a MulterError — hence the catch-all mapping in `uploadFile`.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: IMPORT_MAX_FILE_BYTES,
      files: 1,
      fields: 2,
      parts: 4,
      fieldSize: 1_000_001,
      headerPairs: 32,
    },
  });

  /**
   * `upload.single('file')` with every multipart failure mapped onto the §8
   * envelope. Multer wraps only its own limit breaches as `MulterError`; Busboy's
   * framing errors (an over-16 KiB part header block, `Unexpected end of form`,
   * an unparseable content-type) surface as plain `Error`s and would otherwise
   * reach the terminal handler as an opaque 500 — reporting hostile input as a
   * server fault. Every one of them is a malformed upload, so every one of them
   * is the same 400; only the file-size breach earns more specific guidance.
   */
  const uploadFile: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const message =
        err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? `The file exceeds the ${Math.round(IMPORT_MAX_FILE_BYTES / (1024 * 1024))} MB upload limit.`
          : 'Invalid file upload.';
      next(badRequest(message, 'IMPORT_FILE_INVALID'));
    });
  };

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
  // reading (or buffering) the upload at all.
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
  // Rate-limited on the portfolio-write lane: a confirmation is cheap for a
  // client to repeat (the wizard's bulk sweep is one call per row) and each one
  // re-reads the portfolio's content hashes, so the endpoint gets the same
  // ceiling every other authenticated write surface has (§10).
  router.patch(
    '/:batchId/rows/:rowId',
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
