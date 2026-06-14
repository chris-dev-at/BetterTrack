import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

import { badRequest } from '../../errors';

type Source = 'body' | 'query' | 'params';

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
      next(badRequest('Invalid request.', 'VALIDATION_ERROR', result.error.flatten()));
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
