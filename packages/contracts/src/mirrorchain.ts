import { z } from 'zod';

/**
 * MIRRORCHAIN — group portfolios (PROJECTPLAN §13.5 V5-P7;
 * `docs/mirrorchain-design.md` §§1–3, binding). A chain is ONE logical
 * portfolio materialized as a real portfolio row (a "copy") in every member's
 * account; any member's write is recorded as a **full-state, totally-ordered
 * op** in the per-chain oplog and re-applied to every other copy through the
 * normal service layer. This module is M1's contract half (§12): the op payload
 * schemas (all carrying `opVersion: 1` for forward evolution), the additive
 * per-row DTO fields (`mirror.version` + attribution chip), and the reserved
 * `sync:mirrorchain` source tag. No behavior — replication, append and lifecycle
 * land in M2–M4.
 *
 * The `sync:mirrorchain` tag is the reserved `sync:<slug>` (already admitted by
 * `sourceTagSchema` in `portfolio.ts` — untouched here) that every **replica**
 * copy stamps on synced ledger rows, so "show synced rows" stays filterable per
 * copy with zero new columns (design §2). The **origin** copy keeps the tag of
 * its real write path (`manual` / `import:<broker>` / `standing-order`); that
 * origin tag rides in the op payload's `originSource` for the activity feed.
 */
export const SOURCE_TAG_SYNC_MIRRORCHAIN = 'sync:mirrorchain';

/**
 * Op payload version. Every op payload carries `opVersion: 1`; a future schema
 * change bumps this and branches on it rather than mutating a released shape
 * (the oplog is retained forever, so old payloads must always stay readable).
 */
export const MIRROR_OP_VERSION = 1;
export const mirrorOpVersionSchema = z.literal(MIRROR_OP_VERSION);

/** Env-tunable cap on active members per chain (design §4, bounded fan-out). */
export const MIRROR_MAX_MEMBERS = 16;

// --- Error codes (M2, design §§2–3) -----------------------------------------

/**
 * Stale-edit refusal (design §3): a mutating op's `baseSeq` no longer matches
 * the entity's latest op seq — the client refetches and re-submits against
 * fresh data. HTTP 409.
 */
export const MIRROR_CONFLICT = 'MIRROR_CONFLICT';
/**
 * Terminal-delete refusal (design §3): the targeted `mirror_id`'s latest op is
 * a `*.delete` — a deleted logical entity is never resurrected. HTTP 409.
 */
export const MIRROR_ROW_DELETED = 'MIRROR_ROW_DELETED';
/**
 * The acting member's own copy could not catch up on pending earlier ops
 * (a stalled apply — bug-level), so the write is refused rather than applied
 * out of order (design §2). HTTP 503.
 */
export const MIRROR_SYNC_STALLED = 'MIRROR_SYNC_STALLED';
/**
 * A write into a synced copy references a per-user custom asset (design §10:
 * members never see each other's custom assets, so the op could never apply on
 * any other copy). Custom assets live in non-chain portfolios. HTTP 400.
 */
export const MIRROR_ASSET_NOT_SYNCABLE = 'MIRROR_ASSET_NOT_SYNCABLE';

// --- Enumerations (mirror the DB enums in apps/api schema) ------------------

export const MIRROR_CHAIN_STATUSES = ['active', 'dissolved'] as const;
export const mirrorChainStatusSchema = z.enum(MIRROR_CHAIN_STATUSES);
export type MirrorChainStatus = z.infer<typeof mirrorChainStatusSchema>;

export const MIRROR_MEMBER_ROLES = ['owner', 'manager', 'member'] as const;
export const mirrorMemberRoleSchema = z.enum(MIRROR_MEMBER_ROLES);
export type MirrorMemberRole = z.infer<typeof mirrorMemberRoleSchema>;

export const MIRROR_MEMBER_STATUSES = [
  'active',
  'left',
  'removed',
  'dissolved',
  'account_deleted',
] as const;
export const mirrorMemberStatusSchema = z.enum(MIRROR_MEMBER_STATUSES);
export type MirrorMemberStatus = z.infer<typeof mirrorMemberStatusSchema>;

