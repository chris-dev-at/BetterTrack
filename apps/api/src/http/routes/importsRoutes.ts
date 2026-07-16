import { Router, type RequestHandler } from 'express';
import multer, { MulterError } from 'multer';

import {
  applyImportRequestSchema,
  createImportBatchFieldsSchema,
  importBatchIdParamSchema,
  IMPORT_MAX_FILE_BYTES,
  type ApplyImportRequest,
  type CreateImportBatchFields,
} from '@bettertrack/contracts';

import { badRequest } from '../../errors';
import { createIdempotency } from '../middleware/idempotency';
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
export function createImportsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // Idempotency (§13.4 V4-P2a): apply is a portfolio mutation like any other —
  // a retrying bearer client (the mobile offline queue) replays the memoized
  // response instead of racing the batch's atomic claim into a 409.
  const idempotency = createIdempotency(ctx);

  // In-memory multipart parsing for the one CSV part — files are capped well
  // below anything worth streaming to disk, and staging wants the text anyway.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1 },
  });

  /** `upload.single('file')` with Multer's errors mapped onto the §8 envelope. */
  const uploadFile: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `The file exceeds the ${Math.round(IMPORT_MAX_FILE_BYTES / (1024 * 1024))} MB upload limit.`
            : 'Invalid file upload.';
        next(badRequest(message, 'IMPORT_FILE_INVALID'));
        return;
      }
      next(err);
    });
  };

  // GET /imports/brokers — the supported broker mappers, for the manual picker.
  router.get('/brokers', (_req, res) => {
    res.json(ctx.imports.listBrokers());
  });

  // POST /imports — upload a CSV (multipart: `file` + portfolioId [+ brokerId]);
  // parses/normalizes/resolves/dedupes into a staged batch and returns the preview.
  router.post('/', uploadFile, validateBody(createImportBatchFieldsSchema), async (req, res) => {
    const fields = req.valid?.body as CreateImportBatchFields;
    if (!req.file) {
      throw badRequest('A CSV file is required.', 'IMPORT_FILE_REQUIRED');
    }
    const result = await ctx.imports.createBatch(req.authUser!.id, {
      portfolioId: fields.portfolioId,
      brokerId: fields.brokerId,
      filename: req.file.originalname || 'import.csv',
      content: req.file.buffer.toString('utf8'),
    });
    res.status(201).json(result);
  });

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
    validateBody(applyImportRequestSchema),
    async (req, res) => {
      const { batchId } = req.valid?.params as { batchId: string };
      const body = req.valid?.body as ApplyImportRequest;
      const result = await ctx.imports.applyBatch(req.authUser!.id, batchId, body);
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
