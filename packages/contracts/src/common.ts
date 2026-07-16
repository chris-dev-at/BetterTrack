import { z } from 'zod';

/** Standard API error envelope (PROJECTPLAN.md §8). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/** Reusable route-parameter schemas. */
export const idParamSchema = z.object({ id: z.string().uuid() }).strict();
export const tokenParamSchema = z.object({ token: z.string().min(1).max(256) }).strict();

/**
 * Idempotency on portfolio mutation endpoints (V4-P2a, #417) — the backbone for
 * the app's offline FIFO queue (mobile SPEC §7). A client MAY send this header
 * carrying a UUID on a mutating request; the server persists key→response per
 * user (≥ 48 h) and replays the stored response on a duplicate, so a retried
 * request never repeats the side effect. Opt-in: a request WITHOUT the header
 * behaves exactly as before, so the web SPA keeps working unchanged.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** The header value must be a UUID; anything else is a 400 IDEMPOTENCY_KEY_INVALID. */
export const idempotencyKeySchema = z.string().uuid();

/**
 * Typed error codes the idempotency layer raises in the standard `{ error }`
 * envelope (§8):
 *  - `IDEMPOTENCY_KEY_INVALID` (400): the header is present but not a UUID.
 *  - `IDEMPOTENCY_KEY_MISMATCH` (409): the key was already used for a *different*
 *    request (different endpoint or body) — never replayed, always rejected.
 *  - `IDEMPOTENCY_IN_PROGRESS` (409): a concurrent request with the same key is
 *    still executing; the client may retry once it settles.
 */
export const IDEMPOTENCY_ERROR_CODES = {
  invalidKey: 'IDEMPOTENCY_KEY_INVALID',
  mismatch: 'IDEMPOTENCY_KEY_MISMATCH',
  inProgress: 'IDEMPOTENCY_IN_PROGRESS',
} as const;
export type IdempotencyErrorCode =
  (typeof IDEMPOTENCY_ERROR_CODES)[keyof typeof IDEMPOTENCY_ERROR_CODES];

/**
 * The shareable kinds one audience model governs (V3-P5, §13.3, §13.4 V4-P9):
 * each portfolio, each conglomerate, each watchlist, and each saved **idea** (a
 * named Workboard analysis). Defined here — the neutral, import-free contracts
 * root — so both `social.ts` and `workboard.ts` reference it without an import
 * cycle. Ideas join as the fourth kind through the SAME audience model — never a
 * parallel sharing path (V4-P9).
 */
export const SHARE_KINDS = ['portfolio', 'conglomerate', 'watchlist', 'idea'] as const;
export const shareKindSchema = z.enum(SHARE_KINDS);
export type ShareKind = z.infer<typeof shareKindSchema>;

/**
 * The audience ladder (V3-P5, §16 friction ladder): a single-select rung of
 * increasing exposure — `private` (default, owner only) → `specific_friends`
 * (multi-select) → `all_friends` → `public_link` (anyone holding the ≥128-bit
 * token URL). The server scopes every social read by an existing friendship AND
 * this value at query time (§6.9); revoking either instantly closes access.
 */
export const SHARE_AUDIENCES = [
  'private',
  'specific_friends',
  'all_friends',
  'public_link',
] as const;
export const shareAudienceSchema = z.enum(SHARE_AUDIENCES);
export type ShareAudience = z.infer<typeof shareAudienceSchema>;