export const MIRROR_INVITE_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'revoked',
  'expired',
] as const;
export const mirrorInviteStatusSchema = z.enum(MIRROR_INVITE_STATUSES);
export type MirrorInviteStatus = z.infer<typeof mirrorInviteStatusSchema>;

export const MIRROR_ROW_KINDS = [
  'transaction',
  'dividend',
  'cash_movement',
  'cash_source',
] as const;
export const mirrorRowKindSchema = z.enum(MIRROR_ROW_KINDS);
export type MirrorRowKind = z.infer<typeof mirrorRowKindSchema>;

// --- Op kinds ---------------------------------------------------------------

/**
 * Ledger ops (design §2) — applied per copy through the copy's own services, so
 * every copy derives its own side effects (cash legs, tax movements) locally.
 * External cash movements are append-only (no movement edit/delete surface), so
 * the only cash "corrections" are new deposits/withdrawals.
 */
export const MIRROR_LEDGER_OP_KINDS = [
  'tx.create',
  'tx.update',
  'tx.delete',
  'dividend.record',
  'dividend.delete',
  'cash.deposit',
  'cash.withdraw',
  'cash.transfer',
  'cash.setBalance',
  'source.create',
  'source.rename',
  'source.archive',
  'source.restore',
] as const;

/**
 * Chain / membership ops (design §2) — executed once against the chain tables at
 * append time; copies only advance their watermark past them (no per-copy data
 * apply). Roles are chain metadata, so a transfer/grant changes nothing on any
 * copy's books.
 */
export const MIRROR_CHAIN_OP_KINDS = [
  'chain.genesis',
  'chain.rename',
  'member.joined',
  'member.left',
  'member.removed',
  'role.granted',
  'role.revoked',
  'owner.transferred',
  'chain.dissolved',
] as const;

export const MIRROR_OP_KINDS = [...MIRROR_LEDGER_OP_KINDS, ...MIRROR_CHAIN_OP_KINDS] as const;
export const mirrorOpKindSchema = z.enum(MIRROR_OP_KINDS);
export type MirrorOpKind = z.infer<typeof mirrorOpKindSchema>;

// --- Shared payload field schemas -------------------------------------------

/** A stable logical entity identity across all copies (design §1). */
const mirrorIdSchema = z.string().uuid();

/**
 * Origin write-path tag carried in a create op so replicas can render "how it
 * was really entered" in the activity feed even though their own row is tagged
 * `sync:mirrorchain` (design §2). Mirrors `sourceTagSchema` without importing
 * portfolio.ts (out of scope for M1); the reserved `sync:<slug>` is also
 * accepted so a re-replicated forked row keeps a stable tag.
 */
export const mirrorOriginSourceSchema = z
  .string()
  .regex(
    /^(?:manual|standing-order|(?:import|sync):[a-z0-9][a-z0-9_-]*)$/,
    'originSource must be manual, standing-order, or import:<slug> / sync:<slug>',
  );

/**
 * A mutating op's optimistic-concurrency base (design §3): the seq of the entity's
 * latest op the client edited against. The append transaction refuses with
 * `409 MIRROR_CONFLICT` when the entity's current latest-op seq ≠ `baseSeq`.
 */
const baseSeqSchema = z.number().int().nonnegative();

const executedAtSchema = z.string().datetime();
const noteSchema = z.string().max(1000).nullable();
/** Positive EUR magnitude (the sign is assigned by op kind), full-precision. */
const amountEurSchema = z.number().positive().finite();

const cashSourceTypeSchema = z.enum(['bank', 'retirement', 'cash', 'custom']);
const transactionSideSchema = z.enum(['buy', 'sell']);

// --- Ledger op payloads (full-state) ----------------------------------------
//
// Edit payloads are FULL STATE, never field diffs (design §3): the highest-seq
// op ≤ a copy's watermark IS the entity's state, so a whole-op win can never
// manufacture a financial row no member reviewed. Tax entry is NOT replicated —
// each copy taxes a replicated write under ITS OWN mode at apply time (design
// §9) — so no tax fields appear here.

