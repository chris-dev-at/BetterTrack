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
 * The three shareable kinds one audience model governs (V3-P5, §13.3): each
 * portfolio, each conglomerate, each watchlist. Defined here — the neutral,
 * import-free contracts root — so both `social.ts` and `workboard.ts` reference
 * it without an import cycle.
 */
export const SHARE_KINDS = ['portfolio', 'conglomerate', 'watchlist'] as const;
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
