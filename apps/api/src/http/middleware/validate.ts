import type { RequestHandler } from 'express';
import { ZodError, type ZodIssue, type ZodTypeAny } from 'zod';

import {
  VALIDATION_ERROR_ISSUES_MAX,
  VALIDATION_ERROR_MESSAGE_MAX_CHARS,
  type ValidationErrorDetails,
} from '@bettertrack/contracts';

import { ApiError, badRequest } from '../../errors';

type Source = 'body' | 'query' | 'params';

function contractErrorCode(issue: ZodIssue): string | undefined {
  if (issue.code !== 'custom') return undefined;
  const candidate = issue.params?.apiErrorCode;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]+$/.test(candidate)
    ? candidate
    : undefined;
}

/**
 * The `details` of every `VALIDATION_ERROR` (contracts `ValidationErrorDetails`):
 * zod's flatten of the FIRST {@link VALIDATION_ERROR_ISSUES_MAX} issues, each
 * message capped, plus the total `issueCount`.
 *
 * zod 3 hands back every issue it found (GHSA-mrhx-c7xc-m3w5) — a 100 KiB body
 * of `[0,0,…]` against a uuid array is ~51,000 of them — and flattening all of
 * them into the response cost tens of MiB of heap and a multi-MiB 400 per
 * request. Slicing BEFORE the flatten keeps both the work and the response
 * constant-size. The message cap matters for the one issue whose text grows with
 * the input (`.strict()`'s "Unrecognized key(s) in object: …" lists every key).
 */
export function validationErrorDetails(issues: readonly ZodIssue[]): ValidationErrorDetails {
  const shown = issues
    .slice(0, VALIDATION_ERROR_ISSUES_MAX)
    .map((issue) =>
      issue.message.length > VALIDATION_ERROR_MESSAGE_MAX_CHARS
        ? { ...issue, message: `${issue.message.slice(0, VALIDATION_ERROR_MESSAGE_MAX_CHARS)}…` }
        : issue,
    );
  return { ...new ZodError(shown).flatten(), issueCount: issues.length };
}

/**
 * The 400 a failed parse answers with. Shared by {@link validateBody} and the
 * pre-zod restore-document bounds so both speak one envelope.
 */
export function validationFailure(issues: readonly ZodIssue[]): ApiError {
  // Shared contracts may opt a custom issue into a stable API error code.
  // The pairing rule still lives in zod; this generic adapter only preserves
  // its actionable code/message instead of flattening it to an opaque 400.
  const specificIssue = issues.find((issue) => contractErrorCode(issue));
  return badRequest(
    specificIssue?.message ?? 'Invalid request.',
    (specificIssue && contractErrorCode(specificIssue)) ?? 'VALIDATION_ERROR',
    validationErrorDetails(issues),
  );
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
      next(validationFailure(result.error.issues));
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