/**
 * Cash-link intent on a transaction op (M2 extension). The buy/sell cash legs
 * themselves stay copy-derived (design §1: derived rows are copy-scoped), but
 * WHETHER the trade funds from / pays into cash is part of the user's intent —
 * replicating it keeps external flows identical on every copy, preserving §8's
 * "balances skew by exactly the copy-local tax movements" invariant. Each copy
 * resolves `cashSourceMirrorId` to its OWN local source (null → its Main). A
 * bare source id on a sell without either flag names the tax settlement source
 * (V3-P4); copies whose tax mode is `none` ignore it.
 */
const txCashIntentFields = {
  payFromCash: z.boolean(),
  addProceedsToCash: z.boolean(),
  cashSourceMirrorId: mirrorIdSchema.nullable(),
} as const;

const txCreatePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('tx.create'),
    mirrorId: mirrorIdSchema,
    assetId: z.string().uuid(),
    side: transactionSideSchema,
    quantity: z.number().positive().finite(),
    price: z.number().nonnegative().finite(),
    fee: z.number().nonnegative().finite(),
    executedAt: executedAtSchema,
    note: noteSchema,
    allowUncovered: z.boolean(),
    uncoveredEntryPrice: z.number().nonnegative().finite().nullable(),
    ...txCashIntentFields,
    /**
     * Backdated pay-from-cash settlement (#378): each copy re-derives the leg
     * date under its own ledger, so a short copy dates the leg "today" rather
     * than dipping negative. Leg dates are TWR-internal, so per-copy variance
     * here never touches performance.
     */
    settleCashAsOfToday: z.boolean(),
    originSource: mirrorOriginSourceSchema,
  })
  .strict();

const txUpdatePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('tx.update'),
    mirrorId: mirrorIdSchema,
    baseSeq: baseSeqSchema,
    side: transactionSideSchema,
    quantity: z.number().positive().finite(),
    price: z.number().nonnegative().finite(),
    fee: z.number().nonnegative().finite(),
    executedAt: executedAtSchema,
    note: noteSchema,
    allowUncovered: z.boolean(),
    uncoveredEntryPrice: z.number().nonnegative().finite().nullable(),
    // Full state carries the (immutable) cash-link intent too, so the
    // tax-immutable correction path (design §2: delete + re-create) can rebuild
    // the row's cash leg on every copy.
    ...txCashIntentFields,
  })
  .strict();

const txDeletePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('tx.delete'),
    mirrorId: mirrorIdSchema,
    baseSeq: baseSeqSchema,
  })
  .strict();

const dividendRecordPayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('dividend.record'),
    mirrorId: mirrorIdSchema,
    assetId: z.string().uuid(),
    grossAmountEur: amountEurSchema,
    executedAt: executedAtSchema,
    // The chain-scoped cash source the dividend lands in, resolved per copy by
    // mirror id (design §8). Null → the copy's Main.
    cashSourceMirrorId: mirrorIdSchema.nullable(),
    note: noteSchema,
    originSource: mirrorOriginSourceSchema,
  })
  .strict();

const dividendDeletePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('dividend.delete'),
    mirrorId: mirrorIdSchema,
    baseSeq: baseSeqSchema,
  })
  .strict();

const cashMovementPayloadBase = {
  opVersion: mirrorOpVersionSchema,
  mirrorId: mirrorIdSchema,
  // Resolved per copy by mirror id; null → Main (design §8).
  sourceMirrorId: mirrorIdSchema.nullable(),
  amountEur: amountEurSchema,
  executedAt: executedAtSchema,
  note: noteSchema,
  originSource: mirrorOriginSourceSchema,
} as const;

const cashDepositPayload = z
  .object({ ...cashMovementPayloadBase, kind: z.literal('cash.deposit') })
  .strict();

const cashWithdrawPayload = z
  .object({ ...cashMovementPayloadBase, kind: z.literal('cash.withdraw') })
  .strict();

const cashTransferPayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('cash.transfer'),
    // One op, two legs — both minted leg mirror ids ride the payload (design §2).
    outMirrorId: mirrorIdSchema,
    inMirrorId: mirrorIdSchema,
    fromSourceMirrorId: mirrorIdSchema,
    toSourceMirrorId: mirrorIdSchema,
    amountEur: amountEurSchema,
    executedAt: executedAtSchema,
    note: noteSchema,
    originSource: mirrorOriginSourceSchema,
  })
  .strict();

