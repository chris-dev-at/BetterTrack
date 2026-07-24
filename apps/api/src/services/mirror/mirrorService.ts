import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  MIRROR_ASSET_NOT_SYNCABLE,
  MIRROR_CANNOT_INVITE_SELF,
  MIRROR_CHAIN_OP_KINDS,
  MIRROR_CONFLICT,
  MIRROR_FORBIDDEN,
  MIRROR_INVITE_EXISTS,
  MIRROR_INVITE_NOT_FOUND,
  MIRROR_MAX_MEMBERS,
  MIRROR_MEMBER_CAP_REACHED,
  MIRROR_MEMBER_NOT_FOUND,
  MIRROR_NOT_FRIENDS,
  MIRROR_OP_VERSION,
  MIRROR_ROW_DELETED,
  MIRROR_SYNC_STALLED,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  mirrorOpPayloadSchema,
  strippedMirrorAttribution,
  type CashEntryRequest,
  type CashMovementResponse,
  type CashTransferRequest,
  type CashTransferResponse,
  type CreateCashSourceRequest,
  type CreateDividendRequest,
  type CreateDividendResponse,
  type CashSource as CashSourceDto,
  type MirrorAcceptInviteResponse,
  type MirrorActivityEntry,
  type MirrorActivityResponse,
  type MirrorAttribution,
  type MirrorChainSummary,
  type MirrorInvite,
  type MirrorInviteListResponse,
  type MirrorMember,
  type MirrorMemberListResponse,
  type MirrorMemberRole,
  type MirrorOpKind,
  type MirrorSyncState,
  type MirrorOpPayload,
  type MirrorRowInfo,
  type MirrorRowKind,
  type PortfolioForkProvenance,
  type PortfolioMirrorBadge,
  type PortfolioSummary,
  type SetCashBalanceRequest,
  type SetCashBalanceResponse,
  type Transaction as TransactionDto,
  type TransactionInput,
  type UpdateCashSourceRequest,
  type UpdateTransactionRequest,
} from '@bettertrack/contracts';

import type {
  AppendOpInput,
  MirrorInviteDetailRow,
  MirrorMemberDetailRow,
  MirrorchainRepository,
} from '../../data/repositories/mirrorchainRepository';
import type { CashMovementRepository } from '../../data/repositories/cashMovementRepository';
import type { CashSourceRepository } from '../../data/repositories/cashSourceRepository';
import type { FriendshipRepository } from '../../data/repositories/friendshipRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { TaxRepository } from '../../data/repositories/taxRepository';
import type { TransactionRepository } from '../../data/repositories/transactionRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { MirrorChainMemberRow, MirrorChainOpRow, MirrorChainRow } from '../../data/schema';
import { ApiError, badRequest, forbidden, notFound } from '../../errors';
import type { EventBus, MirrorNotificationEvent } from '../../events';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import type { NotificationCenter } from '../notifications/notificationCenter';
import type { PortfolioService } from '../portfolio/portfolioService';
import type { TaxService } from '../tax/taxService';

/**
 * MIRRORCHAIN replication core (M2 — `docs/mirrorchain-design.md` §§1–3, §8–§9,
 * binding; PROJECTPLAN §13.5 V5-P7). A chain is ONE logical portfolio
 * materialized as a real portfolio row in every member's account; every content
 * write is an **op** in the per-chain, totally-ordered oplog, re-applied to
 * every other copy **through that member's own services** — never multi-copy
 * SQL, never row copies — so each copy derives its own side effects (cash legs,
 * tax movements) and per-copy books hold by construction (§9).
 *
 * ## The submit path (one member's write into a synced copy)
 *
 * Under a per-chain submit lock: (1) the origin copy catches up on any pending
 * earlier ops (strict seq order — refusing `503 MIRROR_SYNC_STALLED` when it
 * cannot, §2); (2) the §3 stale-edit guard runs (`baseSeq` vs the entity's
 * latest op seq → `409 MIRROR_CONFLICT`; a terminally-deleted entity →
 * `409 MIRROR_ROW_DELETED`); (3) the write applies to the origin copy through
 * the NORMAL service call — the origin's validation (oversell, solvency, source
 * state) is authoritative, and a rejected write appends nothing, so an
 * unappliable op can never poison the chain; (4) the op — full-state, carrying
 * the origin-minted `mirror_id` (= the origin row's local id, §1) — appends
 * under the `mirror_chains.last_seq` `UPDATE … RETURNING` row lock, which
 * re-checks membership and `baseSeq` in the SAME transaction (§2/§3 Case B);
 * (5) `mirror_rows` links, the per-copy `audit_log` row and the origin
 * watermark land; (6) `mirror.replicate` is enqueued.
 *
 * The design note's §2 lists append before origin apply; §1's rule that
 * `mirror_id` IS the origin row's local id mechanically requires the origin
 * service call (which mints that id) to run first, so the two steps swap inside
 * the same locked section — the per-chain submit lock keeps the origin's local
 * apply order identical to seq order, and the in-transaction append guards
 * remain the authoritative serialization for anything that bypasses the lock.
 *
 * ## Replication + join
 *
 * `replicateChain` walks every active membership and applies ops
 * `applied_seq+1 … last_seq` strictly in order, per copy, in **force mode**
 * (overdraw + zero-balance-archive gates waived, §2/§8), with idempotent per-op
 * effect (creates skip on an existing `mirror_rows` link; full-state updates
 * replay; deletes treat a missing row as done) and the watermark bump as the
 * last step. Each copy's replay runs under the SAME per-chain lock the submit
 * path holds (watermark re-read inside it), so there is exactly one applier
 * per copy at any moment — a replicate run can never race a submit's origin
 * catch-up into double-applying an op. Joining is the same mechanism: genesis
 * ops are synthesized at convert so a join is a plain oplog replay through the
 * joiner's services — one code path (§2).
 */

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
/** The replicate job can afford a longer wait than an interactive submit. */
const REPLICATE_LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 25;
/** Renew well inside the TTL — a long apply (join replay) must not outlive it. */
const LOCK_RENEW_INTERVAL_MS = LOCK_TTL_MS / 3;

/** Compare-and-delete / compare-and-expire: only ever release or renew OUR lock. */
const LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const LOCK_RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], tonumber(ARGV[2])) else return 0 end";

/** Ops whose presence as an entity's latest op make it terminally deleted (§3). */
const TERMINAL_KINDS = new Set<string>(['tx.delete', 'dividend.delete']);
const CHAIN_OP_KINDS = new Set<string>(MIRROR_CHAIN_OP_KINDS);

/** Suffix attempts for §1's collision rule (`Name (2)` …) on replicated names. */
const NAME_SUFFIX_ATTEMPTS = 9;

/**
 * Invites expire with the standard token hygiene — 30 days (design §4). Age is
 * measured off `created_at` (no `expires_at` column), so a stale pending invite
 * is rejected at accept, hidden from the invite lists, and no longer blocks a
 * re-invite; the daily `mirror.inviteCleanup` sweep retires the rows.
 */
export const MIRROR_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Payload<K extends MirrorOpPayload['kind']> = Extract<MirrorOpPayload, { kind: K }>;

export interface MirrorServiceDeps {
  repo: MirrorchainRepository;
  /** The copy-local write/read surface every apply routes through (§2/§9). */
  portfolio: PortfolioService;
  tax: Pick<TaxService, 'recordDividend' | 'deleteDividend' | 'getEffectiveSettings'>;
  portfolioRepo: Pick<PortfolioRepository, 'findByIdForUser' | 'assetsByIds'>;
  transactionRepo: Pick<TransactionRepository, 'findByIdForUser' | 'listForPortfolio'>;
  cashMovementRepo: Pick<CashMovementRepository, 'listForPortfolio'>;
  cashSourceRepo: Pick<
    CashSourceRepository,
    'getOrCreateMain' | 'findByIdForPortfolio' | 'listForPortfolio'
  >;
  taxRepo: Pick<TaxRepository, 'findByIdForPortfolio' | 'listForPortfolio'>;
  users: Pick<UserRepository, 'findById'>;
  /** Friends-only invite gate (design §4): an active friendship at send AND accept. */
  friendship: Pick<FriendshipRepository, 'areFriends'>;
  /** The membership-lifecycle notification emitter (the eight mirror.* types, §11). */
  notify: Pick<NotificationCenter, 'emit'>;
  /** Active-member cap per chain (design §4); defaults to {@link MIRROR_MAX_MEMBERS}. */
  maxMembers?: number;
  audit: Pick<AuditService, 'record'>;
  events: Pick<EventBus, 'publish'>;
  /** Backs the per-chain submit lock (SET NX PX); ioredis-mock under test. */
  redis: Redis;
  /**
   * Enqueue the durable `mirror.replicate` job for a chain. Production wires
   * the BullMQ queue with plain per-write enqueues — deliberately NO job-id
   * dedupe (BullMQ silently ignores an `add` whose id still exists in the
   * retained completed/failed sets, which would stop replication after the
   * first run); redundant jobs no-op cheaply off the watermark, serialized by
   * the per-chain lock inside {@link MirrorService.replicateChain}. Absent
   * under test — tests drive `replicateChain` synchronously (the snapshot
   * `requestRecompute` pattern).
   */
  enqueueReplicate?: (chainId: string) => Promise<void>;
  logger?: Logger;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

export interface ReplicateChainResult {
  /** Ops applied across all copies in this run (chain/membership ops excluded). */
  applied: number;
  /** Copies still behind `last_seq` after the run (late appends → re-enqueue). */
  lagging: number;
}

/**
 * What the M4 defense-in-depth repair sweep did (design §2 (a)/(b), §7 (0)). The
 * ownerless chains are auto-repaired via §7 succession; the two crash residuals
 * are surfaced (not auto-fixed) so an admin can act. The caller (the sweep job)
 * logs every finding to the admin Problems page.
 */
export interface MirrorConsistencySweepResult {
  /** (0) Active chains that were ownerless and were repaired via §7 succession. */
  ownerlessRepaired: Array<{
    chainId: string;
    outcome: 'transferred' | 'dissolved';
    /** The promoted manager's user id (transfer) — null when the chain dissolved. */
    newOwnerUserId: string | null;
  }>;
  /** (a) Origin-only mirror-linked rows whose `mirror_id` has no op. */
  danglingOriginRows: Array<{
    chainId: string;
    portfolioId: string;
    mirrorId: string;
    kind: MirrorRowKind;
  }>;
  /** (b) Copy-local transactions in an active synced copy with no mirror link. */
  orphanedLocalRows: Array<{ portfolioId: string; localId: string }>;
}

/** Bound on rows surfaced per crash-residual category in one sweep run. */
export const MIRROR_SWEEP_ROW_LIMIT = 500;

export interface MirrorService {
  /**
   * The active membership behind a synced copy, or null for a normal
   * portfolio — the §1 routing decision. Every submit method below falls
   * through to the plain service when this is null, so non-chain portfolios
   * stay byte-identical to today.
   */
  syncedMembership(portfolioId: string): Promise<MirrorChainMemberRow | null>;
  /**
   * Enrich a batch of portfolio summaries with the M5 chain badge (active
   * synced copies, design §11) and fork provenance line (formerly-synced
   * copies whose membership ended, design §6). Non-chain portfolios pass
   * through untouched (both optional fields absent). Called by the
   * portfolio-list read paths so the switcher / portfolio page can render
   * the avatar-stack + syncing state + "Forked from ⟨chain⟩" line without
   * a second round-trip.
   */
  enrichPortfolioSummaries(
    userId: string,
    summaries: readonly PortfolioSummary[],
  ): Promise<PortfolioSummary[]>;
  /**
   * Ledger DTO overlay for one copy (design §3/§10/§11): per-kind maps keyed
   * by the copy-local row id, so ledger read paths can attach `mirror` cheaply
   * by localId lookup. Non-synced portfolios short-circuit to empty maps.
   * `stripAttribution` swaps every `addedBy` for the generic "group member"
   * chip (design §10) — used when a non-member views a shared/public copy.
   */
  overlayForPortfolio(
    portfolioId: string,
    opts?: { stripAttribution?: boolean },
  ): Promise<{
    transactions: Map<string, MirrorRowInfo>;
    dividends: Map<string, MirrorRowInfo>;
    cashMovements: Map<string, MirrorRowInfo>;
    cashSources: Map<string, MirrorRowInfo>;
  }>;
  /**
   * "Make this portfolio a group portfolio" (§2 convert): creates the chain
   * with the caller as owner and their portfolio as the origin copy, and
   * synthesizes **genesis ops** — one per existing source / transaction /
   * dividend / external movement — so the oplog is complete from seq 1 and a
   * join is a plain replay. No HTTP surface in M2 (membership lifecycle is M3).
   */
  convertToChain(
    userId: string,
    portfolioId: string,
    opts?: { name?: string },
  ): Promise<{ chain: MirrorChainRow; member: MirrorChainMemberRow }>;
  /**
   * Materialize a member's copy (§2 join / §4 zero-config): auto-named copy
   * (collision-suffixed), Main auto-provisioned and mirror-linked (§8),
   * `applied_seq = 0`, `member.joined` appended. Content arrives via the
   * replicate job's replay — the caller (M3's invite-accept) never copies rows.
   */
  attachMemberCopy(
    chainId: string,
    userId: string,
    opts?: { role?: 'manager' | 'member'; invitedBy?: string },
  ): Promise<{ member: MirrorChainMemberRow; portfolioId: string }>;
  /**
   * The `mirror.replicate` job body: bring every active copy up to
   * `last_seq`, strictly in seq order, force mode, idempotent per op. One
   * copy's failure never blocks the others (it lags — never diverges, §2);
   * any failure throws after the sweep so BullMQ retry/backoff → dead-letter
   * → the admin Problems page takes over.
   */
  replicateChain(chainId: string): Promise<ReplicateChainResult>;
  /**
   * Fire the `mirror.sync_stalled` notice for every copy still behind
   * `last_seq` (design §2/§11) — the stalled member AND the owner, deduped per
   * copy watermark. Called from the replicate job's PERMANENT-failure path
   * (retries exhausted → dead-letter), never on a transient blip, so it never
   * tells a member to "Retry sync" for a stall BullMQ is already healing.
   * Idempotent and best-effort: re-derives the lagging set from the DB.
   */
  notifyChainStalled(chainId: string): Promise<void>;

