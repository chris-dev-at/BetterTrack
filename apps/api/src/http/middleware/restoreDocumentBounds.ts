import type { RequestHandler } from 'express';
import type { ZodIssue } from 'zod';

import {
  firstInvalidVaultStrictDocumentElement,
  precheckVaultStrictDocumentShape,
} from '@bettertrack/contracts';

import { parsedJsonBodyByteLength } from '../bodyLimits';

import { validationFailure } from './validate';

const underDocument = (issue: ZodIssue): ZodIssue => ({
  ...issue,
  path: ['document', ...issue.path],
});

/**
 * Bounded validation for the strict restore `document` of the two wide-body
 * routes (`POST /portfolios/:id/vault/move-out`, `POST /account/paranoid/disable`),
 * mounted after the route's JSON parser and BEFORE `validateBody`.
 *
 * zod 3 accumulates one issue per failing array element, per missing field
 * (GHSA-mrhx-c7xc-m3w5), and these routes parse bodies up to 8× the encrypted
 * vault cap — so the full schema alone let one malformed document build an issue
 * list proportional to its own size. This runs the contracts' two cheap layers
 * first: the raw-shape pre-check (lengths only, no zod), then element-at-a-time
 * validation that stops at the first invalid element. Either refusal is the same
 * 400 `VALIDATION_ERROR` envelope `validateBody` answers with; a document that
 * passes both reaches the full schema with no element issue left to accumulate.
 *
 * `fallbackBodyBytes` is the route parser's own limit, used only if the body did
 * not come through a parser carrying `recordParsedJsonBodyBytes` — an upper bound,
 * so the ceiling stays sound either way.
 */
export function boundStrictRestoreDocument(fallbackBodyBytes: number): RequestHandler {
  return (req, _res, next) => {
    const body: unknown = req.body;
    const document =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as { document?: unknown }).document
        : undefined;
    const tooLong = precheckVaultStrictDocumentShape(document, {
      bodyBytes: parsedJsonBodyByteLength(req) ?? fallbackBodyBytes,
    });
    if (tooLong) {
      next(validationFailure([underDocument(tooLong)]));
      return;
    }
    const invalid = firstInvalidVaultStrictDocumentElement(document);
    if (invalid) {
      next(validationFailure(invalid.map(underDocument)));
      return;
    }
    next();
  };
}