/**
 * "Set balance to X" replicates as the **origin-computed signed delta** — a
 * plain deposit/withdrawal (design §8): flows stay identical on every copy, and
 * a tax-skewed copy honestly shows a balance ≠ X. `deltaEur` is signed and
 * nonzero (a no-op records nothing, so no op is appended).
 */
const cashSetBalancePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('cash.setBalance'),
    mirrorId: mirrorIdSchema,
    sourceMirrorId: mirrorIdSchema.nullable(),
    deltaEur: z
      .number()
      .finite()
      .refine((v) => v !== 0, 'deltaEur must be nonzero'),
    executedAt: executedAtSchema,
    note: noteSchema,
    originSource: mirrorOriginSourceSchema,
  })
  .strict();

const sourceCreatePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('source.create'),
    mirrorId: mirrorIdSchema,
    name: z.string().trim().min(1).max(120),
    type: cashSourceTypeSchema,
  })
  .strict();

const sourceRenamePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('source.rename'),
    mirrorId: mirrorIdSchema,
    baseSeq: baseSeqSchema,
    // Full state — name AND type (the local update surface relabels both).
    name: z.string().trim().min(1).max(120),
    type: cashSourceTypeSchema,
  })
  .strict();

const sourceArchivePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('source.archive'),
    mirrorId: mirrorIdSchema,
    baseSeq: baseSeqSchema,
  })
  .strict();

const sourceRestorePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('source.restore'),
    mirrorId: mirrorIdSchema,
    baseSeq: baseSeqSchema,
  })
  .strict();

// --- Chain / membership op payloads -----------------------------------------

const chainGenesisPayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('chain.genesis'),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

const chainRenamePayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('chain.rename'),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

/** Identity carried on a membership op — denormalized username survives deletion. */
const memberRefFields = {
  opVersion: mirrorOpVersionSchema,
  userId: z.string().uuid(),
  username: z.string(),
} as const;

const memberJoinedPayload = z
  .object({ ...memberRefFields, kind: z.literal('member.joined'), role: mirrorMemberRoleSchema })
  .strict();

const memberLeftPayload = z.object({ ...memberRefFields, kind: z.literal('member.left') }).strict();

const memberRemovedPayload = z
  .object({ ...memberRefFields, kind: z.literal('member.removed') })
  .strict();

const roleGrantedPayload = z
  .object({ ...memberRefFields, kind: z.literal('role.granted'), role: mirrorMemberRoleSchema })
  .strict();

const roleRevokedPayload = z
  .object({ ...memberRefFields, kind: z.literal('role.revoked') })
  .strict();

/**
 * How an `owner.transferred` op came about (design §5/§7). Absent → an explicit
 * owner-initiated transfer (M3). Present → automatic §7 succession: the owner
 * departed (account deletion / owner-leave / owner copy-deletion) and ownership
 * passed to the oldest manager, or the M4 repair sweep crowned a manager on an
 * ownerless chain (`from` is null there — no identifiable prior owner).
 */
export const MIRROR_OWNER_TRANSFER_VIA = [
  'account_deletion',
  'owner_left',
  'repair_sweep',
] as const;
export const mirrorOwnerTransferViaSchema = z.enum(MIRROR_OWNER_TRANSFER_VIA);
export type MirrorOwnerTransferVia = z.infer<typeof mirrorOwnerTransferViaSchema>;

/**
 * Ownership transfer (design §5/§7): the target becomes owner, the old owner
 * becomes a plain member. `via` marks an automatic §7 succession (owner
 * departure / repair sweep) rather than an explicit transfer; `fromUserId` /
 * `fromUsername` are null only when the repair sweep repaired an ownerless chain
 * (no prior owner to attribute).
 */
const ownerTransferredPayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('owner.transferred'),
    fromUserId: z.string().uuid().nullable(),
    fromUsername: z.string().nullable(),
    toUserId: z.string().uuid(),
    toUsername: z.string(),
    via: mirrorOwnerTransferViaSchema.optional(),
  })
  .strict();

const chainDissolvedPayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('chain.dissolved'),
    // Why the chain ended — an owner acting, or succession finding no manager.
    reason: z.enum(['owner_dissolved', 'no_manager_succession']),
  })
  .strict();

/**
 * The full op payload — a discriminated union over `kind`, every arm carrying
 * `opVersion: 1`. This is the wire shape persisted in `mirror_chain_ops.payload`
 * and replayed on every copy (design §§2–3).
 */
export const mirrorOpPayloadSchema = z.discriminatedUnion('kind', [
  txCreatePayload,
  txUpdatePayload,
  txDeletePayload,
  dividendRecordPayload,
  dividendDeletePayload,
  cashDepositPayload,
  cashWithdrawPayload,
  cashTransferPayload,
  cashSetBalancePayload,
  sourceCreatePayload,
  sourceRenamePayload,
  sourceArchivePayload,
  sourceRestorePayload,
  chainGenesisPayload,
  chainRenamePayload,
  memberJoinedPayload,
  memberLeftPayload,
  memberRemovedPayload,
  roleGrantedPayload,
  roleRevokedPayload,
  ownerTransferredPayload,
  chainDissolvedPayload,
]);
export type MirrorOpPayload = z.infer<typeof mirrorOpPayloadSchema>;

// --- Additive per-row DTO fields --------------------------------------------

/**
 * Attribution chip data (design §10/§11): who added a chain row, rendered as a
 * small actor chip in the transaction/dividend/cash lists. `userId` SET-NULLs on
 * account deletion while the denormalized `username` keeps rendering ("alice
 * (account deleted)"). Attribution is exposed only to viewers who are themselves
 * active chain members — a non-member viewer of a shared copy sees identity
 * stripped (enforced by the service in M5, not here).
 */
export const mirrorAttributionSchema = z
  .object({
    userId: z.string().uuid().nullable(),
    username: z.string(),
    profileIcon: z.string().nullable(),
  })
  .strict();
export type MirrorAttribution = z.infer<typeof mirrorAttributionSchema>;

/**
 * The additive `mirror` field a synced copy's ledger DTOs carry. `version` is the
 * seq of the last op that targeted this `mirrorId` — the stale-edit guard's
 * `baseSeq` source (design §3). **Optional/additive**: a non-synced portfolio's
 * rows omit it entirely, so existing clients are unaffected.
 */
export const mirrorRowInfoSchema = z
  .object({
    mirrorId: mirrorIdSchema,
    version: z.number().int().nonnegative(),
    addedBy: mirrorAttributionSchema,
  })
  .strict();
export type MirrorRowInfo = z.infer<typeof mirrorRowInfoSchema>;

// --- M3 error codes (membership lifecycle, design §§4–7) --------------------

/**
 * An invite requires an active friendship between inviter and invitee, checked
 * at send AND accept (design §4). Raised when they are not friends (or an
 * unfriend between send and accept voids the invite). HTTP 400.
 */
export const MIRROR_NOT_FRIENDS = 'MIRROR_NOT_FRIENDS';
/** The caller tried to invite themselves to the chain (design §4). HTTP 400. */
export const MIRROR_CANNOT_INVITE_SELF = 'MIRROR_CANNOT_INVITE_SELF';
/** The chain already has {@link MIRROR_MAX_MEMBERS} active members (design §4). HTTP 409. */
export const MIRROR_MEMBER_CAP_REACHED = 'MIRROR_MEMBER_CAP_REACHED';
/** A pending invite already exists for this (chain, invitee) (design §4). HTTP 409. */
export const MIRROR_INVITE_EXISTS = 'MIRROR_INVITE_EXISTS';
/** The invite is gone / not pending / not addressed to the caller. HTTP 404. */
export const MIRROR_INVITE_NOT_FOUND = 'MIRROR_INVITE_NOT_FOUND';
/** The caller's role does not permit this membership operation (the §5 matrix). HTTP 403. */
export const MIRROR_FORBIDDEN = 'MIRROR_FORBIDDEN';
/** The target of a role/kick/transfer op is not an active member of the chain. HTTP 404. */
export const MIRROR_MEMBER_NOT_FOUND = 'MIRROR_MEMBER_NOT_FOUND';
/**
 * @deprecated Retained for compatibility but no longer emitted since V5-P7 M4
 * (#684). This was the M3 sequencing stopgap: owner leave / owner copy-deletion
 * were refused (HTTP 409) until succession shipped. M4 replaced the refusal with
 * automatic §7 transfer-on-delete, so those endpoints now succeed.
 */