  // ── M3 membership lifecycle (design §§4–7, §11) ────────────────────────────
  /** "New group portfolio" (§11): a fresh empty portfolio becomes the origin copy. */
  createChain(userId: string, name: string): Promise<MirrorChainSummary>;
  /** "Make this a group portfolio" (§2 genesis) → the chain summary. */
  convertChain(
    userId: string,
    portfolioId: string,
    opts?: { name?: string },
  ): Promise<MirrorChainSummary>;
  /** The caller's active group-portfolio memberships as switcher summaries. */
  listChainsForUser(userId: string): Promise<MirrorChainSummary[]>;
  /** The member sheet (§11): roster + the caller's role. 404s a severed member (§6). */
  getMemberList(userId: string, chainId: string): Promise<MirrorMemberListResponse>;
  /** The activity feed (§6/§11): the oplog rendered per the caller's copy, paginated. */
  getActivity(
    userId: string,
    chainId: string,
    opts: { before?: number; limit: number },
  ): Promise<MirrorActivityResponse>;
  /** The caller's pending invites in + out (§4 + the Social request list). */
  listInvites(userId: string): Promise<MirrorInviteListResponse>;
  /** Invite a friend (owner + managers, §5); friends-only + cap + pending-unique (§4). */
  inviteMember(actorId: string, chainId: string, inviteeId: string): Promise<void>;
  /** Accept an invite (§4): re-check friendship, cap, then materialize the copy. */
  acceptInvite(userId: string, inviteId: string): Promise<MirrorAcceptInviteResponse>;
  /** Decline an invite (terminal; a later re-invite is allowed, §4). */
  declineInvite(userId: string, inviteId: string): Promise<void>;
  /** Revoke a pending invite (owner + managers, §4). */
  revokeInvite(actorId: string, inviteId: string): Promise<void>;
  /** Grant (`manager`) / revoke (`member`) manage rights — owner-only (§5). */
  setMemberRole(
    actorId: string,
    chainId: string,
    targetUserId: string,
    role: Exclude<MirrorMemberRole, 'owner'>,
  ): Promise<void>;
  /** Transfer ownership to an active member; the old owner becomes a member (§5). */
  transferOwnership(actorId: string, chainId: string, toUserId: string): Promise<void>;
  /** Kick a member → fork (§6): tombstone under the lock, copy freezes at its watermark. */
  removeMember(actorId: string, chainId: string, targetUserId: string): Promise<void>;
  /** Leave → fork (§6). Owner leave is refused with the §7 stopgap 409 until M4. */
  leaveChain(userId: string, chainId: string): Promise<void>;
  /** Rename the chain (owner + managers, §5) → the refreshed summary. */
  renameChain(actorId: string, chainId: string, name: string): Promise<MirrorChainSummary>;
  /** Dissolve the chain → every copy forks (owner-only, §6). */
  dissolveChain(actorId: string, chainId: string): Promise<void>;
  /**
   * Delete a portfolio through the mirror seam: a non-chain portfolio deletes
   * plainly; a synced copy is intercepted as leave-then-delete (§6) — for the
   * owner, the leave runs §7 succession first (M4), so no copy-delete is refused.
   */
  submitPortfolioDelete(userId: string, portfolioId: string): Promise<void>;

  /**
   * §7 deletion succession — the synchronous pre-delete hook the V4-P2c account
   * deletion pipeline and the admin delete both call BEFORE the user row is
   * removed (the same slot as session revocation). For each active membership of
   * the departing user: if they own the chain, ownership transfers to the oldest
   * active manager (or the chain dissolves with no manager, §7); then their
   * membership ends `account_deleted`. Every other copy + the chain stay intact;
   * the subsequent user-row delete cascades only the departing member's own copy
   * away, while SET NULL + denormalized usernames keep attribution rendering
   * ("alice (account deleted)"). Idempotent — a no-op once the user has no
   * active memberships.
   */
  handleAccountDeletion(userId: string): Promise<void>;

  /**
   * The M4 defense-in-depth repair sweep (design §2 (a)/(b), §7 (0)): re-applies
   * §7 succession to any active chain left ownerless behind the service, and
   * detects the two sub-transactional crash residuals for the caller to surface
   * on the admin Problems page. Returns what it repaired + detected.
   */
  runConsistencySweep(): Promise<MirrorConsistencySweepResult>;

  // ── The write-path seam (§1): portfolio-content writes route through these ──
  submitTransactionsCreate(
    userId: string,
    portfolioId: string,
    inputs: TransactionInput[],
    opts?: { source?: string },
  ): Promise<TransactionDto[]>;
  submitTransactionUpdate(
    userId: string,
    portfolioId: string,
    txId: string,
    patch: UpdateTransactionRequest,
    opts?: { baseSeq?: number },
  ): Promise<TransactionDto>;
  submitTransactionDelete(
    userId: string,
    portfolioId: string,
    txId: string,
    opts?: { baseSeq?: number },
  ): Promise<void>;
  submitDividendRecord(
    userId: string,
    portfolioId: string,
    input: CreateDividendRequest,
  ): Promise<CreateDividendResponse>;
  submitDividendDelete(
    userId: string,
    portfolioId: string,
    dividendId: string,
    opts?: { baseSeq?: number },
  ): Promise<void>;
  submitCashDeposit(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
  ): Promise<CashMovementResponse>;
  submitCashWithdraw(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
  ): Promise<CashMovementResponse>;
  submitCashTransfer(
    userId: string,
    portfolioId: string,
    input: CashTransferRequest,
  ): Promise<CashTransferResponse>;
  submitSetCashBalance(
    userId: string,
    portfolioId: string,
    sourceId: string,
    input: SetCashBalanceRequest,
  ): Promise<SetCashBalanceResponse>;
  submitSourceCreate(
    userId: string,
    portfolioId: string,
    input: CreateCashSourceRequest,
  ): Promise<CashSourceDto>;
  submitSourceUpdate(
    userId: string,
    portfolioId: string,
    sourceId: string,
    patch: UpdateCashSourceRequest,
    opts?: { baseSeq?: number },
  ): Promise<CashSourceDto>;
  submitSourceArchive(
    userId: string,
    portfolioId: string,
    sourceId: string,
    opts?: { baseSeq?: number },
  ): Promise<CashSourceDto>;
  submitSourceRestore(
    userId: string,
    portfolioId: string,
    sourceId: string,
    opts?: { baseSeq?: number },
  ): Promise<CashSourceDto>;
}

interface ApplyOutcome {
  /** False = the op's effect already exists on this copy (idempotent replay). */
  applied: boolean;
  rowKind?: MirrorRowKind;
  /** The copy-local row the op landed on (the audit target). */
  localId?: string;
  /** The underlying service call's return value (the submit path's DTO). */
  result?: unknown;
}

interface OpMeta {
  actorUserId: string | null;
  actorUsername: string;
  originPortfolioId: string | null;
}

function isApiError(err: unknown, ...codes: string[]): err is ApiError {
  return err instanceof ApiError && codes.includes(err.code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMirrorService(deps: MirrorServiceDeps): MirrorService {
  const {
    repo,
    portfolio,
    tax,
    portfolioRepo,
    transactionRepo,
    cashMovementRepo,
    cashSourceRepo,
    taxRepo,
    users,
    friendship,
    notify,
    audit,
    events,
    redis,
    logger,
  } = deps;
  const now = deps.now ?? Date.now;
  const maxMembers = deps.maxMembers ?? MIRROR_MAX_MEMBERS;

  // ── Infrastructure ─────────────────────────────────────────────────────────

  /**
   * Per-chain apply mutex — held by every submit AND by the replicate job's
   * per-copy replay, so there is exactly ONE applier per copy at any moment
   * (an unserialized replicate racing a submit's origin catch-up would let both
   * pass the create idempotency check and commit the same op twice). Also keeps
   * the origin's local apply order equal to seq order. The lock is token-fenced:
   * release and renewal are compare-and-set Lua (never touching another
   * holder's lock), and a heartbeat extends the TTL while `fn` runs so a long
   * replay cannot silently lose the lock mid-apply. The DB-level
   * `appendOpsChecked` guards stay authoritative for anything not holding it.
   */
  async function withChainLock<T>(
    chainId: string,
    fn: () => Promise<T>,
    waitMs: number = LOCK_WAIT_MS,
  ): Promise<T> {
    const key = `bt:mirror:submit:${chainId}`;
    const token = randomUUID();
    const deadline = now() + waitMs;
    for (;;) {
      const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
      if (acquired) break;
      if (now() > deadline) {
        throw new ApiError(
          503,
          'MIRROR_BUSY',
          'This group portfolio is busy applying another change. Try again shortly.',
        );
      }
      await sleep(LOCK_POLL_MS);
    }
    const renew = setInterval(() => {
      redis
        .eval(LOCK_RENEW_SCRIPT, 1, key, token, String(LOCK_TTL_MS))
        .then((extended) => {
          if (extended === 0) {
            logger?.warn({ chainId }, 'mirror: chain lock lost before renewal — TTL too tight?');
          }
        })
        .catch((err) => logger?.warn({ chainId, err }, 'mirror: chain lock renewal failed'));
    }, LOCK_RENEW_INTERVAL_MS);
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      try {
        const released = await redis.eval(LOCK_RELEASE_SCRIPT, 1, key, token);
        if (released === 0) {
          logger?.warn(
            { chainId },
            'mirror: chain lock expired before release — another applier may have entered',
          );
        }
      } catch (err) {
        logger?.warn({ chainId, err }, 'mirror: chain lock release failed');
      }
    }
  }

  /** Best-effort durable replicate enqueue — the write already succeeded. */
  async function scheduleReplicate(chainId: string): Promise<void> {
    try {
      await deps.enqueueReplicate?.(chainId);
    } catch (err) {
      logger?.error({ chainId, err }, 'mirror: failed to enqueue replicate job');
    }
  }

  async function usernameOf(userId: string): Promise<string> {
    const user = await users.findById(userId);
    if (!user) throw notFound('User not found.', 'USER_NOT_FOUND');
    return user.username;
  }

  /** The caller's own active membership behind a synced copy, else null (§1). */
  async function membershipForWrite(
    userId: string,
    portfolioId: string,
  ): Promise<MirrorChainMemberRow | null> {
    const member = await repo.findActiveMembershipByPortfolio(portfolioId);
    return member && member.userId === userId ? member : null;
  }

  /** Resolve a chain-scoped source's copy-local row (design §8); null → Main. */
  async function resolveLocalSourceId(
    portfolioId: string,
    sourceMirrorId: string | null,
  ): Promise<string> {
    if (sourceMirrorId === null) {
      return (await cashSourceRepo.getOrCreateMain(portfolioId)).id;
    }
    const link = await repo.findMirrorRow('cash_source', sourceMirrorId, portfolioId);
    if (!link) {
      // Strict seq order guarantees the source.create op preceded — a missing
      // link is a bug-level inconsistency; stall visibly rather than misapply.
      throw new Error(`mirror: cash source ${sourceMirrorId} has no local link in ${portfolioId}`);
    }
    return link.localId;
  }

  /** A copy-local source id → its chain-wide mirror id (origin submit paths). */
  async function mirrorIdOfLocalSource(localSourceId: string): Promise<string> {
    const link = await repo.findMirrorRowByLocal('cash_source', localSourceId);
    if (!link) {
      throw new Error(`mirror: local cash source ${localSourceId} is not mirror-linked`);
    }
    return link.mirrorId;
  }

  /** Refuse ops on per-user custom assets (design §10 — unappliable elsewhere). */
  async function assertSyncableAssets(assetIds: string[], message?: string): Promise<void> {
    const rows = await portfolioRepo.assetsByIds([...new Set(assetIds)]);
    for (const row of rows) {
      if (row.ownerId !== null) {
        throw badRequest(
          message ??
            'Custom assets cannot be recorded in a group portfolio — other members cannot see them. Use one of your own portfolios.',
          MIRROR_ASSET_NOT_SYNCABLE,
        );
      }
    }
  }

  // ── The per-op apply machinery (origin mutations + every replica apply) ────

  /**
   * Apply one ledger op to one copy through that member's own services (§2).
   * `force` = replica mode (overdraw/zero-balance gates waived, lenient about
   * already-applied state); the origin applies its own new op with
   * `force: false`, so the origin's validation stays authoritative.
   */
  async function applyLedgerOp(
    member: MirrorChainMemberRow,
    meta: OpMeta,
    payload: MirrorOpPayload,
    force: boolean,
  ): Promise<ApplyOutcome> {
    const userId = member.userId;
    const portfolioId = member.portfolioId;
    if (!userId || !portfolioId) {
      throw new Error(`mirror: membership ${member.id} has no user/portfolio to apply to`);
    }
    // Replica rows are stamped `sync:mirrorchain`; the origin copy keeps the
    // real write path's tag, which rides the op as `originSource` (design §2).
    const isOrigin = meta.originPortfolioId === portfolioId;
    const syncTag =
      isOrigin && 'originSource' in payload && typeof payload.originSource === 'string'
        ? payload.originSource
        : SOURCE_TAG_SYNC_MIRRORCHAIN;

    switch (payload.kind) {
      case 'tx.create': {
        if (await repo.findMirrorRow('transaction', payload.mirrorId, portfolioId)) {
          return { applied: false };
        }
        const input = await txInputFromPayload(member, payload);
        const [dto] = await portfolio.createTransactions(userId, portfolioId, [input], {
          source: syncTag,
          force,
        });
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'transaction',
          mirrorId: payload.mirrorId,
          portfolioId,
          localId: dto!.id,
          createdBy: meta.actorUserId,
          createdByUsername: meta.actorUsername,
        });
        return { applied: true, rowKind: 'transaction', localId: dto!.id, result: dto };
      }

      case 'tx.update': {
        const link = await repo.findMirrorRow('transaction', payload.mirrorId, portfolioId);
        if (!link) return { applied: false }; // deleted under a bypassed guard — LWW keeps the delete
        const local = await transactionRepo.findByIdForUser(userId, link.localId);
        if (!local) {
          // A link without its row = the correction path's crash window (the
          // delete committed, the re-create didn't). Heal from the full-state
          // payload — the entity's create op carries its asset — rather than
          // skipping: a skip advances the watermark and the copy silently
          // loses the row forever (design §2).
          const createOp = await repo.firstOpForEntity(member.chainId, payload.mirrorId);
          const createPayload = createOp ? mirrorOpPayloadSchema.parse(createOp.payload) : null;
          if (createPayload?.kind !== 'tx.create') {
            throw new Error(
              `mirror: transaction ${payload.mirrorId} has a link but no create op in ${member.chainId}`,
            );
          }
          const input = await txInputFromPayload(member, {
            ...payload,
            assetId: createPayload.assetId,
          });
          const [dto] = await portfolio.createTransactions(userId, portfolioId, [input], {
            source: syncTag,
            force,
          });
          await repo.repointMirrorRow('transaction', payload.mirrorId, portfolioId, dto!.id);
          return { applied: true, rowKind: 'transaction', localId: dto!.id, result: dto };
        }
        const financial =
          local.side !== payload.side ||
          local.quantity !== payload.quantity ||
          local.price !== payload.price ||
          local.fee !== payload.fee ||
          local.executedAt.getTime() !== Date.parse(payload.executedAt) ||
          local.allowUncovered !== payload.allowUncovered ||
          (local.uncoveredEntryPrice ?? null) !== payload.uncoveredEntryPrice;
        const noteChanged = (local.note ?? null) !== payload.note;
        if (!financial && !noteChanged) return { applied: false }; // replay-idempotent
        if (!financial) {
          const dto = await portfolio.updateTransaction(userId, portfolioId, local.id, {
            note: payload.note,
          });
          return { applied: true, rowKind: 'transaction', localId: local.id, result: dto };
        }
        try {
          const dto = await portfolio.updateTransaction(userId, portfolioId, local.id, {
            side: payload.side,
            quantity: payload.quantity,
            price: payload.price,
            fee: payload.fee,
            executedAt: payload.executedAt,
            note: payload.note,
          });
          return { applied: true, rowKind: 'transaction', localId: local.id, result: dto };
        } catch (err) {
          // Tax-immutable / cash-linked rows: the sanctioned correction path —
          // delete + re-create through the services, tax re-derived append-only,
          // the mirror link re-pointed to the new local row (design §2).
          if (
            !isApiError(
              err,
              'TRANSACTION_TAXED',
              'TRANSACTION_CASH_LINKED',
              'TRANSACTION_AFFECTS_TAXED',
            )
          ) {
            throw err;
          }
          await portfolio.deleteTransaction(userId, portfolioId, local.id, { force });
          const input = await txInputFromPayload(member, { ...payload, assetId: local.assetId });
          const [dto] = await portfolio.createTransactions(userId, portfolioId, [input], {
            source: local.source, // the row keeps its tag through a correction
            force,
          });
          await repo.repointMirrorRow('transaction', payload.mirrorId, portfolioId, dto!.id);
          return { applied: true, rowKind: 'transaction', localId: dto!.id, result: dto };
        }
      }

      case 'tx.delete': {
        const link = await repo.findMirrorRow('transaction', payload.mirrorId, portfolioId);
        if (!link) return { applied: false }; // already done (§2 idempotency)
        try {
          await portfolio.deleteTransaction(userId, portfolioId, link.localId, { force });
        } catch (err) {
          if (!(force && isApiError(err, 'TRANSACTION_NOT_FOUND'))) throw err;
        }
        await repo.deleteMirrorRow('transaction', payload.mirrorId, portfolioId);
        return { applied: true, rowKind: 'transaction', localId: link.localId };
      }

      case 'dividend.record': {
        if (await repo.findMirrorRow('dividend', payload.mirrorId, portfolioId)) {
          return { applied: false };
        }
        const cashSourceId =
          payload.cashSourceMirrorId === null
            ? undefined
            : await resolveLocalSourceId(portfolioId, payload.cashSourceMirrorId);
        // No tax fields ride the op — this copy taxes the dividend under ITS
        // OWN mode at apply time (design §9).
        const res = await tax.recordDividend(
          userId,
          portfolioId,
          {
            assetId: payload.assetId,
            grossAmountEur: payload.grossAmountEur,
            executedAt: payload.executedAt,
            cashSourceId,
            note: payload.note,
          },
          { source: syncTag, force },
        );
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'dividend',
          mirrorId: payload.mirrorId,
          portfolioId,
          localId: res.dividend.id,
          createdBy: meta.actorUserId,
          createdByUsername: meta.actorUsername,
        });
        return { applied: true, rowKind: 'dividend', localId: res.dividend.id, result: res };
      }

