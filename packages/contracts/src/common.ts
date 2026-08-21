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

/** Stable error codes emitted by shared authentication-state guards. */
export const AUTH_ERROR_CODES = {
  unauthenticated: 'UNAUTHENTICATED',
  passwordChangeRequired: 'PASSWORD_CHANGE_REQUIRED',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

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
 * (multi-select) → `group` (a named friend circle, V5-P8) → `all_friends` →
 * `public_link` (anyone holding the ≥128-bit token URL). The array order IS the
 * ladder order the picker renders. The server scopes every social read by an
 * existing friendship AND this value at query time (§6.9); revoking either — or
 * removing the viewer from the referenced group — instantly closes access. A
 * `group` audience resolves to the group's CURRENT members at read time, so
 * editing the circle immediately changes who sees existing shares; a group that
 * has been deleted resolves to nobody (fail-closed, §6.9).
 */
export const SHARE_AUDIENCES = [
  'private',
  'specific_friends',
  'group',
  'all_friends',
  'public_link',
] as const;
export const shareAudienceSchema = z.enum(SHARE_AUDIENCES);
export type ShareAudience = z.infer<typeof shareAudienceSchema>;

/**
 * The recipient-bearing parts of an audience selection. Keeping this shape in
 * contracts lets the API and every client use the exact same privacy decision
 * before an audience mutation is submitted or accepted.
 */
export interface AudienceSelection {
  audience: ShareAudience;
  friendIds?: readonly string[];
  groupId?: string | null;
}

export type AudienceTransition = 'same' | 'narrowing' | 'widening';

const AUDIENCE_RANK: Record<ShareAudience, number> = {
  private: 0,
  specific_friends: 1,
  group: 2,
  all_friends: 3,
  public_link: 4,
};

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Classify one audience change against the privacy lattice.
 *
 * Most rungs are totally ordered. The recipient-bearing branches need extra
 * care: adding/replacing a specifically named friend widens even though the
 * enum value is unchanged, changing groups replaces one live roster with
 * another, and moving from a group to a specific-friends set is a cross-branch
 * replacement rather than a provable narrowing. Removing named friends is a
 * genuine narrowing and stays friction-free.
 */
export function classifyAudienceTransition(
  current: AudienceSelection,
  next: AudienceSelection,
): AudienceTransition {
  if (current.audience === next.audience) {
    if (current.audience === 'specific_friends') {
      const currentIds = new Set(current.friendIds ?? []);
      const nextIds = new Set(next.friendIds ?? []);
      if (sameIds(currentIds, nextIds)) return 'same';
      return [...nextIds].every((id) => currentIds.has(id)) ? 'narrowing' : 'widening';
    }
    if (current.audience === 'group') {
      return current.groupId === next.groupId ? 'same' : 'widening';
    }
    return 'same';
  }

  // These two recipient models are not subsets of one another without resolving
  // a live group roster. Replacing either branch can expose the item to someone
  // new, so both directions require explicit confirmation.
  if (
    (current.audience === 'specific_friends' && next.audience === 'group') ||
    (current.audience === 'group' && next.audience === 'specific_friends')
  ) {
    return 'widening';
  }

  return AUDIENCE_RANK[next.audience] > AUDIENCE_RANK[current.audience] ? 'widening' : 'narrowing';
}

export function audienceTransitionRequiresConfirmation(
  current: AudienceSelection,
  next: AudienceSelection,
): boolean {
  return classifyAudienceTransition(current, next) === 'widening';
}
