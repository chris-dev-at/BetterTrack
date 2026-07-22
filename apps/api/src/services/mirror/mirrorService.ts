import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  MIRROR_ASSET_NOT_SYNCABLE,
  MIRROR_CHAIN_OP_KINDS,
  MIRROR_CONFLICT,
  MIRROR_OP_VERSION,
  MIRROR_ROW_DELETED,
  MIRROR_SYNC_STALLED,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  mirrorOpPayloadSchema,
  type CashEntryRequest,
  type CashMovementResponse,
  type CashTransferRequest,
  type CashTransferResponse,
  type CreateCashSourceRequest,
  type CreateDividendRequest,
  type CreateDividendResponse,
  type CashSource as CashSourceDto,
  type MirrorOpPayload,
  type MirrorRowKind,
  type SetCashBalanceRequest,
  type SetCashBalanceResponse,
  type Transaction as TransactionDto,
  type TransactionInput,
  type UpdateCashSourceRequest,
  type UpdateTransactionRequest,
} from '@bettertrack/contracts';

import type {
  AppendOpInput,
  MirrorchainRepository,
} from '../../data/repositories/mirrorchainRepository';
import type { CashMovementRepository } from '../../data/repositories/cashMovementRepository';
import type { CashSourceRepository } from '../../data/repositories/cashSourceRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { TaxRepository } from '../../data/repositories/taxRepository';
import type { TransactionRepository } from '../../data/repositories/transactionRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { MirrorChainMemberRow, MirrorChainOpRow, MirrorChainRow } from '../../data/schema';
import { ApiError, badRequest, forbidden, notFound } from '../../errors';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
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
 * last step. Joining is the same mechanism: genesis ops are synthesized at
 * convert so a join is a plain oplog replay through the joiner's services —
 * one code path (§2).
 */

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;

/** Ops whose presence as an entity's latest op make it terminally deleted (§3). */
const TERMINAL_KINDS = new Set<string>(['tx.delete', 'dividend.delete']);
const CHAIN_OP_KINDS = new Set<string>(MIRROR_CHAIN_OP_KINDS);

/** Suffix attempts for §1's collision rule (`Name (2)` …) on replicated names. */
const NAME_SUFFIX_ATTEMPTS = 9;

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
  audit: Pick<AuditService, 'record'>;
  events: Pick<EventBus, 'publish'>;
  /** Backs the per-chain submit lock (SET NX PX); ioredis-mock under test. */
  redis: Redis;
  /**
   * Enqueue the durable `mirror.replicate` job for a chain. Production wires
   * the BullMQ queue (job-id deduped per chain); absent under test — tests
   * drive {@link MirrorService.replicateChain} synchronously (the snapshot
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

export interface MirrorService {
  /**
   * The active membership behind a synced copy, or null for a normal
   * portfolio — the §1 routing decision. Every submit method below falls
   * through to the plain service when this is null, so non-chain portfolios
   * stay byte-identical to today.
   */
  syncedMembership(portfolioId: string): Promise<MirrorChainMemberRow | null>;
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
    audit,
    events,
    redis,
    logger,
  } = deps;
  const now = deps.now ?? Date.now;

  // ── Infrastructure ─────────────────────────────────────────────────────────

  /**
   * Per-chain submit mutex. Serializes all submits of one chain so the origin's
   * local apply order equals seq order and the pre-append guard reads cannot
   * interleave with another submit's append. The DB-level `appendOpsChecked`
   * guards stay authoritative for anything not holding this lock.
   */
  async function withChainLock<T>(chainId: string, fn: () => Promise<T>): Promise<T> {
    const key = `bt:mirror:submit:${chainId}`;
    const token = randomUUID();
    const deadline = now() + LOCK_WAIT_MS;
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
    try {
      return await fn();
    } finally {
      const holder = await redis.get(key);
      if (holder === token) await redis.del(key);
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
  async function assertSyncableAssets(assetIds: string[]): Promise<void> {
    const rows = await portfolioRepo.assetsByIds([...new Set(assetIds)]);
    for (const row of rows) {
      if (row.ownerId !== null) {
        throw badRequest(
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
        if (!local) return { applied: false };
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
        for (const [mirrorId, localId] of [
          [payload.outMirrorId, res.outgoing.id],
          [payload.inMirrorId, res.incoming.id],
        ] as const) {
          await repo.insertMirrorRow({
            chainId: member.chainId,
            kind: 'cash_movement',
            mirrorId,
            portfolioId,
            localId,
            createdBy: meta.actorUserId,
            createdByUsername: meta.actorUsername,
          });
        }
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

  // ── Public surface ─────────────────────────────────────────────────────────

  const service: MirrorService = {
    syncedMembership(portfolioId) {
      return repo.findActiveMembershipByPortfolio(portfolioId);
    },

    async convertToChain(userId, portfolioId, opts) {
      const row = await portfolioRepo.findByIdForUser(userId, portfolioId);
      if (!row) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
      if (await repo.findActiveMembershipByPortfolio(portfolioId)) {
        throw badRequest('This portfolio is already a group portfolio.', 'MIRROR_ALREADY_SYNCED');
      }
      const username = await usernameOf(userId);
      const name = opts?.name?.trim() || row.name;
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
      // Main first, so the source listing below always contains it (§8).
      await cashSourceRepo.getOrCreateMain(portfolioId);
      const [sources, txns, dividends, movements] = await Promise.all([
        cashSourceRepo.listForPortfolio(portfolioId, { includeArchived: true }),
        transactionRepo.listForPortfolio(portfolioId),
        taxRepo.listForPortfolio(portfolioId),
        cashMovementRepo.listForPortfolio(portfolioId),
      ]);
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
      await repo.appendOpsChecked(chainId, userId, [
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
        const ops = await repo.listOpsSince(chainId, member.appliedSeq);
        try {
          applied += await applyOpsToMember(member, ops);
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
        const first = failures[0]!.err;
        throw new Error(
          `mirror.replicate: ${failures.length} of ${members.length} copies stalled on chain ${chainId}: ${
            first instanceof Error ? first.message : String(first)
          }`,
        );
      }
      return { applied, lagging };
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
        for (const movement of [created.outgoing, created.incoming]) {
          await repo.insertMirrorRow({
            chainId: member.chainId,
            kind: 'cash_movement',
            mirrorId: movement.id,
            portfolioId,
            localId: movement.id,
            createdBy: userId,
            createdByUsername: username,
          });
        }
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