      case 'dividend.delete': {
        const link = await repo.findMirrorRow('dividend', payload.mirrorId, portfolioId);
        if (!link) return { applied: false };
        try {
          await tax.deleteDividend(userId, portfolioId, link.localId, { force });
        } catch (err) {
          if (!(force && isApiError(err, 'DIVIDEND_NOT_FOUND'))) throw err;
        }
        await repo.deleteMirrorRow('dividend', payload.mirrorId, portfolioId);
        return { applied: true, rowKind: 'dividend', localId: link.localId };
      }

      case 'cash.deposit':
      case 'cash.withdraw': {
        if (await repo.findMirrorRow('cash_movement', payload.mirrorId, portfolioId)) {
          return { applied: false };
        }
        const sourceId = await resolveLocalSourceId(portfolioId, payload.sourceMirrorId);
        const entry: CashEntryRequest = {
          amountEur: payload.amountEur,
          sourceId,
          executedAt: payload.executedAt,
          note: payload.note,
        };
        const res =
          payload.kind === 'cash.deposit'
            ? await portfolio.depositCash(userId, portfolioId, entry, { source: syncTag })
            : await portfolio.withdrawCash(userId, portfolioId, entry, { source: syncTag, force });
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'cash_movement',
          mirrorId: payload.mirrorId,
          portfolioId,
          localId: res.movement.id,
          createdBy: meta.actorUserId,
          createdByUsername: meta.actorUsername,
        });
        return { applied: true, rowKind: 'cash_movement', localId: res.movement.id, result: res };
      }

      case 'cash.setBalance': {
        // Replicated as the ORIGIN-computed signed delta — a plain deposit/
        // withdrawal, so flows stay identical while a tax-skewed copy honestly
        // shows a balance ≠ the target (design §8). The origin copy records
        // through `setCashBalance` itself in the submit path; this arm only
        // runs on replicas (and on idempotent origin re-delivery, which skips).
        if (await repo.findMirrorRow('cash_movement', payload.mirrorId, portfolioId)) {
          return { applied: false };
        }
        const sourceId = await resolveLocalSourceId(portfolioId, payload.sourceMirrorId);
        const entry: CashEntryRequest = {
          amountEur: Math.abs(payload.deltaEur),
          sourceId,
          executedAt: payload.executedAt,
          note: payload.note,
        };
        const res =
          payload.deltaEur > 0
            ? await portfolio.depositCash(userId, portfolioId, entry, { source: syncTag })
            : await portfolio.withdrawCash(userId, portfolioId, entry, { source: syncTag, force });
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'cash_movement',
          mirrorId: payload.mirrorId,
          portfolioId,
          localId: res.movement.id,
          createdBy: meta.actorUserId,
          createdByUsername: meta.actorUsername,
        });
        return { applied: true, rowKind: 'cash_movement', localId: res.movement.id, result: res };
      }

      case 'cash.transfer': {
        if (await repo.findMirrorRow('cash_movement', payload.outMirrorId, portfolioId)) {
          return { applied: false };
        }
        const [fromSourceId, toSourceId] = await Promise.all([
          resolveLocalSourceId(portfolioId, payload.fromSourceMirrorId),
          resolveLocalSourceId(portfolioId, payload.toSourceMirrorId),
        ]);
        const res = await portfolio.transferCash(
          userId,
          portfolioId,
          {
            fromSourceId,
            toSourceId,
            amountEur: payload.amountEur,
            executedAt: payload.executedAt,
            note: payload.note,
          },
          { source: syncTag, force },
        );
        // One statement — a crash can never strand the pair half-linked.
        await repo.insertMirrorRows([
          {
            chainId: member.chainId,
            kind: 'cash_movement',
            mirrorId: payload.outMirrorId,
            portfolioId,
            localId: res.outgoing.id,
            createdBy: meta.actorUserId,
            createdByUsername: meta.actorUsername,
          },
          {
            chainId: member.chainId,
            kind: 'cash_movement',
            mirrorId: payload.inMirrorId,
            portfolioId,
            localId: res.incoming.id,
            createdBy: meta.actorUserId,
            createdByUsername: meta.actorUsername,
          },
        ]);
        return { applied: true, rowKind: 'cash_movement', localId: res.outgoing.id, result: res };
      }

      case 'source.create': {
        if (await repo.findMirrorRow('cash_source', payload.mirrorId, portfolioId)) {
          return { applied: false };
        }
        const dto = await createSourceWithSuffix(
          userId,
          portfolioId,
          { name: payload.name, type: payload.type },
          force,
        );
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'cash_source',
          mirrorId: payload.mirrorId,
          portfolioId,
          localId: dto.id,
          createdBy: meta.actorUserId,
          createdByUsername: meta.actorUsername,
        });
        return { applied: true, rowKind: 'cash_source', localId: dto.id, result: dto };
      }

      case 'source.rename': {
        const localId = await requireSourceLink(payload.mirrorId, portfolioId);
        const current = await cashSourceRepo.findByIdForPortfolio(portfolioId, localId);
        if (current && current.name === payload.name && current.type === payload.type) {
          return { applied: false }; // replay-idempotent (avoids suffix churn)
        }
        const dto = await renameSourceWithSuffix(
          userId,
          portfolioId,
          localId,
          { name: payload.name, type: payload.type },
          force,
        );
        return { applied: true, rowKind: 'cash_source', localId, result: dto };
      }

      case 'source.archive': {
        const localId = await requireSourceLink(payload.mirrorId, portfolioId);
        try {
          const dto = await portfolio.archiveCashSource(userId, portfolioId, localId, { force });
          return { applied: true, rowKind: 'cash_source', localId, result: dto };
        } catch (err) {
          if (force && isApiError(err, 'CASH_SOURCE_ALREADY_ARCHIVED')) return { applied: false };
          throw err;
        }
      }

      case 'source.restore': {
        const localId = await requireSourceLink(payload.mirrorId, portfolioId);
        try {
          const dto = await portfolio.restoreCashSource(userId, portfolioId, localId);
          return { applied: true, rowKind: 'cash_source', localId, result: dto };
        } catch (err) {
          if (force && isApiError(err, 'CASH_SOURCE_NOT_ARCHIVED')) return { applied: false };
          throw err;
        }
      }

      default:
        throw new Error(`mirror: unsupported ledger op kind ${(payload as { kind: string }).kind}`);
    }
  }

  async function requireSourceLink(mirrorId: string, portfolioId: string): Promise<string> {
    const link = await repo.findMirrorRow('cash_source', mirrorId, portfolioId);
    if (!link) {
      throw new Error(`mirror: cash source ${mirrorId} has no local link in ${portfolioId}`);
    }
    return link.localId;
  }

  /** Rebuild a copy-local {@link TransactionInput} from a full-state tx payload. */
  async function txInputFromPayload(
    member: MirrorChainMemberRow,
    payload: (Payload<'tx.create'> | Payload<'tx.update'>) & { assetId: string },
  ): Promise<TransactionInput> {
    const portfolioId = member.portfolioId!;
    const input: TransactionInput = {
      assetId: payload.assetId,
      side: payload.side,
      quantity: payload.quantity,
      price: payload.price,
      fee: payload.fee,
      executedAt: payload.executedAt,
      note: payload.note,
    };
    if (payload.side === 'sell' && payload.allowUncovered) {
      input.allowUncovered = true;
      if (payload.uncoveredEntryPrice !== null) {
        input.uncoveredEntryPrice = payload.uncoveredEntryPrice;
      }
    }
    if (payload.kind === 'tx.create' && payload.settleCashAsOfToday) {
      input.settleCashAsOfToday = true;
    }
    if (payload.payFromCash) input.payFromCash = true;
    if (payload.addProceedsToCash) input.addProceedsToCash = true;
    if (payload.cashSourceMirrorId !== null) {
      if (payload.payFromCash || payload.addProceedsToCash) {
        input.cashSourceId = await resolveLocalSourceId(portfolioId, payload.cashSourceMirrorId);
      } else if (payload.side === 'sell') {
        // A bare source id names the tax settlement source (V3-P4) — only
        // meaningful on copies whose OWN mode is active; a `none`-mode copy
        // would reject it (CASH_FLAG_MISMATCH), so it drops the hint (§9).
        const settings = await tax.getEffectiveSettings(member.userId!, portfolioId);
        if (settings.mode !== 'none') {
          input.cashSourceId = await resolveLocalSourceId(portfolioId, payload.cashSourceMirrorId);
        }
      }
    }
    return input;
  }

  /** Create a source, resolving §1's name collisions with a ` (2)`-style suffix. */
  async function createSourceWithSuffix(
    userId: string,
    portfolioId: string,
    input: CreateCashSourceRequest,
    force: boolean,
  ): Promise<CashSourceDto> {
    for (let attempt = 1; attempt <= NAME_SUFFIX_ATTEMPTS; attempt++) {
      const name = attempt === 1 ? input.name : `${input.name} (${attempt})`;
      try {
        return await portfolio.createCashSource(userId, portfolioId, { ...input, name });
      } catch (err) {
        if (!(force && isApiError(err, 'CASH_SOURCE_NAME_TAKEN'))) throw err;
      }
    }
    throw new Error(`mirror: could not find a free name for cash source "${input.name}"`);
  }

  async function renameSourceWithSuffix(
    userId: string,
    portfolioId: string,
    sourceId: string,
    patch: { name: string; type: CreateCashSourceRequest['type'] },
    force: boolean,
  ): Promise<CashSourceDto> {
    for (let attempt = 1; attempt <= NAME_SUFFIX_ATTEMPTS; attempt++) {
      const name = attempt === 1 ? patch.name : `${patch.name} (${attempt})`;
      try {
        return await portfolio.updateCashSource(userId, portfolioId, sourceId, {
          name,
          type: patch.type,
        });
      } catch (err) {
        if (!(force && isApiError(err, 'CASH_SOURCE_NAME_TAKEN'))) throw err;
      }
    }
    throw new Error(`mirror: could not find a free name for cash source "${patch.name}"`);
  }

  // ── Replay: catch a copy up in strict seq order (§2) ───────────────────────

  /**
   * Apply `ops` (ascending seq) to one copy, force mode, watermark bump last —
   * at-least-once delivery, exactly-once effect. Chain/membership ops only
   * advance the watermark. Writes the per-copy `audit_log` row for every
   * applied op (§2/§10) and publishes ONE `portfolio.changed` per affected copy.
   */
  async function applyOpsToMember(
    member: MirrorChainMemberRow,
    ops: MirrorChainOpRow[],
  ): Promise<number> {
    let watermark = member.appliedSeq;
    let appliedCount = 0;
    for (const op of ops) {
      if (op.seq <= watermark) continue;
      const payload = mirrorOpPayloadSchema.parse(op.payload);
      if (CHAIN_OP_KINDS.has(payload.kind)) {
        await repo.advanceWatermark(member.id, op.seq);
        watermark = op.seq;
        continue;
      }
      const meta: OpMeta = {
        actorUserId: op.actorUserId,
        actorUsername: op.actorUsername,
        originPortfolioId: op.originPortfolioId,
      };
      const outcome = await applyLedgerOp(member, meta, payload, true);
      if (outcome.applied) {
        await recordOpAudit(member, op, outcome);
        appliedCount++;
      }
      await repo.advanceWatermark(member.id, op.seq);
      watermark = op.seq;
    }
    if (appliedCount > 0 && member.userId && member.portfolioId) {
      await events.publish({
        type: 'portfolio.changed',
        userId: member.userId,
        portfolioId: member.portfolioId,
        occurredAt: new Date(now()).toISOString(),
      });
    }
    return appliedCount;
  }

  /** The per-copy audit row (§2/§10): actor = the acting member, target = the local row. */
  async function recordOpAudit(
    member: MirrorChainMemberRow,
    op: Pick<MirrorChainOpRow, 'seq' | 'kind' | 'actorUserId' | 'actorUsername' | 'chainId'>,
    outcome: ApplyOutcome,
  ): Promise<void> {
    await audit.record({
      actorId: op.actorUserId,
      action: AuditAction.MirrorOpApplied,
      targetType: outcome.rowKind ?? 'portfolio',
      targetId: outcome.localId ?? member.portfolioId,
      meta: {
        chainId: op.chainId,
        seq: op.seq,
        kind: op.kind,
        actorUsername: op.actorUsername,
        portfolioId: member.portfolioId,
      },
    });
  }

  /**
   * Bring the acting member's own copy up to date before their write applies —
   * apply order is sacred on every copy, including the origin (§2). Failure
   * refuses the write with `503 MIRROR_SYNC_STALLED` rather than applying out
   * of order. Returns the refreshed membership row.
   */
  async function catchUpOrigin(member: MirrorChainMemberRow): Promise<MirrorChainMemberRow> {
    const chain = await repo.getChain(member.chainId);
    if (!chain) throw new Error(`mirror: chain ${member.chainId} not found`);
    if (member.appliedSeq >= chain.lastSeq) return member;
    const pending = await repo.listOpsSince(member.chainId, member.appliedSeq);
    try {
      await applyOpsToMember(member, pending);
    } catch (err) {
      logger?.error(
        { chainId: member.chainId, memberId: member.id, err },
        'mirror: origin catch-up stalled — refusing the write',
      );
      throw new ApiError(
        503,
        MIRROR_SYNC_STALLED,
        'This group portfolio is still syncing earlier changes and cannot accept the write yet.',
      );
    }
    const refreshed = await repo.findActiveMembership(member.chainId, member.userId!);
    if (!refreshed) throw forbidden('You are no longer a member of this group portfolio.');
    return refreshed;
  }

  // ── Guard + append plumbing shared by the submit paths ─────────────────────

  /** The §3 stale-edit + terminal-delete pre-check (under the submit lock). */
  async function checkEntityGuard(
    chainId: string,
    mirrorId: string,
    suppliedBaseSeq: number | undefined,
  ): Promise<number> {
    const latest = await repo.latestOpForEntity(chainId, mirrorId);
    if (latest && TERMINAL_KINDS.has(latest.kind)) {
      throw new ApiError(
        409,
        MIRROR_ROW_DELETED,
        'This entry was deleted by another member. Refresh and try again.',
      );
    }
    const latestSeq = latest?.seq ?? 0;
    // Pre-M5-client compatibility fallback: a client that omits baseSeq
    // (e.g. an older UI build) gets last-writer-wins for this entry. The M5
    // web clients all send baseSeq off the row's mirror.version — new client
    // code MUST NOT rely on this fallback (that would be silent LWW, §3
    // forbids). Kept only so a stale tab does not 409 forever.
    const baseSeq = suppliedBaseSeq ?? latestSeq;
    if (baseSeq !== latestSeq) {
      throw new ApiError(
        409,
        MIRROR_CONFLICT,
        'Another member changed this entry in the meantime. Refresh and re-apply your edit.',
        { expectedSeq: baseSeq, actualSeq: latestSeq },
      );
    }
    return baseSeq;
  }

  /**
   * Append the submit's op(s) with the in-transaction guards, then write the
   * origin copy's audit rows and advance its watermark past its own ops.
   */
  async function appendAndFinish(
    member: MirrorChainMemberRow,
    userId: string,
    ops: AppendOpInput[],
    outcomes: ApplyOutcome[],
  ): Promise<MirrorChainOpRow[]> {
    const result = await repo.appendOpsChecked(member.chainId, userId, ops);
    if ('refused' in result) {
      // Unreachable while every append routes through the submit lock; kept as
      // the authoritative backstop for lock-bypassing callers (design §2/§3).
      switch (result.refused) {
        case 'NOT_A_MEMBER':
          throw forbidden('You are no longer a member of this group portfolio.');
        case 'ROW_DELETED':
          throw new ApiError(409, MIRROR_ROW_DELETED, 'This entry was deleted by another member.');
        case 'CONFLICT':
          throw new ApiError(
            409,
            MIRROR_CONFLICT,
            'Another member changed this entry in the meantime. Refresh and re-apply your edit.',
            { expectedSeq: result.expectedSeq, actualSeq: result.actualSeq },
          );
      }
    }
    const appended = result.ops;
    for (let i = 0; i < appended.length; i++) {
      const outcome = outcomes[i];
      if (outcome?.applied) await recordOpAudit(member, appended[i]!, outcome);
    }
    const last = appended[appended.length - 1];
    if (last) await repo.advanceWatermark(member.id, last.seq);
    return appended;
  }

  // ── M3 membership lifecycle helpers (design §§4–7, §11) ────────────────────

  /**
   * The §5 authority matrix, encoded once. Kick splits by the TARGET's role
   * (`kick_member` vs `kick_manager`), which the caller resolves. `leave`
   * excludes the owner (the §7 succession stopgap refuses owner leave until M4);
   * ledger writes are every member's right and are checked in the submit paths.
   */
  type MembershipCapability =
    | 'invite'
    | 'kick_member'
    | 'kick_manager'
    | 'manage_roles'
    | 'rename'
    | 'transfer'
    | 'dissolve';

  function roleCan(role: MirrorMemberRole, capability: MembershipCapability): boolean {
    switch (capability) {
      case 'invite':
      case 'kick_member':
      case 'rename':
        return role === 'owner' || role === 'manager';
      case 'kick_manager':
      case 'manage_roles':
      case 'transfer':
      case 'dissolve':
        return role === 'owner';
    }
  }

  const mirrorForbidden = () =>
    new ApiError(
      403,
      MIRROR_FORBIDDEN,
      'Your role does not permit this action on the group portfolio.',
    );

  const chainNotFound = () => notFound('Group portfolio not found.', 'MIRROR_CHAIN_NOT_FOUND');

  /** Sync progress for a copy (design §4 "Syncing… n %"). */
  function syncStateOf(appliedSeq: number, lastSeq: number): MirrorSyncState {
    const synced = appliedSeq >= lastSeq;
    const percent = lastSeq <= 0 ? 100 : Math.min(100, Math.floor((appliedSeq / lastSeq) * 100));
    return { appliedSeq, lastSeq, percent, synced };
  }

  /**
   * Ledger DTO overlay for one copy (M5, design §3/§10/§11). Returns per-kind
   * maps keyed by the copy-local row id, so ledger read paths (transactions /
   * dividends / cash movements / cash sources) can attach `mirror` cheaply by
   * localId lookup. Non-synced portfolios short-circuit to empty maps —
   * enrichment then no-ops and the DTOs stay byte-identical to today (design
   * §1). `stripAttribution` (design §10): a non-member viewer of a shared/public
   * copy sees every actor replaced with the generic "group member" chip — a
   * member exposes their own book, never their co-members' identities.
   *
   * NOTE: no wire path exposes chain-copy ledger rows to non-members today —
   * `getSharedPortfolio` in the social service only ships holdings/history/
   * totals, never per-row DTOs. `stripAttribution` is a keystone the guard
   * relies on and the M5 unit tests exercise it directly, so a future
   * shared-ledger view can flip it on without touching the strip logic itself.
   */
  async function overlayForPortfolio(
    portfolioId: string,
    opts?: { stripAttribution?: boolean },
  ): Promise<{
    transactions: Map<string, MirrorRowInfo>;
    dividends: Map<string, MirrorRowInfo>;
    cashMovements: Map<string, MirrorRowInfo>;
    cashSources: Map<string, MirrorRowInfo>;
  }> {
    const result = {
      transactions: new Map<string, MirrorRowInfo>(),
      dividends: new Map<string, MirrorRowInfo>(),
      cashMovements: new Map<string, MirrorRowInfo>(),
      cashSources: new Map<string, MirrorRowInfo>(),
    };
    // Only synced copies have mirror-linked rows — skip the query for the
    // steady-state non-chain portfolio (the vast majority).
    const membership = await repo.findActiveMembershipByPortfolio(portfolioId);
    if (!membership) return result;
    const rows = await repo.listMirrorRowInfoForPortfolio(portfolioId);
    for (const row of rows) {
      const addedBy: MirrorAttribution = opts?.stripAttribution
        ? strippedMirrorAttribution
        : {
            userId: row.createdBy,
            username: row.createdByUsername,
            profileIcon: row.profileIcon,
          };
      const info: MirrorRowInfo = {
        mirrorId: row.mirrorId,
        version: row.latestSeq,
        addedBy,
      };
      switch (row.kind) {
        case 'transaction':
          result.transactions.set(row.localId, info);
          break;
        case 'dividend':
          result.dividends.set(row.localId, info);
          break;
        case 'cash_movement':
          result.cashMovements.set(row.localId, info);
          break;
        case 'cash_source':
          result.cashSources.set(row.localId, info);
          break;
      }
    }
    return result;
  }

  /**
   * Enrich a batch of portfolio summaries with the M5 chain badges (design §11)
   * + fork provenance line (design §6). One round-trip for the caller's active
   * memberships (badge) plus one for the ended memberships whose copy still
   * exists (fork). Non-chain portfolios stay byte-identical — the optional
   * fields simply don't appear.
   */
  async function enrichPortfolioSummaries(
    userId: string,
    summaries: readonly PortfolioSummary[],
  ): Promise<PortfolioSummary[]> {
    if (summaries.length === 0) return [...summaries];
    const [activeMemberships, forkMemberships] = await Promise.all([
      repo.listActiveMembershipsForUser(userId),
      repo.listForkMembershipsForUser(userId),
    ]);
    const activeByPortfolio = new Map<string, (typeof activeMemberships)[number]>();
    for (const m of activeMemberships) {
      if (m.portfolioId) activeByPortfolio.set(m.portfolioId, m);
    }
    const chainCache = new Map<string, Awaited<ReturnType<typeof repo.getChain>>>();
    const memberCountCache = new Map<string, number>();
    async function getChainCached(chainId: string) {
      if (chainCache.has(chainId)) return chainCache.get(chainId)!;
      const chain = await repo.getChain(chainId);
      chainCache.set(chainId, chain);
      return chain;
    }
    async function getMemberCountCached(chainId: string) {
      if (memberCountCache.has(chainId)) return memberCountCache.get(chainId)!;
      const n = await repo.countActiveMembers(chainId);
      memberCountCache.set(chainId, n);
      return n;
    }
    // Fork rows are ended_at DESC (repo); FIRST hit per portfolio wins — the
    // most recent tombstone is the current fork story. An active membership
    // for the same portfolio overrides (rejoined after leaving).
    const forkByPortfolio = new Map<string, PortfolioForkProvenance>();
    for (const m of forkMemberships) {
      if (!m.portfolioId || forkByPortfolio.has(m.portfolioId)) continue;
      if (activeByPortfolio.has(m.portfolioId)) continue;
      forkByPortfolio.set(m.portfolioId, {
        chainId: m.chainId,
        chainName: m.chainName,
        endedAt: (m.endedAt ?? new Date(now())).toISOString(),
      });
    }
    const out: PortfolioSummary[] = [];
    for (const summary of summaries) {
      const active = activeByPortfolio.get(summary.id);
      if (active) {
        const chain = await getChainCached(active.chainId);
        if (chain && chain.status === 'active') {
          const memberCount = await getMemberCountCached(chain.id);
          const badge: PortfolioMirrorBadge = {
            chainId: chain.id,
            chainName: chain.name,
            role: active.role,
            memberCount,
            sync: syncStateOf(active.appliedSeq, chain.lastSeq),
          };
          out.push({ ...summary, mirror: badge });
          continue;
        }
      }
      const fork = forkByPortfolio.get(summary.id);
      if (fork) {
        out.push({ ...summary, mirrorFork: fork });
        continue;
      }
      out.push(summary);
    }
    return out;
  }

  function toMirrorMember(
    row: MirrorMemberDetailRow,
    selfUserId: string,
    lastSeq: number,
  ): MirrorMember {
    return {
      userId: row.userId,
      username: row.username,
      profileIcon: row.profileIcon,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
      isSelf: row.userId === selfUserId,
      sync: syncStateOf(row.appliedSeq, lastSeq),
    };
  }

  function summaryOf(
    member: MirrorChainMemberRow,
    chain: MirrorChainRow,
    memberCount: number,
  ): MirrorChainSummary {
    return {
      chainId: chain.id,
      name: chain.name,
      status: chain.status,
      portfolioId: member.portfolioId,
      role: member.role,
      memberCount,
      sync: syncStateOf(member.appliedSeq, chain.lastSeq),
      createdAt: chain.createdAt.toISOString(),
    };
  }

  function toInviteDto(row: MirrorInviteDetailRow, selfUserId: string): MirrorInvite {
    return {
      id: row.id,
      chainId: row.chainId,
      chainName: row.chainName,
      fromUsername: row.fromUsername,
      toUsername: row.toUsername,
      direction: row.toUser === selfUserId ? 'incoming' : 'outgoing',
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Build + emit one mirror.* notification — fire-and-forget (design §11). */
  async function emitMirror(
    type: MirrorNotificationEvent['type'],
    recipientUserId: string,
    chain: { id: string; name: string },
    actorUsername: string,
    refId: string,
  ): Promise<void> {
    await notify.emit({
      type,
      userId: recipientUserId,
      chainId: chain.id,
      chainName: chain.name,
      actorUsername,
      refId,
      occurredAt: new Date(now()).toISOString(),
    });
  }

  /** The chain's current active owner (there is always ≤1 per §1's unique index). */
  function ownerOf(members: MirrorChainMemberRow[]): MirrorChainMemberRow | null {
    return members.find((m) => m.role === 'owner') ?? null;
  }

  /** An invite past the §4 30-day token-hygiene horizon (age off `created_at`). */
  function inviteExpired(invite: { createdAt: Date }): boolean {
    return now() - invite.createdAt.getTime() > MIRROR_INVITE_TTL_MS;
  }

  /** One activity-feed sentence per op kind (EN — the historical record, §6/§11). */
  function activitySummary(op: MirrorChainOpRow): string {
    const actor = op.actorUsername;
    switch (op.kind as MirrorOpKind) {
      case 'tx.create':
        return `${actor} added a transaction`;
      case 'tx.update':
        return `${actor} edited a transaction`;
      case 'tx.delete':
        return `${actor} deleted a transaction`;
      case 'dividend.record':
        return `${actor} recorded a dividend`;
      case 'dividend.delete':
        return `${actor} deleted a dividend`;
      case 'cash.deposit':
        return `${actor} deposited cash`;
      case 'cash.withdraw':
        return `${actor} withdrew cash`;
      case 'cash.transfer':
        return `${actor} transferred cash`;
      case 'cash.setBalance':
        return `${actor} set a cash balance`;
      case 'source.create':
        return `${actor} added a cash source`;
      case 'source.rename':
        return `${actor} renamed a cash source`;
      case 'source.archive':
        return `${actor} archived a cash source`;
      case 'source.restore':
        return `${actor} restored a cash source`;
      case 'chain.genesis':
        return `${actor} created the group portfolio`;
      case 'chain.rename':
        return `${actor} renamed the group portfolio`;
      case 'member.joined':
        return `${actor} joined`;
      case 'member.left':
        return `${actor} left`;
      case 'member.removed':
        return `${actor} removed a member`;
      case 'role.granted':
        return `${actor} was granted manage rights`;
      case 'role.revoked':
        return `${actor} had manage rights revoked`;
      case 'owner.transferred':
        return `${actor} transferred ownership`;
      case 'chain.dissolved':
        return `${actor} dissolved the group portfolio`;
      default:
        return `${actor} made a change`;
    }
  }

  /**
   * Run a membership mutation under the per-chain lock with the actor's role
   * re-read INSIDE the lock, so a role change and a membership op the design's
   * §5 race describes resolve by append order: whichever acquires the lock first
   * wins, and the loser re-reads the now-stale role and is refused. `check`
   * throws {@link mirrorForbidden} when the freshly-read role is insufficient.
   */
  async function withAuthorizedMember<T>(
    chainId: string,
    actorId: string,
    check: (member: MirrorChainMemberRow, members: MirrorChainMemberRow[]) => void,
    fn: (ctx: {
      chain: MirrorChainRow;
      actor: MirrorChainMemberRow;
      members: MirrorChainMemberRow[];
    }) => Promise<T>,
  ): Promise<T> {
    return withChainLock(chainId, async () => {
      const chain = await repo.getChain(chainId);
      if (!chain || chain.status !== 'active') throw chainNotFound();
      const members = await repo.listActiveMembers(chainId);
      const actor = members.find((m) => m.userId === actorId);
      if (!actor) throw forbidden('You are not a member of this group portfolio.');
      check(actor, members);
      return fn({ chain, actor, members });
    });
  }

  /** Append a chain/membership op as the authorized actor (already role-checked). */
  async function appendMembershipOp(
    chainId: string,
    actor: { userId: string | null; username: string },
    payload: MirrorOpPayload,
  ): Promise<MirrorChainOpRow[]> {
    return repo.appendOps(chainId, [
      {
        kind: payload.kind,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        payload,
      },
    ]);
  }

  type OwnerSuccessionResult =
    | { outcome: 'transferred'; newOwner: MirrorChainMemberRow }
    | { outcome: 'dissolved' };

  /**
   * §7 owner-succession, executed under the chain lock. `activeMembers` are the
   * chain's currently-active members with the departing owner ALREADY tombstoned
   * (so the ≤1-active-owner index never sees two owners). Promotes the
   * **earliest-joined active manager** to owner — tie broken by lowest user id,
   * both encoded in {@link MirrorchainRepository.listActiveMembers}'s ordering —
   * appending `owner.transferred` (actor = the departing owner, or `system` for
   * the repair sweep) with the given `via`; or, with no active manager, dissolves
   * the chain (append `chain.dissolved`, tombstone every remaining active member
   * `dissolved`, mark the chain `dissolved`). Notifies the remaining members.
   * `departing` is null only for the repair sweep (an ownerless chain has no
   * identifiable prior owner). The caller tombstones the departing owner's own
   * membership (with the right status) and appends its `member.left` op.
   */
  async function runOwnerSuccession(
    chain: MirrorChainRow,
    activeMembers: MirrorChainMemberRow[],
    departing: { userId: string; username: string } | null,
    via: 'account_deletion' | 'owner_left' | 'repair_sweep',
  ): Promise<OwnerSuccessionResult> {
    const actor = departing ?? { userId: null as string | null, username: 'system' };
    // listActiveMembers is ordered (joinedAt asc, userId asc), so the first
    // manager IS the earliest-joined (tie → lowest user id) — §7's rule.
    const manager = activeMembers.find((m) => m.role === 'manager') ?? null;
    if (manager) {
      await repo.updateMemberRole(manager.id, 'owner');
      const [op] = await appendMembershipOp(chain.id, actor, {
        opVersion: MIRROR_OP_VERSION,
        kind: 'owner.transferred',
        fromUserId: departing?.userId ?? null,
        fromUsername: departing?.username ?? null,
        toUserId: manager.userId!,
        toUsername: manager.username,
        via,
      });
      // Tell the remaining members ownership moved — skip the new owner (their
      // copy reads "⟨actor⟩ is now the owner", which self-named reads wrong) and
      // the departing owner. The op seq discriminates the notice (design §5).
      const refId = `${manager.userId}:${op!.seq}`;
      for (const m of activeMembers) {
        if (m.userId && m.userId !== manager.userId && m.userId !== departing?.userId) {
          await emitMirror(
            'mirror.ownership_transferred',
            m.userId,
            chain,
            manager.username,
            refId,
          );
        }
      }
      return { outcome: 'transferred', newOwner: manager };
    }
    // No manager volunteered stewardship → honest dissolution: every copy forks.
    const endedAt = new Date(now());
    for (const m of activeMembers) {
      await repo.endMembership(m.id, 'dissolved', endedAt);
    }
    await appendMembershipOp(chain.id, actor, {
      opVersion: MIRROR_OP_VERSION,
      kind: 'chain.dissolved',
      reason: 'no_manager_succession',
    });
    await repo.markChainDissolved(chain.id, endedAt);
    for (const m of activeMembers) {
      if (m.userId && m.userId !== departing?.userId) {
        await emitMirror('mirror.chain_dissolved', m.userId, chain, actor.username, chain.id);
      }
    }
    return { outcome: 'dissolved' };
  }

  // ── Public surface ─────────────────────────────────────────────────────────

  const service: MirrorService = {
    syncedMembership(portfolioId) {
      return repo.findActiveMembershipByPortfolio(portfolioId);
    },

    enrichPortfolioSummaries(userId, summaries) {
      return enrichPortfolioSummaries(userId, summaries);
    },

    overlayForPortfolio(portfolioId, opts) {
      return overlayForPortfolio(portfolioId, opts);
    },

    async convertToChain(userId, portfolioId, opts) {
      const row = await portfolioRepo.findByIdForUser(userId, portfolioId);
      if (!row) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      if (await repo.findActiveMembershipByPortfolio(portfolioId)) {
        throw badRequest('This portfolio is already a group portfolio.', 'MIRROR_ALREADY_SYNCED');
      }
      const username = await usernameOf(userId);
      const name = opts?.name?.trim() || row.name;
      // Main first, so the source listing below always contains it (§8).
      await cashSourceRepo.getOrCreateMain(portfolioId);
      const [sources, txns, dividends, movements] = await Promise.all([
        cashSourceRepo.listForPortfolio(portfolioId, { includeArchived: true }),
        transactionRepo.listForPortfolio(portfolioId),
        taxRepo.listForPortfolio(portfolioId),
        cashMovementRepo.listForPortfolio(portfolioId),
      ]);
      // Refuse per-user custom assets BEFORE the chain exists (design §10): a
      // genesis op for one would 404 on every joiner's copy and stall the join
      // replay at that seq forever — the same guard the steady-state submits
      // enforce, run here over the pre-existing history.
      await assertSyncableAssets(
        [...txns.map((t) => t.assetId), ...dividends.map((d) => d.assetId)],
        'This portfolio holds custom assets, which other members cannot see. Remove them (or use another portfolio) before making it a group portfolio.',
      );
      const chain = await repo.createChain({
        name,
        createdBy: userId,
        createdByUsername: username,
      });
      const member = await repo.insertMember({
        chainId: chain.id,
        userId,
        username,
        portfolioId,
        role: 'owner',
      });

      // Genesis (§2): the oplog is complete from seq 1 — one op per existing
      // source / transaction / dividend / external movement, actor = the
      // creator, mirror_id = the existing row id. Ordering within the batch is
      // replay-driven: sources first (movements resolve them), transactions
      // before dividends (the held-asset guard is date-blind, so a backdated
      // dividend must still find its asset transacted), money rows
      // chronological within their group, archive flips last (a movement can
      // never target an already-archived source mid-replay).
      const actor = {
        actorUserId: userId,
        actorUsername: username,
        originPortfolioId: portfolioId,
      };
      const ops: AppendOpInput[] = [
        {
          kind: 'chain.genesis',
          ...actor,
          payload: { opVersion: MIRROR_OP_VERSION, kind: 'chain.genesis', name },
        },
      ];
      const links: Array<{ kind: MirrorRowKind; id: string }> = [];

      const sortedSources = [...sources].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
      );
      const sourceCreateSeq = new Map<string, number>();
      for (const s of sortedSources) {
        sourceCreateSeq.set(s.id, ops.length + 1);
        ops.push({
          kind: 'source.create',
          mirrorId: s.id,
          ...actor,
          payload: {
            opVersion: MIRROR_OP_VERSION,
            kind: 'source.create',
            mirrorId: s.id,
            name: s.name,
            type: s.type,
          },
        });
        links.push({ kind: 'cash_source', id: s.id });
      }

      const byTime =
        <T>(at: (x: T) => Date, id: (x: T) => string) =>
        (a: T, b: T) =>
          at(a).getTime() - at(b).getTime() || id(a).localeCompare(id(b));

      const legsByTx = new Map<string, { buy: boolean; sell: boolean; sourceId: string | null }>();
      for (const m of movements) {
        if (!m.transactionId || (m.kind !== 'buy' && m.kind !== 'sell_proceeds')) continue;
        const entry = legsByTx.get(m.transactionId) ?? { buy: false, sell: false, sourceId: null };
        if (m.kind === 'buy') entry.buy = true;
        else entry.sell = true;
        entry.sourceId = m.sourceId;
        legsByTx.set(m.transactionId, entry);
      }
      for (const t of [...txns].sort(
        byTime(
          (x) => x.executedAt,
          (x) => x.id,
        ),
      )) {
        const legs = legsByTx.get(t.id);
        ops.push({
          kind: 'tx.create',
          mirrorId: t.id,
          ...actor,
          payload: {
            opVersion: MIRROR_OP_VERSION,
            kind: 'tx.create',
            mirrorId: t.id,
            assetId: t.assetId,
            side: t.side,
            quantity: t.quantity,
            price: t.price,
            fee: t.fee,
            executedAt: t.executedAt.toISOString(),
            note: t.note,
            allowUncovered: t.allowUncovered,
            uncoveredEntryPrice: t.uncoveredEntryPrice,
            payFromCash: legs?.buy ?? false,
            addProceedsToCash: legs?.sell ?? false,
            cashSourceMirrorId: legs?.sourceId ?? null,
            settleCashAsOfToday: false,
            originSource: t.source,
          },
        });
        links.push({ kind: 'transaction', id: t.id });
      }

      for (const d of [...dividends].sort(
        byTime(
          (x) => x.executedAt,
          (x) => x.id,
        ),
      )) {
        ops.push({
          kind: 'dividend.record',
          mirrorId: d.id,
          ...actor,
          payload: {
            opVersion: MIRROR_OP_VERSION,
            kind: 'dividend.record',
            mirrorId: d.id,
            assetId: d.assetId,
            grossAmountEur: d.grossAmountEur,
            executedAt: d.executedAt.toISOString(),
            cashSourceMirrorId: d.cashSourceId,
            note: d.note,
            originSource: d.source,
          },
        });
        links.push({ kind: 'dividend', id: d.id });
      }

      // External movements (design §1): hand-entered deposits/withdrawals and
      // transfers. Derived rows — buy/sell legs, dividend inflows, tax
      // settlements — are copy-scoped and re-derived per copy, never replicated.
      const external = movements.filter(
        (m) =>
          (m.kind === 'deposit' || m.kind === 'withdrawal') &&
          !m.transactionId &&
          !m.dividendId &&
          m.taxYear === null &&
          !m.transferId,
      );
      const transferOut = movements.filter((m) => m.kind === 'transfer_out' && m.transferId);
      type ExternalOp = { at: Date; id: string; op: AppendOpInput; linkIds: string[] };
      const externalOps: ExternalOp[] = external.map((m) => ({
        at: m.executedAt,
        id: m.id,
        linkIds: [m.id],
        op: {
          kind: m.kind === 'deposit' ? 'cash.deposit' : 'cash.withdraw',
          mirrorId: m.id,
          ...actor,
          payload: {
            opVersion: MIRROR_OP_VERSION,
            kind: m.kind === 'deposit' ? 'cash.deposit' : 'cash.withdraw',
            mirrorId: m.id,
            sourceMirrorId: m.sourceId,
            amountEur: Math.abs(m.amountEur),
            executedAt: m.executedAt.toISOString(),
            note: m.note,
            originSource: m.source,
          } as MirrorOpPayload,
        },
      }));
      for (const out of transferOut) {
        const inLeg = movements.find(
          (m) => m.kind === 'transfer_in' && m.transferId === out.transferId,
        );
        if (!inLeg) continue;
        externalOps.push({
          at: out.executedAt,
          id: out.id,
          linkIds: [out.id, inLeg.id],
          op: {
            kind: 'cash.transfer',
            mirrorId: out.id,
            ...actor,
            payload: {
              opVersion: MIRROR_OP_VERSION,
              kind: 'cash.transfer',
              outMirrorId: out.id,
              inMirrorId: inLeg.id,
              fromSourceMirrorId: out.sourceId,
              toSourceMirrorId: inLeg.sourceId,
              amountEur: Math.abs(out.amountEur),
              executedAt: out.executedAt.toISOString(),
              note: out.note,
              originSource: out.source,
            },
          },
        });
      }
      for (const e of externalOps.sort(
        byTime(
          (x) => x.at,
          (x) => x.id,
        ),
      )) {
        ops.push(e.op);
        for (const id of e.linkIds) links.push({ kind: 'cash_movement', id });
      }

      for (const s of sortedSources) {
        if (!s.archivedAt) continue;
        ops.push({
          kind: 'source.archive',
          mirrorId: s.id,
          ...actor,
          payload: {
            opVersion: MIRROR_OP_VERSION,
            kind: 'source.archive',
            mirrorId: s.id,
            baseSeq: sourceCreateSeq.get(s.id)!,
          },
        });
      }

      // Origin mirror links: on the origin copy local_id = mirror_id (§1).
      for (const link of links) {
        await repo.insertMirrorRow({
          chainId: chain.id,
          kind: link.kind,
          mirrorId: link.id,
          portfolioId,
          localId: link.id,
          createdBy: userId,
          createdByUsername: username,
        });
      }
      const appended = await repo.appendOps(chain.id, ops);
      // The origin's content pre-exists genesis — advance its watermark past it.
      const lastSeq = appended[appended.length - 1]?.seq ?? 0;
      if (lastSeq > 0) await repo.advanceWatermark(member.id, lastSeq);
      const refreshed = await repo.findActiveMembership(chain.id, userId);
      return { chain: (await repo.getChain(chain.id))!, member: refreshed ?? member };
    },

    async attachMemberCopy(chainId, userId, opts) {
      const chain = await repo.getChain(chainId);
      if (!chain || chain.status !== 'active') {
        throw notFound('Group portfolio not found.', 'MIRROR_CHAIN_NOT_FOUND');
      }
      if (await repo.findActiveMembership(chainId, userId)) {
        throw badRequest('Already a member of this group portfolio.', 'MIRROR_ALREADY_MEMBER');
      }
      const username = await usernameOf(userId);

      // The chain's Main identity: every copy's Main is linked to it (§8) —
      // derive it from any active member's copy (there is always ≥1).
      const existingMembers = await repo.listActiveMembers(chainId);
      const anchor = existingMembers.find((m) => m.portfolioId);
      if (!anchor?.portfolioId) {
        throw badRequest('This group portfolio has no active copies to join.', 'MIRROR_NO_MEMBERS');
      }
      const anchorMain = await cashSourceRepo.getOrCreateMain(anchor.portfolioId);
      const mainLink = await repo.findMirrorRowByLocal('cash_source', anchorMain.id);
      if (!mainLink) throw new Error(`mirror: chain ${chainId} has no linked Main source`);

      // Auto-created, auto-named copy with the §1 collision suffix (§4).
      let copyId: string | undefined;
      for (let attempt = 1; attempt <= NAME_SUFFIX_ATTEMPTS && !copyId; attempt++) {
        const name = attempt === 1 ? chain.name : `${chain.name} (${attempt})`;
        try {
          copyId = (await portfolio.createPortfolio(userId, { name })).id;
        } catch (err) {
          if (!isApiError(err, 'PORTFOLIO_NAME_TAKEN', 'CONFLICT')) throw err;
        }
      }
      if (!copyId) {
        throw new Error(`mirror: could not find a free portfolio name for "${chain.name}"`);
      }

      // Chain Main ↔ copy Main (§8): pre-linked so genesis' Main `source.create`
      // op replays as an idempotent skip — one code path, no special casing.
      const copyMain = await cashSourceRepo.getOrCreateMain(copyId);
      await repo.insertMirrorRow({
        chainId,
        kind: 'cash_source',
        mirrorId: mainLink.mirrorId,
        portfolioId: copyId,
        localId: copyMain.id,
        createdBy: chain.createdBy,
        createdByUsername: chain.createdByUsername,
      });

      const member = await repo.insertMember({
        chainId,
        userId,
        username,
        portfolioId: copyId,
        role: opts?.role ?? 'member',
        invitedBy: opts?.invitedBy ?? null,
      });
      const joined = await repo.appendOpsChecked(chainId, userId, [
        {
          kind: 'member.joined',
          actorUserId: userId,
          actorUsername: username,
          payload: {
            opVersion: MIRROR_OP_VERSION,
            kind: 'member.joined',
            userId,
            username,
            role: opts?.role ?? 'member',
          },
        },
      ]);
      if ('refused' in joined) {
        // The membership row was inserted just above, so any refusal here is a
        // bug-level inconsistency — fail loudly rather than leave a member
        // whose join never reached the oplog.
        throw new Error(
          `mirror: member.joined append refused (${joined.refused}) for chain ${chainId}`,
        );
      }
      // Join = plain oplog replay through the joiner's services (§2), driven by
      // the replicate job; the copy shows its syncing state via the watermark.
      await scheduleReplicate(chainId);
      return { member, portfolioId: copyId };
    },

    async replicateChain(chainId) {
      const chain = await repo.getChain(chainId);
      if (!chain) return { applied: 0, lagging: 0 };
      const members = await repo.listActiveMembers(chainId);
      let applied = 0;
      const failures: Array<{ memberId: string; err: unknown }> = [];
      for (const member of members) {
        if (!member.userId || !member.portfolioId) continue;
        if (member.appliedSeq >= chain.lastSeq) continue;
        try {
          // Each copy's replay holds the same per-chain lock the submit path
          // does — never a second applier next to a submit's origin catch-up.
          // The membership is re-read INSIDE the lock (the pre-lock rows are
          // only a cheap skip): a concurrent submit may have advanced this
          // copy's watermark while we waited.
          applied += await withChainLock(
            chainId,
            async () => {
              const fresh = await repo.findActiveMembership(chainId, member.userId!);
              if (!fresh?.portfolioId) return 0;
              const ops = await repo.listOpsSince(chainId, fresh.appliedSeq);
              return applyOpsToMember(fresh, ops);
            },
            REPLICATE_LOCK_WAIT_MS,
          );
        } catch (err) {
          // This copy lags (never diverges, §2) — the others still catch up.
          failures.push({ memberId: member.id, err });
          logger?.error(
            { chainId, memberId: member.id, userId: member.userId, err },
            'mirror: replica apply stalled',
          );
        }
      }
      const after = await repo.getChain(chainId);
      const membersAfter = await repo.listActiveMembers(chainId);
      const lagging = membersAfter.filter(
        (m) => m.userId && m.portfolioId && m.appliedSeq < (after?.lastSeq ?? 0),
      ).length;
      if (failures.length > 0) {
        // Throw AFTER the sweep so BullMQ retry/backoff → dead-letter takes over
        // (the other copies still caught up — a stalled copy lags, never
        // diverges, §2). The `mirror.sync_stalled` notice is NOT fired here: on
        // every attempt this branch runs, and a transient blip heals on retry —
        // so the job wires `notifyChainStalled` off its PERMANENT-failure path
        // (retries exhausted) instead, never crying wolf on a self-healing blip.
        const first = failures[0]!.err;
        throw new Error(
          `mirror.replicate: ${failures.length} of ${members.length} copies stalled on chain ${chainId}: ${
            first instanceof Error ? first.message : String(first)
          }`,
        );
      }
      return { applied, lagging };
    },

    async notifyChainStalled(chainId) {
      // The genuine-stall signal (design §2/§11), fired only once the replicate
      // job's retries are exhausted (permanent failure → dead-letter → Problems).
      // Re-derive the lagging set from the DB: every copy still behind `last_seq`
      // is stuck (ops apply strictly in order, so a poison op freezes ALL copies
      // behind it), and its member + the owner are told, deduped per copy
      // watermark so a still-stuck copy re-notifies only after it makes progress.
      const chain = await repo.getChain(chainId);
      if (!chain) return;
      const members = await repo.listActiveMembers(chainId);
      const owner = ownerOf(members);
      for (const stalled of members) {
        if (!stalled.userId || !stalled.portfolioId) continue;
        if (stalled.appliedSeq >= chain.lastSeq) continue; // caught up — not stalled
        const refId = `${stalled.userId}:${stalled.appliedSeq}`;
        await emitMirror('mirror.sync_stalled', stalled.userId, chain, stalled.username, refId);
        if (owner?.userId && owner.userId !== stalled.userId) {
          await emitMirror('mirror.sync_stalled', owner.userId, chain, stalled.username, refId);
        }
      }
    },

    // ── M3 membership lifecycle (design §§4–7, §11) ────────────────────────────

    async createChain(userId, name) {
      // "New group portfolio": a fresh empty portfolio becomes the origin copy,
      // then convert synthesizes just the chain.genesis (+ Main source.create).
      const created = await portfolio.createPortfolio(userId, { name });
      return service.convertChain(userId, created.id, { name });
    },

    async convertChain(userId, portfolioId, opts) {
      const { chain, member } = await service.convertToChain(userId, portfolioId, opts);
      await audit.record({
        actorId: userId,
        action: AuditAction.MirrorChainCreated,
        targetType: 'mirror_chain',
        targetId: chain.id,
        meta: { chainId: chain.id, portfolioId },
      });
      return summaryOf(member, chain, 1);
    },

    async listChainsForUser(userId) {
      const memberships = await repo.listActiveMembershipsForUser(userId);
      const summaries: MirrorChainSummary[] = [];
      for (const member of memberships) {
        const chain = await repo.getChain(member.chainId);
        if (!chain) continue;
        const memberCount = await repo.countActiveMembers(member.chainId);
        summaries.push(summaryOf(member, chain, memberCount));
      }
      return summaries;
    },

    async getMemberList(userId, chainId) {
      const chain = await repo.getChain(chainId);
      if (!chain) throw chainNotFound();
      // Severed members lose chain access (design §6): a non-active membership
      // (or none) 404s the member sheet.
      const caller = await repo.findActiveMembership(chainId, userId);
      if (!caller) throw chainNotFound();
      const rows = await repo.listMembersDetailed(chainId);
      return {
        chainId: chain.id,
        name: chain.name,
        status: chain.status,
        role: caller.role,
        memberCap: maxMembers,
        members: rows.map((r) => toMirrorMember(r, userId, chain.lastSeq)),
      };
    },

    async getActivity(userId, chainId, opts) {
      const chain = await repo.getChain(chainId);
      if (!chain) throw chainNotFound();
      const caller = await repo.findActiveMembership(chainId, userId);
      if (!caller) throw chainNotFound(); // severed access (§6)
      const { limit } = opts;
      const ops = await repo.listActivity(chainId, { before: opts.before, limit });
      const entries: MirrorActivityEntry[] = ops.map((op) => ({
        seq: op.seq,
        kind: op.kind as MirrorOpKind,
        actorUsername: op.actorUsername,
        summary: activitySummary(op),
        createdAt: op.createdAt.toISOString(),
      }));
      const nextCursor = ops.length === limit ? (ops[ops.length - 1]?.seq ?? null) : null;
      return { entries, nextCursor };
    },

    async listInvites(userId) {
      const rows = await repo.listInvitesForUserDetailed(userId);
      const incoming: MirrorInvite[] = [];
      const outgoing: MirrorInvite[] = [];
      for (const row of rows) {
        // Stale (expired) invites are hidden until the daily sweep retires them
        // (design §4) — they are never acceptable and never block a re-invite.
        if (inviteExpired(row)) continue;
        const dto = toInviteDto(row, userId);
        (dto.direction === 'incoming' ? incoming : outgoing).push(dto);
      }
      return { incoming, outgoing };
    },

    async inviteMember(actorId, chainId, inviteeId) {
      if (actorId === inviteeId) {
        throw badRequest('You cannot invite yourself.', MIRROR_CANNOT_INVITE_SELF);
      }
      // Friends-only (design §4) — checked here at send AND again at accept.
      if (!(await friendship.areFriends(actorId, inviteeId))) {
        throw badRequest('You can only invite friends to a group portfolio.', MIRROR_NOT_FRIENDS);
      }
      const { chain, invite } = await withAuthorizedMember(
        chainId,
        actorId,
        (actor) => {
          if (!roleCan(actor.role, 'invite')) throw mirrorForbidden();
        },
        async ({ chain, members }) => {
          if (members.some((m) => m.userId === inviteeId)) {
            throw badRequest(
              'That user is already a member of this group portfolio.',
              'MIRROR_ALREADY_MEMBER',
            );
          }
          // Cap enforced at send (design §4) — active members only.
          if (members.length >= maxMembers) {
            throw new ApiError(
              409,
              MIRROR_MEMBER_CAP_REACHED,
              `This group portfolio is full (max ${maxMembers} members).`,
            );
          }
          // Pending-unique per (chain, invitee); declining/expiry allows a
          // re-invite (§4). An expired-but-not-yet-swept pending invite no longer
          // blocks — retire it so the pending-unique slot frees for a fresh send.
          const pending = await repo.findPendingInvite(chainId, inviteeId);
          if (pending) {
            if (inviteExpired(pending)) {
              await repo.setInviteStatus(pending.id, 'expired', new Date(now()));
            } else {
              throw new ApiError(
                409,
                MIRROR_INVITE_EXISTS,
                'That user already has a pending invite to this group portfolio.',
              );
            }
          }
          const invite = await repo.createInvite({ chainId, fromUser: actorId, toUser: inviteeId });
          return { chain, invite };
        },
      );
      const inviterName = await usernameOf(actorId);
      await emitMirror('mirror.invite', inviteeId, chain, inviterName, invite.id);
      await audit.record({
        actorId,
        action: AuditAction.MirrorMemberInvited,
        targetType: 'user',
        targetId: inviteeId,
        meta: { chainId, inviteId: invite.id },
      });
    },

    async acceptInvite(userId, inviteId) {
      const invite = await repo.getInvite(inviteId);
      if (!invite || invite.status !== 'pending' || invite.toUser !== userId) {
        throw notFound('Invite not found.', MIRROR_INVITE_NOT_FOUND);
      }
      // Invites expire with the standard token hygiene (design §4, 30 days): a
      // stale pending invite is rejected and marked expired at accept, freeing
      // the (chain, invitee) pending-unique slot for a fresh re-invite.
      if (inviteExpired(invite)) {
        await repo.setInviteStatus(inviteId, 'expired', new Date(now()));
        throw notFound('This invite has expired.', MIRROR_INVITE_NOT_FOUND);
      }
      const chain = await repo.getChain(invite.chainId);
      if (!chain || chain.status !== 'active') {
        await repo.setInviteStatus(inviteId, 'expired', new Date(now()));
        throw notFound('That group portfolio is no longer available.', MIRROR_INVITE_NOT_FOUND);
      }
      // Friends-only re-checked (design §4): an unfriend between send and accept
      // voids the invite (revoked), so a later re-invite is a fresh row.
      if (!invite.fromUser || !(await friendship.areFriends(invite.fromUser, userId))) {
        await repo.setInviteStatus(inviteId, 'revoked', new Date(now()));
        throw badRequest(
          'This invite is no longer valid because you are not friends with the inviter.',
          MIRROR_NOT_FRIENDS,
        );
      }
      // Idempotent: already a member (a prior accept whose invite update lost a
      // crash race) — consume the invite and return the existing copy.
      const existing = await repo.findActiveMembership(invite.chainId, userId);
      if (existing?.portfolioId) {
        await repo.setInviteStatus(inviteId, 'accepted', new Date(now()));
        return { chainId: invite.chainId, portfolioId: existing.portfolioId };
      }
      // Cap re-checked at accept (design §4).
      if ((await repo.countActiveMembers(invite.chainId)) >= maxMembers) {
        throw new ApiError(
          409,
          MIRROR_MEMBER_CAP_REACHED,
          `This group portfolio is full (max ${maxMembers} members).`,
        );
      }
      // Materialize the copy via the M2 join path (auto-named + Main-linked +
      // member.joined appended + replicate enqueued) — the member configures
      // nothing (design §4).
      const { portfolioId } = await service.attachMemberCopy(invite.chainId, userId, {
        role: 'member',
        invitedBy: invite.fromUser,
      });
      await repo.setInviteStatus(inviteId, 'accepted', new Date(now()));
      // Notify the owner a member joined (design §5). The join op advanced the
      // chain's last_seq, so its value discriminates a re-join occurrence.
      const chainAfter = (await repo.getChain(invite.chainId)) ?? chain;
      const owner = ownerOf(await repo.listActiveMembers(invite.chainId));
      if (owner?.userId && owner.userId !== userId) {
        const joinerName = await usernameOf(userId);
        await emitMirror(
          'mirror.member_joined',
          owner.userId,
          chainAfter,
          joinerName,
          `${userId}:${chainAfter.lastSeq}`,
        );
      }
      await audit.record({
        actorId: userId,
        action: AuditAction.MirrorMemberJoined,
        targetType: 'mirror_chain',
        targetId: invite.chainId,
        meta: { chainId: invite.chainId, inviteId },
      });
      return { chainId: invite.chainId, portfolioId };
    },

    async declineInvite(userId, inviteId) {
      const invite = await repo.getInvite(inviteId);
      if (!invite || invite.status !== 'pending' || invite.toUser !== userId) {
        throw notFound('Invite not found.', MIRROR_INVITE_NOT_FOUND);
      }
      await repo.setInviteStatus(inviteId, 'declined', new Date(now()));
    },

    async revokeInvite(actorId, inviteId) {
      const invite = await repo.getInvite(inviteId);
      if (!invite || invite.status !== 'pending') {
        throw notFound('Invite not found.', MIRROR_INVITE_NOT_FOUND);
      }
      // Owner + managers may revoke (design §4) — the invite capability.
      const actor = await repo.findActiveMembership(invite.chainId, actorId);
      if (!actor || !roleCan(actor.role, 'invite')) throw mirrorForbidden();
      await repo.setInviteStatus(inviteId, 'revoked', new Date(now()));
    },

    async setMemberRole(actorId, chainId, targetUserId, role) {
      await withAuthorizedMember(
        chainId,
        actorId,
        (actor) => {
          if (!roleCan(actor.role, 'manage_roles')) throw mirrorForbidden();
        },
        async ({ actor, members }) => {
          if (targetUserId === actor.userId) {
            throw badRequest('You cannot change your own role.', MIRROR_FORBIDDEN);
          }
          const target = members.find((m) => m.userId === targetUserId);
          if (!target) {
            throw notFound(
              'That member is not part of this group portfolio.',
              MIRROR_MEMBER_NOT_FOUND,
            );
          }
          // The owner role changes only via transfer (design §5).
          if (target.role === 'owner') throw mirrorForbidden();
          if (target.role === role) return; // idempotent
          await repo.updateMemberRole(target.id, role);
          await appendMembershipOp(
            chainId,
            { userId: actorId, username: actor.username },
            role === 'manager'
              ? {
                  opVersion: MIRROR_OP_VERSION,
                  kind: 'role.granted',
                  userId: target.userId!,
                  username: target.username,
                  role: 'manager',
                }
              : {
                  opVersion: MIRROR_OP_VERSION,
                  kind: 'role.revoked',
                  userId: target.userId!,
                  username: target.username,
                },
          );
        },
      );
      await audit.record({
        actorId,
        action: AuditAction.MirrorRoleChanged,
        targetType: 'user',
        targetId: targetUserId,
        meta: { chainId, role },
      });
      // The role.* op bumped last_seq — replicate so every copy skip-acks it and
      // the sync-state read models settle to 100% (design §11).
      await scheduleReplicate(chainId);
    },

    async transferOwnership(actorId, chainId, toUserId) {
      const { chain, seq } = await withAuthorizedMember(
        chainId,
        actorId,
        (actor) => {
          if (!roleCan(actor.role, 'transfer')) throw mirrorForbidden();
        },
        async ({ chain, actor, members }) => {
          if (toUserId === actor.userId) {
            throw badRequest('You are already the owner.', MIRROR_FORBIDDEN);
          }
          const target = members.find((m) => m.userId === toUserId);
          if (!target) {
            throw notFound(
              'The new owner must be an active member of this group portfolio.',
              MIRROR_MEMBER_NOT_FOUND,
            );
          }
          // Demote the old owner FIRST (the ≤1-active-owner partial-unique index
          // forbids two owners even momentarily), then crown the target (§5).
          await repo.updateMemberRole(actor.id, 'member');
          await repo.updateMemberRole(target.id, 'owner');
          const [op] = await appendMembershipOp(
            chainId,
            { userId: actorId, username: actor.username },
            {
              opVersion: MIRROR_OP_VERSION,
              kind: 'owner.transferred',
              fromUserId: actor.userId!,
              fromUsername: actor.username,
              toUserId: target.userId!,
              toUsername: target.username,
            },
          );
          return { chain, seq: op!.seq };
        },
      );
      // Notify every active member ownership changed (design §5). The acting old
      // owner already knows; the NEW owner is skipped too — the copy reads
      // "⟨actor⟩ is now the owner", which self-named reads wrong, and their own
      // member sheet already shows the role. The op seq discriminates the notice
      // so transferring ownership back to a prior owner is not silently deduped.
      const newOwnerName = await usernameOf(toUserId);
      const refId = `${toUserId}:${seq}`;
      for (const m of await repo.listActiveMembers(chainId)) {
        if (m.userId && m.userId !== actorId && m.userId !== toUserId) {
          await emitMirror('mirror.ownership_transferred', m.userId, chain, newOwnerName, refId);
        }
      }
      await audit.record({
        actorId,
        action: AuditAction.MirrorOwnershipTransferred,
        targetType: 'user',
        targetId: toUserId,
        meta: { chainId },
      });
      // The owner.transferred op bumped last_seq — replicate so every copy
      // skip-acks it and the sync-state read models settle to 100% (design §11).
      await scheduleReplicate(chainId);
    },

    async removeMember(actorId, chainId, targetUserId) {
      const { chain, targetName, seq, notifyOwnerId } = await withAuthorizedMember(
        chainId,
        actorId,
        () => {
          // The capability depends on the target's role — checked inside once
          // the target is resolved (kick_member vs kick_manager, §5).
        },
        async ({ chain, actor, members }) => {
          if (targetUserId === actor.userId) {
            throw badRequest('Use Leave to remove yourself.', MIRROR_FORBIDDEN);
          }
          const target = members.find((m) => m.userId === targetUserId);
          if (!target) {
            throw notFound(
              'That member is not part of this group portfolio.',
              MIRROR_MEMBER_NOT_FOUND,
            );
          }
          const capability: MembershipCapability =
            target.role === 'manager' ? 'kick_manager' : 'kick_member';
          if (target.role === 'owner' || !roleCan(actor.role, capability)) throw mirrorForbidden();
          // Tombstone under the lock so no later op from the removed member can
          // slip in (§6/§2); its copy freezes at its current watermark (the
          // replicate job skips non-active) — severance is immediate.
          await repo.endMembership(target.id, 'removed', new Date(now()));
          const [op] = await appendMembershipOp(
            chainId,
            { userId: actorId, username: actor.username },
            {
              opVersion: MIRROR_OP_VERSION,
              kind: 'member.removed',
              userId: target.userId!,
              username: target.username,
            },
          );
          const owner = ownerOf(members);
          return {
            chain,
            targetName: target.username,
            seq: op!.seq,
            notifyOwnerId: owner && owner.userId !== actorId ? owner.userId : null,
          };
        },
      );
      // The removed member is told (design §6); a manager's kick also tells the
      // owner (design §5). Seq discriminates a re-kick after a re-invite.
      await emitMirror('mirror.removed', targetUserId, chain, targetName, `${targetUserId}:${seq}`);
      if (notifyOwnerId) {
        await emitMirror(
          'mirror.member_removed',
          notifyOwnerId,
          chain,
          targetName,
          `${targetUserId}:${seq}`,
        );
      }
      await audit.record({
        actorId,
        action: AuditAction.MirrorMemberRemoved,
        targetType: 'user',
        targetId: targetUserId,
        meta: { chainId },
      });
      // The member.removed op bumped last_seq — replicate so the remaining
      // copies skip-ack it and their sync-state read models settle (design §11).
      await scheduleReplicate(chainId);
    },

    async leaveChain(userId, chainId) {
      const outcome = await withAuthorizedMember(
        chainId,
        userId,
        () => {
          // Every role may leave (design §5): a plain leave for a member/manager,
          // and §7 succession for the owner — the M3 stopgap 409 is gone (M4).
        },
        async ({ chain, actor, members }) => {
          if (actor.role === 'owner') {
            // §7: the owner departs → ownership passes to the oldest manager (or
            // the chain dissolves with no manager). Tombstone the owner FIRST so
            // there is never a moment with two active owners, then succeed; the
            // owner keeps their own copy as a fork (§6).
            await repo.endMembership(actor.id, 'left', new Date(now()));
            const remaining = await repo.listActiveMembers(chainId);
            const result = await runOwnerSuccession(
              chain,
              remaining,
              { userId, username: actor.username },
              'owner_left',
            );
            if (result.outcome === 'transferred') {
              // The departing owner's member.left-equivalent tombstone op (§7).
              await appendMembershipOp(
                chainId,
                { userId, username: actor.username },
                {
                  opVersion: MIRROR_OP_VERSION,
                  kind: 'member.left',
                  userId,
                  username: actor.username,
                },
              );
            }
            return { chain, kind: 'owner' as const };
          }
          await repo.endMembership(actor.id, 'left', new Date(now()));
          const [op] = await appendMembershipOp(
            chainId,
            { userId, username: actor.username },
            {
              opVersion: MIRROR_OP_VERSION,
              kind: 'member.left',
              userId: actor.userId!,
              username: actor.username,
            },
          );
          const owner = ownerOf(members);
          return {
            chain,
            kind: 'member' as const,
            leaverName: actor.username,
            seq: op!.seq,
            notifyOwnerId: owner?.userId ?? null,
          };
        },
      );
      if (outcome.kind === 'member' && outcome.notifyOwnerId && outcome.notifyOwnerId !== userId) {
        await emitMirror(
          'mirror.member_left',
          outcome.notifyOwnerId,
          outcome.chain,
          outcome.leaverName,
          `${userId}:${outcome.seq}`,
        );
      }
      await audit.record({
        actorId: userId,
        action: AuditAction.MirrorMemberLeft,
        targetType: 'mirror_chain',
        targetId: chainId,
        meta: { chainId },
      });
      // The member.left / owner.transferred / chain.dissolved op bumped last_seq —
      // replicate so the remaining copies skip-ack it and their sync-state read
      // models settle (design §11).
      await scheduleReplicate(chainId);
    },

    async renameChain(actorId, chainId, name) {
      const trimmed = name.trim();
      await withAuthorizedMember(
        chainId,
        actorId,
        (actor) => {
          if (!roleCan(actor.role, 'rename')) throw mirrorForbidden();
        },
        async ({ actor }) => {
          // The name is authoritative on the chain row (design §1); the chain UI
          // renders it. Log a chain.rename op for the activity feed.
          await repo.renameChain(chainId, trimmed);
          await appendMembershipOp(
            chainId,
            { userId: actorId, username: actor.username },
            { opVersion: MIRROR_OP_VERSION, kind: 'chain.rename', name: trimmed },
          );
        },
      );
      const updated = (await repo.getChain(chainId))!;
      const member = (await repo.findActiveMembership(chainId, actorId))!;
      const memberCount = await repo.countActiveMembers(chainId);
      // The chain.rename op bumped last_seq — replicate so every copy skip-acks
      // it and the sync-state read models settle to 100% (design §11).
      await scheduleReplicate(chainId);
      return summaryOf(member, updated, memberCount);
    },

    async dissolveChain(actorId, chainId) {
      const { chain, members } = await withAuthorizedMember(
        chainId,
        actorId,
        (actor) => {
          if (!roleCan(actor.role, 'dissolve')) throw mirrorForbidden();
        },
        async ({ chain, actor, members }) => {
          await appendMembershipOp(
            chainId,
            { userId: actorId, username: actor.username },
            { opVersion: MIRROR_OP_VERSION, kind: 'chain.dissolved', reason: 'owner_dissolved' },
          );
          const endedAt = new Date(now());
          for (const m of members) {
            await repo.endMembership(m.id, 'dissolved', endedAt);
          }
          await repo.markChainDissolved(chainId, endedAt);
          return { chain, members };
        },
      );
      // Every copy becomes a fork (design §6); notify all former members but the
      // acting owner.
      const actorName = await usernameOf(actorId);
      for (const m of members) {
        if (m.userId && m.userId !== actorId) {
          await emitMirror('mirror.chain_dissolved', m.userId, chain, actorName, chainId);
        }
      }
      await audit.record({
        actorId,
        action: AuditAction.MirrorChainDissolved,
        targetType: 'mirror_chain',
        targetId: chainId,
        meta: { chainId },
      });
      // Uniform with the other membership ops (design §11). Every copy is now a
      // fork, so this run finds no active members and no-ops — the sync-state
      // read models no longer surface a dissolved chain anyway.
      await scheduleReplicate(chainId);
    },

    async submitPortfolioDelete(userId, portfolioId) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.deletePortfolio(userId, portfolioId);
      // A synced copy is intercepted as leave-then-delete (§6): the copy leaves
      // the chain, then is deleted. For the owner, the leave runs §7 succession
      // first (M4 — no stopgap 409); every role ends the same way.
      await service.leaveChain(userId, membership.chainId);
      await portfolio.deletePortfolio(userId, portfolioId);
    },

    async handleAccountDeletion(userId) {
      const memberships = await repo.listActiveMembershipsForUser(userId);
      if (memberships.length === 0) return;
      // The departing user's name — denormalized onto ops/tombstones so it keeps
      // rendering ("alice (account deleted)") after the user row's SET NULL.
      const username = await usernameOf(userId);
      for (const membership of memberships) {
        await withChainLock(membership.chainId, async () => {
          const chain = await repo.getChain(membership.chainId);
          if (!chain || chain.status !== 'active') return;
          // Re-read under the lock — a concurrent op may have moved the row.
          const self = await repo.findActiveMembership(membership.chainId, userId);
          if (!self) return;
          const endedAt = new Date(now());
          if (self.role === 'owner') {
            // Tombstone the owner FIRST (0 active owners, the ≤1-owner index),
            // then run §7 succession. The op order in the log is
            // `owner.transferred` then the `member.left`-equivalent (design §7).
            await repo.endMembership(self.id, 'account_deleted', endedAt);
            const remaining = await repo.listActiveMembers(membership.chainId);
            const result = await runOwnerSuccession(
              chain,
              remaining,
              { userId, username },
              'account_deletion',
            );
            if (result.outcome === 'transferred') {
              await appendMembershipOp(
                membership.chainId,
                { userId, username },
                { opVersion: MIRROR_OP_VERSION, kind: 'member.left', userId, username },
              );
              await audit.record({
                actorId: userId,
                action: AuditAction.MirrorOwnershipTransferred,
                targetType: 'user',
                targetId: result.newOwner.userId!,
                meta: { chainId: membership.chainId, via: 'account_deletion' },
              });
            } else {
              await audit.record({
                actorId: userId,
                action: AuditAction.MirrorChainDissolved,
                targetType: 'mirror_chain',
                targetId: membership.chainId,
                meta: { chainId: membership.chainId, via: 'account_deletion' },
              });
            }
          } else {
            // Non-owner: end the membership + a `member.left` op (feed
            // completeness), notify the owner; the copy cascades away with the
            // user row, the chain is otherwise untouched (design §7).
            await repo.endMembership(self.id, 'account_deleted', endedAt);
            const [leftOp] = await appendMembershipOp(
              membership.chainId,
              { userId, username },
              { opVersion: MIRROR_OP_VERSION, kind: 'member.left', userId, username },
            );
            const owner = ownerOf(await repo.listActiveMembers(membership.chainId));
            if (owner?.userId && owner.userId !== userId) {
              await emitMirror(
                'mirror.member_left',
                owner.userId,
                chain,
                username,
                `${userId}:${leftOp!.seq}`,
              );
            }
            await audit.record({
              actorId: userId,
              action: AuditAction.MirrorMemberLeft,
              targetType: 'mirror_chain',
              targetId: membership.chainId,
              meta: { chainId: membership.chainId, via: 'account_deletion' },
            });
          }
        });
        await scheduleReplicate(membership.chainId);
      }
    },

    async runConsistencySweep() {
      const ownerlessRepaired: MirrorConsistencySweepResult['ownerlessRepaired'] = [];
      // (0) Ownerless active chains → §7 succession (design §7 defense-in-depth).
      for (const chain of await repo.listOwnerlessActiveChains()) {
        const repaired = await withChainLock(chain.id, async () => {
          const fresh = await repo.getChain(chain.id);
          if (!fresh || fresh.status !== 'active') return null;
          const members = await repo.listActiveMembers(chain.id);
          // A concurrent real transfer may have re-owned it between the scan and
          // the lock — re-check under the lock before repairing.
          if (members.some((m) => m.role === 'owner')) return null;
          return runOwnerSuccession(fresh, members, null, 'repair_sweep');
        });
        if (repaired) {
          ownerlessRepaired.push({
            chainId: chain.id,
            outcome: repaired.outcome,
            newOwnerUserId: repaired.outcome === 'transferred' ? repaired.newOwner.userId : null,
          });
        }
      }
      // (a) origin-commit-then-append residual: an origin link with no op.
      const danglingOriginRows = (await repo.listDanglingOriginRows(MIRROR_SWEEP_ROW_LIMIT)).map(
        (r) => ({
          chainId: r.chainId,
          portfolioId: r.portfolioId,
          mirrorId: r.mirrorId,
          kind: r.kind,
        }),
      );
      // (b) correction re-create-then-re-point residual: a synced-copy tx with
      // no mirror link (a safe-to-delete local duplicate) — surfaced, not deleted.
      const orphanedLocalRows = (
        await repo.listOrphanedSyncedTransactions(MIRROR_SWEEP_ROW_LIMIT)
      ).map((r) => ({ portfolioId: r.portfolioId, localId: r.id }));
      return { ownerlessRepaired, danglingOriginRows, orphanedLocalRows };
    },

    // ── Submits ──────────────────────────────────────────────────────────────

    async submitTransactionsCreate(userId, portfolioId, inputs, opts) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.createTransactions(userId, portfolioId, inputs, opts);
      await assertSyncableAssets(inputs.map((i) => i.assetId));
      const username = await usernameOf(userId);
      const dtos = await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        // The origin's normal, fully-validated write — it mints the row ids
        // that become the ops' mirror ids (§1); a rejection appends nothing.
        const created = await portfolio.createTransactions(userId, portfolioId, inputs, {
          source: opts?.source,
        });
        const ops: AppendOpInput[] = [];
        for (let i = 0; i < created.length; i++) {
          const input = inputs[i]!;
          const dto = created[i]!;
          ops.push({
            kind: 'tx.create',
            mirrorId: dto.id,
            actorUserId: userId,
            actorUsername: username,
            originPortfolioId: portfolioId,
            payload: {
              opVersion: MIRROR_OP_VERSION,
              kind: 'tx.create',
              mirrorId: dto.id,
              assetId: input.assetId,
              side: input.side,
              quantity: input.quantity,
              price: input.price,
              fee: input.fee ?? 0,
              executedAt: new Date(input.executedAt).toISOString(),
              note: input.note ?? null,
              allowUncovered: input.side === 'sell' ? (input.allowUncovered ?? false) : false,
              uncoveredEntryPrice:
                input.side === 'sell' && input.allowUncovered
                  ? (input.uncoveredEntryPrice ?? null)
                  : null,
              payFromCash: input.payFromCash ?? false,
              addProceedsToCash: input.addProceedsToCash ?? false,
              cashSourceMirrorId: input.cashSourceId
                ? await mirrorIdOfLocalSource(input.cashSourceId)
                : null,
              settleCashAsOfToday: input.settleCashAsOfToday ?? false,
              originSource: opts?.source ?? 'manual',
            },
          });
          await repo.insertMirrorRow({
            chainId: member.chainId,
            kind: 'transaction',
            mirrorId: dto.id,
            portfolioId,
            localId: dto.id,
            createdBy: userId,
            createdByUsername: username,
          });
        }
        await appendAndFinish(
          member,
          userId,
          ops,
          created.map((dto) => ({ applied: true, rowKind: 'transaction', localId: dto.id })),
        );
        return created;
      });
      await scheduleReplicate(membership.chainId);
      return dtos;
    },

    async submitTransactionUpdate(userId, portfolioId, txId, patch, opts) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.updateTransaction(userId, portfolioId, txId, patch);
      const username = await usernameOf(userId);
      const dto = await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const local = await transactionRepo.findByIdForUser(userId, txId);
        if (!local || local.portfolioId !== portfolioId) {
          throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');
        }
        const link = await repo.findMirrorRowByLocal('transaction', txId);
        if (!link) throw new Error(`mirror: transaction ${txId} is not mirror-linked`);
        const baseSeq = await checkEntityGuard(member.chainId, link.mirrorId, opts?.baseSeq);

        // Full state, never a field diff (§3) — merged from the local row.
        const legs = await cashIntentForLocalTx(portfolioId, txId);
        const payload: Payload<'tx.update'> = {
          opVersion: MIRROR_OP_VERSION,
          kind: 'tx.update',
          mirrorId: link.mirrorId,
          baseSeq,
          side: patch.side ?? local.side,
          quantity: patch.quantity ?? local.quantity,
          price: patch.price ?? local.price,
          fee: patch.fee ?? local.fee,
          executedAt: patch.executedAt
            ? new Date(patch.executedAt).toISOString()
            : local.executedAt.toISOString(),
          note: patch.note === undefined ? local.note : (patch.note ?? null),
          allowUncovered: local.allowUncovered,
          uncoveredEntryPrice: local.uncoveredEntryPrice,
          ...legs,
        };
        const outcome = await applyLedgerOp(
          member,
          { actorUserId: userId, actorUsername: username, originPortfolioId: portfolioId },
          payload,
          false,
        );
        if (!outcome.applied) {
          // Nothing actually changed — no op is appended (nothing happened).
          return portfolio.updateTransaction(userId, portfolioId, txId, { note: payload.note });
        }
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'tx.update',
              mirrorId: link.mirrorId,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload,
              baseSeq,
            },
          ],
          [outcome],
        );
        return outcome.result as TransactionDto;
      });
      await scheduleReplicate(membership.chainId);
      return dto;
    },

    async submitTransactionDelete(userId, portfolioId, txId, opts) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.deleteTransaction(userId, portfolioId, txId);
      const username = await usernameOf(userId);
      await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const local = await transactionRepo.findByIdForUser(userId, txId);
        if (!local || local.portfolioId !== portfolioId) {
          throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');
        }
        const link = await repo.findMirrorRowByLocal('transaction', txId);
        if (!link) throw new Error(`mirror: transaction ${txId} is not mirror-linked`);
        const baseSeq = await checkEntityGuard(member.chainId, link.mirrorId, opts?.baseSeq);
        const payload: Payload<'tx.delete'> = {
          opVersion: MIRROR_OP_VERSION,
          kind: 'tx.delete',
          mirrorId: link.mirrorId,
          baseSeq,
        };
        const outcome = await applyLedgerOp(
          member,
          { actorUserId: userId, actorUsername: username, originPortfolioId: portfolioId },
          payload,
          false,
        );
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'tx.delete',
              mirrorId: link.mirrorId,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload,
              baseSeq,
            },
          ],
          [outcome],
        );
      });
      await scheduleReplicate(membership.chainId);
    },

    async submitDividendRecord(userId, portfolioId, input) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return tax.recordDividend(userId, portfolioId, input);
      await assertSyncableAssets([input.assetId]);
      const username = await usernameOf(userId);
      const res = await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const created = await tax.recordDividend(userId, portfolioId, input);
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'dividend',
          mirrorId: created.dividend.id,
          portfolioId,
          localId: created.dividend.id,
          createdBy: userId,
          createdByUsername: username,
        });
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'dividend.record',
              mirrorId: created.dividend.id,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload: {
                opVersion: MIRROR_OP_VERSION,
                kind: 'dividend.record',
                mirrorId: created.dividend.id,
                assetId: input.assetId,
                grossAmountEur: created.dividend.grossAmountEur,
                executedAt: created.dividend.executedAt,
                cashSourceMirrorId: input.cashSourceId
                  ? await mirrorIdOfLocalSource(input.cashSourceId)
                  : null,
                note: input.note ?? null,
                originSource: 'manual',
              },
            },
          ],
          [{ applied: true, rowKind: 'dividend', localId: created.dividend.id }],
        );
        return created;
      });
      await scheduleReplicate(membership.chainId);
      return res;
    },

    async submitDividendDelete(userId, portfolioId, dividendId, opts) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return tax.deleteDividend(userId, portfolioId, dividendId);
      const username = await usernameOf(userId);
      await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const local = await taxRepo.findByIdForPortfolio(portfolioId, dividendId);
        if (!local) throw notFound('Dividend not found.', 'DIVIDEND_NOT_FOUND');
        const link = await repo.findMirrorRowByLocal('dividend', dividendId);
        if (!link) throw new Error(`mirror: dividend ${dividendId} is not mirror-linked`);
        const baseSeq = await checkEntityGuard(member.chainId, link.mirrorId, opts?.baseSeq);
        const payload: Payload<'dividend.delete'> = {
          opVersion: MIRROR_OP_VERSION,
          kind: 'dividend.delete',
          mirrorId: link.mirrorId,
          baseSeq,
        };
        const outcome = await applyLedgerOp(
          member,
          { actorUserId: userId, actorUsername: username, originPortfolioId: portfolioId },
          payload,
          false,
        );
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'dividend.delete',
              mirrorId: link.mirrorId,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload,
              baseSeq,
            },
          ],
          [outcome],
        );
      });
      await scheduleReplicate(membership.chainId);
    },

    async submitCashDeposit(userId, portfolioId, input) {
      return submitCashEntry(userId, portfolioId, input, 'cash.deposit');
    },

    async submitCashWithdraw(userId, portfolioId, input) {
      return submitCashEntry(userId, portfolioId, input, 'cash.withdraw');
    },

    async submitCashTransfer(userId, portfolioId, input) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.transferCash(userId, portfolioId, input);
      const username = await usernameOf(userId);
      const res = await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const created = await portfolio.transferCash(userId, portfolioId, input);
        // One statement — a crash can never strand the pair half-linked.
        await repo.insertMirrorRows(
          [created.outgoing, created.incoming].map((movement) => ({
            chainId: member.chainId,
            kind: 'cash_movement' as const,
            mirrorId: movement.id,
            portfolioId,
            localId: movement.id,
            createdBy: userId,
            createdByUsername: username,
          })),
        );
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'cash.transfer',
              mirrorId: created.outgoing.id,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload: {
                opVersion: MIRROR_OP_VERSION,
                kind: 'cash.transfer',
                outMirrorId: created.outgoing.id,
                inMirrorId: created.incoming.id,
                fromSourceMirrorId: await mirrorIdOfLocalSource(input.fromSourceId),
                toSourceMirrorId: await mirrorIdOfLocalSource(input.toSourceId),
                amountEur: Math.abs(created.outgoing.amountEur),
                executedAt: created.outgoing.executedAt,
                note: input.note ?? null,
                originSource: 'manual',
              },
            },
          ],
          [{ applied: true, rowKind: 'cash_movement', localId: created.outgoing.id }],
        );
        return created;
      });
      await scheduleReplicate(membership.chainId);
      return res;
    },

    async submitSetCashBalance(userId, portfolioId, sourceId, input) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.setCashBalance(userId, portfolioId, sourceId, input);
      const username = await usernameOf(userId);
      const res = await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const created = await portfolio.setCashBalance(userId, portfolioId, sourceId, input);
        // A zero delta records nothing, so no op is appended (design §8).
        if (!created.movement) return created;
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'cash_movement',
          mirrorId: created.movement.id,
          portfolioId,
          localId: created.movement.id,
          createdBy: userId,
          createdByUsername: username,
        });
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'cash.setBalance',
              mirrorId: created.movement.id,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload: {
                opVersion: MIRROR_OP_VERSION,
                kind: 'cash.setBalance',
                mirrorId: created.movement.id,
                sourceMirrorId: await mirrorIdOfLocalSource(sourceId),
                deltaEur: created.deltaEur,
                executedAt: created.movement.executedAt,
                note: input.note ?? null,
                originSource: 'manual',
              },
            },
          ],
          [{ applied: true, rowKind: 'cash_movement', localId: created.movement.id }],
        );
        return created;
      });
      await scheduleReplicate(membership.chainId);
      return res;
    },

    async submitSourceCreate(userId, portfolioId, input) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.createCashSource(userId, portfolioId, input);
      const username = await usernameOf(userId);
      const res = await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const dto = await portfolio.createCashSource(userId, portfolioId, input);
        await repo.insertMirrorRow({
          chainId: member.chainId,
          kind: 'cash_source',
          mirrorId: dto.id,
          portfolioId,
          localId: dto.id,
          createdBy: userId,
          createdByUsername: username,
        });
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'source.create',
              mirrorId: dto.id,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload: {
                opVersion: MIRROR_OP_VERSION,
                kind: 'source.create',
                mirrorId: dto.id,
                name: dto.name,
                type: dto.type,
              },
            },
          ],
          [{ applied: true, rowKind: 'cash_source', localId: dto.id }],
        );
        return dto;
      });
      await scheduleReplicate(membership.chainId);
      return res;
    },

    async submitSourceUpdate(userId, portfolioId, sourceId, patch, opts) {
      const membership = await membershipForWrite(userId, portfolioId);
      if (!membership) return portfolio.updateCashSource(userId, portfolioId, sourceId, patch);
      const username = await usernameOf(userId);
      const res = await withChainLock(membership.chainId, async () => {
        const member = await catchUpOrigin(membership);
        const current = await cashSourceRepo.findByIdForPortfolio(portfolioId, sourceId);
        if (!current) throw notFound('Cash source not found.', 'CASH_SOURCE_NOT_FOUND');
        const link = await repo.findMirrorRowByLocal('cash_source', sourceId);
        if (!link) throw new Error(`mirror: cash source ${sourceId} is not mirror-linked`);
        const baseSeq = await checkEntityGuard(member.chainId, link.mirrorId, opts?.baseSeq);
        const payload: Payload<'source.rename'> = {
          opVersion: MIRROR_OP_VERSION,
          kind: 'source.rename',
          mirrorId: link.mirrorId,
          baseSeq,
          name: patch.name?.trim() || current.name,
          type: patch.type ?? current.type,
        };
        const outcome = await applyLedgerOp(
          member,
          { actorUserId: userId, actorUsername: username, originPortfolioId: portfolioId },
          payload,
          false,
        );
        if (!outcome.applied) {
          return portfolio.updateCashSource(userId, portfolioId, sourceId, {
            name: payload.name,
            type: payload.type,
          });
        }
        await appendAndFinish(
          member,
          userId,
          [
            {
              kind: 'source.rename',
              mirrorId: link.mirrorId,
              actorUserId: userId,
              actorUsername: username,
              originPortfolioId: portfolioId,
              payload,
              baseSeq,
            },
          ],
          [outcome],
        );
        return outcome.result as CashSourceDto;
      });
      await scheduleReplicate(membership.chainId);
      return res;
    },

    async submitSourceArchive(userId, portfolioId, sourceId, opts) {
      return submitSourceFlip(userId, portfolioId, sourceId, 'source.archive', opts);
    },

    async submitSourceRestore(userId, portfolioId, sourceId, opts) {
      return submitSourceFlip(userId, portfolioId, sourceId, 'source.restore', opts);
    },
  };

  /** Shared deposit/withdraw submit (they differ only in kind + service call). */
  async function submitCashEntry(
    userId: string,
    portfolioId: string,
    input: CashEntryRequest,
    kind: 'cash.deposit' | 'cash.withdraw',
  ): Promise<CashMovementResponse> {
    const membership = await membershipForWrite(userId, portfolioId);
    if (!membership) {
      return kind === 'cash.deposit'
        ? portfolio.depositCash(userId, portfolioId, input)
        : portfolio.withdrawCash(userId, portfolioId, input);
    }
    const username = await usernameOf(userId);
    const res = await withChainLock(membership.chainId, async () => {
      const member = await catchUpOrigin(membership);
      const created =
        kind === 'cash.deposit'
          ? await portfolio.depositCash(userId, portfolioId, input)
          : await portfolio.withdrawCash(userId, portfolioId, input);
      await repo.insertMirrorRow({
        chainId: member.chainId,
        kind: 'cash_movement',
        mirrorId: created.movement.id,
        portfolioId,
        localId: created.movement.id,
        createdBy: userId,
        createdByUsername: username,
      });
      await appendAndFinish(
        member,
        userId,
        [
          {
            kind,
            mirrorId: created.movement.id,
            actorUserId: userId,
            actorUsername: username,
            originPortfolioId: portfolioId,
            payload: {
              opVersion: MIRROR_OP_VERSION,
              kind,
              mirrorId: created.movement.id,
              sourceMirrorId: input.sourceId ? await mirrorIdOfLocalSource(input.sourceId) : null,
              amountEur: Math.abs(created.movement.amountEur),
              executedAt: created.movement.executedAt,
              note: input.note ?? null,
              originSource: 'manual',
            } as MirrorOpPayload,
          },
        ],
        [{ applied: true, rowKind: 'cash_movement', localId: created.movement.id }],
      );
      return created;
    });
    await scheduleReplicate(membership.chainId);
    return res;
  }

  /** Shared archive/restore submit (mutation ops with a bare mirror-id payload). */
  async function submitSourceFlip(
    userId: string,
    portfolioId: string,
    sourceId: string,
    kind: 'source.archive' | 'source.restore',
    opts?: { baseSeq?: number },
  ): Promise<CashSourceDto> {
    const membership = await membershipForWrite(userId, portfolioId);
    if (!membership) {
      return kind === 'source.archive'
        ? portfolio.archiveCashSource(userId, portfolioId, sourceId)
        : portfolio.restoreCashSource(userId, portfolioId, sourceId);
    }
    const username = await usernameOf(userId);
    const res = await withChainLock(membership.chainId, async () => {
      const member = await catchUpOrigin(membership);
      const link = await repo.findMirrorRowByLocal('cash_source', sourceId);
      if (!link) throw new Error(`mirror: cash source ${sourceId} is not mirror-linked`);
      const baseSeq = await checkEntityGuard(member.chainId, link.mirrorId, opts?.baseSeq);
      const payload = {
        opVersion: MIRROR_OP_VERSION,
        kind,
        mirrorId: link.mirrorId,
        baseSeq,
      } as MirrorOpPayload;
      const outcome = await applyLedgerOp(
        member,
        { actorUserId: userId, actorUsername: username, originPortfolioId: portfolioId },
        payload,
        false,
      );
      await appendAndFinish(
        member,
        userId,
        [
          {
            kind,
            mirrorId: link.mirrorId,
            actorUserId: userId,
            actorUsername: username,
            originPortfolioId: portfolioId,
            payload,
            baseSeq,
          },
        ],
        [outcome],
      );
      return outcome.result as CashSourceDto;
    });
    await scheduleReplicate(membership.chainId);
    return res;
  }

  /**
   * A local transaction's cash-link intent, reconstructed from its linked legs
   * (the intent itself is immutable — the update surface can't restate it).
   */
  async function cashIntentForLocalTx(
    portfolioId: string,
    txId: string,
  ): Promise<{
    payFromCash: boolean;
    addProceedsToCash: boolean;
    cashSourceMirrorId: string | null;
  }> {
    const movements = await cashMovementRepo.listForPortfolio(portfolioId);
    const legs = movements.filter(
      (m) => m.transactionId === txId && (m.kind === 'buy' || m.kind === 'sell_proceeds'),
    );
    const sourceId = legs[0]?.sourceId ?? null;
    return {
      payFromCash: legs.some((m) => m.kind === 'buy'),
      addProceedsToCash: legs.some((m) => m.kind === 'sell_proceeds'),
      cashSourceMirrorId: sourceId ? await mirrorIdOfLocalSource(sourceId) : null,
    };
  }

  return service;
}
