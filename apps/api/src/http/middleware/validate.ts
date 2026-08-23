import type { RequestHandler } from 'express';
import type { ZodIssue, ZodTypeAny } from 'zod';

import { badRequest } from '../../errors';

type Source = 'body' | 'query' | 'params';

function contractErrorCode(issue: ZodIssue): string | undefined {
  if (issue.code !== 'custom') return undefined;
  const candidate = issue.params?.apiErrorCode;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]+$/.test(candidate)
    ? candidate
    : undefined;
}

/**
 * Parses a request part with a shared zod schema before any logic runs
 * (PROJECTPLAN.md §10). Parsed data is stashed on `req.valid` (Express 5's
 * `req.query` is a read-only getter, so we never reassign it).
 */
function validate(source: Source, schema: ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    const input = source === 'body' ? req.body : source === 'query' ? req.query : req.params;
    const result = schema.safeParse(input);
    if (!result.success) {
      // Shared contracts may opt a custom issue into a stable API error code.
      // The pairing rule still lives in zod; this generic adapter only preserves
      // its actionable code/message instead of flattening it to an opaque 400.
      const specificIssue = result.error.issues.find((issue) => contractErrorCode(issue));
      next(
        badRequest(
          specificIssue?.message ?? 'Invalid request.',
          (specificIssue && contractErrorCode(specificIssue)) ?? 'VALIDATION_ERROR',
          result.error.flatten(),
        ),
      );
      return;
    }
    req.valid ??= {};
    req.valid[source] = result.data;
    next();
  };
}

export const validateBody = (schema: ZodTypeAny): RequestHandler => validate('body', schema);
export const validateQuery = (schema: ZodTypeAny): RequestHandler => validate('query', schema);
export const validateParams = (schema: ZodTypeAny): RequestHandler => validate('params', schema);