export const MIRROR_OWNER_TRANSFER_REQUIRED = 'MIRROR_OWNER_TRANSFER_REQUIRED';

// --- M3 request schemas (membership lifecycle) ------------------------------

/** Chain name — same bounds as the genesis/rename op payloads. */
const chainNameSchema = z.string().trim().min(1).max(120);

/** `POST /mirrorchain/chains` — "new group portfolio" (empty origin copy, §11). */
export const createMirrorChainRequestSchema = z.object({ name: chainNameSchema }).strict();
export type CreateMirrorChainRequest = z.infer<typeof createMirrorChainRequestSchema>;

/**
 * `POST /mirrorchain/chains/convert` — "make this a group portfolio" (§2 genesis).
 * The existing portfolio becomes the origin copy; `name` overrides the chain's
 * display name (defaults to the portfolio's current name).
 */
export const convertMirrorChainRequestSchema = z
  .object({ portfolioId: z.string().uuid(), name: chainNameSchema.optional() })
  .strict();
export type ConvertMirrorChainRequest = z.infer<typeof convertMirrorChainRequestSchema>;

/** `POST /mirrorchain/chains/:chainId/invites` — invite one friend (design §4). */
export const inviteMirrorMemberRequestSchema = z.object({ userId: z.string().uuid() }).strict();
export type InviteMirrorMemberRequest = z.infer<typeof inviteMirrorMemberRequestSchema>;

/**
 * `PATCH /mirrorchain/chains/:chainId/members/:userId/role` — grant (`manager`)
 * or revoke (`member`) chain-manage rights, owner-only (design §5). `owner` is
 * not assignable here; ownership moves only via transfer.
 */
export const setMirrorMemberRoleRequestSchema = z
  .object({ role: z.enum(['manager', 'member']) })
  .strict();
export type SetMirrorMemberRoleRequest = z.infer<typeof setMirrorMemberRoleRequestSchema>;

/** `POST /mirrorchain/chains/:chainId/transfer` — transfer ownership (design §5). */
export const transferMirrorOwnershipRequestSchema = z
  .object({ toUserId: z.string().uuid() })
  .strict();
export type TransferMirrorOwnershipRequest = z.infer<typeof transferMirrorOwnershipRequestSchema>;

/** `PATCH /mirrorchain/chains/:chainId` — rename the chain (owner + managers, §5). */
export const renameMirrorChainRequestSchema = z.object({ name: chainNameSchema }).strict();
export type RenameMirrorChainRequest = z.infer<typeof renameMirrorChainRequestSchema>;

/** `:chainId` path param. */
export const mirrorChainIdParamSchema = z.object({ chainId: z.string().uuid() }).strict();
export type MirrorChainIdParam = z.infer<typeof mirrorChainIdParamSchema>;

/** `:inviteId` path param. */
export const mirrorInviteIdParamSchema = z.object({ inviteId: z.string().uuid() }).strict();
export type MirrorInviteIdParam = z.infer<typeof mirrorInviteIdParamSchema>;

/** `:chainId/:userId` path param (role change / kick). */
export const mirrorMemberParamSchema = z
  .object({ chainId: z.string().uuid(), userId: z.string().uuid() })
  .strict();
export type MirrorMemberParam = z.infer<typeof mirrorMemberParamSchema>;

/** `GET /mirrorchain/chains/:chainId/activity?before=&limit=` — oplog page. */
export const mirrorActivityQuerySchema = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type MirrorActivityQuery = z.infer<typeof mirrorActivityQuerySchema>;

// --- M3 read-model DTOs (chain summary, members, invites, activity) ---------

/**
 * A copy's sync progress (design §4 "Syncing… n %"): `percent` = applied/last
 * (100 when `lastSeq` is 0 or caught up). `synced` is the caught-up flag the
 * switcher badge reads.
 */
