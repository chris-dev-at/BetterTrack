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
 * Ownership transfer (design §5/§7): the target becomes owner, the old owner
 * becomes a plain member. `via` marks a succession triggered by owner account
 * deletion (design §7 worked example) rather than an explicit transfer.
 */
const ownerTransferredPayload = z
  .object({
    opVersion: mirrorOpVersionSchema,
    kind: z.literal('owner.transferred'),
    fromUserId: z.string().uuid(),
    fromUsername: z.string(),
    toUserId: z.string().uuid(),
    toUsername: z.string(),
    via: z.literal('account_deletion').optional(),
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