export const mirrorSyncStateSchema = z
  .object({
    appliedSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    percent: z.number().int().min(0).max(100),
    synced: z.boolean(),
  })
  .strict();
export type MirrorSyncState = z.infer<typeof mirrorSyncStateSchema>;

/**
 * One member as the member sheet renders them (design §10/§11): username +
 * profile icon + role + join date + this copy's sync state. `userId` is null
 * for an account-deleted member (username keeps the "alice (account deleted)"
 * rendering). Absolute amounts / other portfolios are never exposed (§10).
 */
export const mirrorMemberSchema = z
  .object({
    userId: z.string().uuid().nullable(),
    username: z.string(),
    profileIcon: z.string().nullable(),
    role: mirrorMemberRoleSchema,
    joinedAt: z.string().datetime(),
    isSelf: z.boolean(),
    sync: mirrorSyncStateSchema,
  })
  .strict();
export type MirrorMember = z.infer<typeof mirrorMemberSchema>;

/**
 * A chain summary for the caller — one per active membership (the portfolio
 * switcher's group-portfolio rows). `role` is the caller's; `sync` is the
 * caller's copy's progress.
 */
export const mirrorChainSummarySchema = z
  .object({
    chainId: z.string().uuid(),
    name: z.string(),
    status: mirrorChainStatusSchema,
    /** The caller's copy (null only if their portfolio was deleted). */
    portfolioId: z.string().uuid().nullable(),
    role: mirrorMemberRoleSchema,
    memberCount: z.number().int().nonnegative(),
    sync: mirrorSyncStateSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type MirrorChainSummary = z.infer<typeof mirrorChainSummarySchema>;

export const mirrorChainListResponseSchema = z
  .object({ chains: z.array(mirrorChainSummarySchema) })
  .strict();
export type MirrorChainListResponse = z.infer<typeof mirrorChainListResponseSchema>;

/** The member sheet (design §11): the chain header + the caller's role + the roster. */
export const mirrorMemberListResponseSchema = z
  .object({
    chainId: z.string().uuid(),
    name: z.string(),
    status: mirrorChainStatusSchema,
    /** The caller's own role — the client gates the management actions on it. */
    role: mirrorMemberRoleSchema,
    memberCap: z.number().int().positive(),
    members: z.array(mirrorMemberSchema),
  })
  .strict();
export type MirrorMemberListResponse = z.infer<typeof mirrorMemberListResponseSchema>;

/** One pending invite, in either direction (design §4 + the Social request list). */
export const mirrorInviteSchema = z
  .object({
    id: z.string().uuid(),
    chainId: z.string().uuid(),
    chainName: z.string(),
    fromUsername: z.string().nullable(),
    toUsername: z.string(),
    direction: z.enum(['incoming', 'outgoing']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MirrorInvite = z.infer<typeof mirrorInviteSchema>;

export const mirrorInviteListResponseSchema = z
  .object({
    incoming: z.array(mirrorInviteSchema),
    outgoing: z.array(mirrorInviteSchema),
  })
  .strict();
export type MirrorInviteListResponse = z.infer<typeof mirrorInviteListResponseSchema>;

/** The response to accepting an invite — the freshly materialized copy (§4). */
export const mirrorAcceptInviteResponseSchema = z
  .object({ chainId: z.string().uuid(), portfolioId: z.string().uuid() })
  .strict();
export type MirrorAcceptInviteResponse = z.infer<typeof mirrorAcceptInviteResponseSchema>;

/**
 * One activity-feed entry (design §6/§11): the oplog rendered per the caller's
 * copy. `summary` is a rendered EN sentence (the client localizes chrome, not
 * the historical record). Membership + ledger ops both appear.
 */
export const mirrorActivityEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    kind: mirrorOpKindSchema,
    actorUsername: z.string(),
    summary: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MirrorActivityEntry = z.infer<typeof mirrorActivityEntrySchema>;

export const mirrorActivityResponseSchema = z
  .object({
    entries: z.array(mirrorActivityEntrySchema),
    /** Seq to pass as `before` for the next (older) page; null at the start of the log. */
    nextCursor: z.number().int().positive().nullable(),
  })
  .strict();
export type MirrorActivityResponse = z.infer<typeof mirrorActivityResponseSchema>;
