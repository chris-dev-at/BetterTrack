import { access, chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';

import { and, arrayContains, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  EXPORT_PENDING_STALE_MS,
  type ExportRequest,
  type ExportStatus,
  type VaultDocKind,
  type VaultMediaList,
  type VaultMediaSet,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { Database } from '../../data/db';
import type { ExportRepository } from '../../data/repositories/exportRepository';
import {
  paranoidVaults,
  portfolioVaultTransitionStates,
  users,
  vaultBlobs,
  vaults as vaultConfigs,
  type ExportJobRow,
} from '../../data/schema';
import type { UserRepository } from '../../data/repositories/userRepository';
import { ApiError, badRequest, notFound, tooManyRequests, unauthorized } from '../../errors';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import { ACCOUNT_EXPORT_NAMESPACE } from '../auth/loginThrottle';
import type { TwoFactorService } from '../auth/twoFactorService';
import { generateToken, hashToken } from '../crypto/tokens';
import type { NotificationCenter } from '../notifications/notificationCenter';
import type { PasswordHasher } from '../password/passwordHasher';
import { createProgressiveLimiter } from '../security/progressiveLimiter';

import { collectUserExport } from './collector';
import { EXPORT_MAX_CONTENT_BYTES, EXPORT_TOO_LARGE, ExportTooLargeError } from './limits';
import { buildExportZip, type VaultCiphertextExport } from './zip';

/** One request per this window per user (§13.4 V4-P6a "rate-limited 1/day"). */
export const EXPORT_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
/** How long a ready export stays downloadable before the cleanup job prunes it. */
export const EXPORT_DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How old an export-directory file must be before the sweep may treat it as an
 * orphan (#1714). A build writes `<jobId>.zip.building`, renames it, and only
 * then records the path, so a file younger than this may simply belong to a
 * build in flight. An hour is far beyond any build's runtime and far below the
 * 24 h download window, so no live artifact is ever a candidate.
 */
export const EXPORT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Files one sweep may examine; the rest are deferred to the next run. */
export const EXPORT_SWEEP_MAX_ENTRIES = 5_000;

/**
 * Delay on each re-drive of a build deferred by a portfolio-vault finalization
 * (#1812). Matched to the finalize sweep's interval
 * (`PORTFOLIO_VAULT_FINALIZE_INTERVAL_MS`, 60 s) — that sweep is the only thing
 * that clears the marker being waited on, and the queue's own retry ladder (3
 * attempts, exponential backoff from 1 s) is spent inside ~3 s, i.e. long
 * before the first sweep tick. A deferral must therefore run on the sweep's
 * clock, not on BullMQ's.
 */
export const EXPORT_DEFERRAL_RETRY_DELAY_MS = 60_000;

/**
 * How long a build may keep being deferred before it gives up. Far past the
 * few sweep ticks a finalization needs; a marker still set after this means the
 * finalization itself is stuck, and a job that waits forever would hold the
 * export surface (which hides the request form while `pending`) hostage.
 */
export const EXPORT_DEFERRAL_MAX_MS = 15 * 60 * 1000;

/** The coarse reason persisted when a deferred build ran out of patience. */
export const EXPORT_DEFERRED = 'EXPORT_DEFERRED';

/**
 * Server-resident vault documents read per statement while packaging. The
 * pre-flight byte sum already bounds the total, and the ciphertext is buffered
 * whole either way; this keeps ONE result set from being the whole budget.
 */
export const EXPORT_VAULT_BLOB_READ_CHUNK = 25;

/**
 * Absolute ceiling on how long ONE download may hold the account transition
 * lock. The route's `res.setTimeout` is an inactivity timeout: a client reading
 * one byte per interval resets it forever and pins a connection of the dedicated
 * privacy-lock pool (`max: 10`) idle-in-transaction, which blocks that account's
 * privacy transitions, starves other guarded reads and stalls vacuum. This bound
 * is absolute — a slow reader is released here no matter how it paces its reads.
 * Generous enough that a legitimate transfer finishes: even the largest archive
 * the ceiling admits needs well under 500 KB/s to land inside it.
 */
export const EXPORT_DOWNLOAD_MAX_MS = 10 * 60 * 1000;

/** Raised when a download outlives {@link EXPORT_DOWNLOAD_MAX_MS}. */
export class ExportDownloadDeadlineError extends Error {
  constructor() {
    super('The export download exceeded its time limit.');
    this.name = 'ExportDownloadDeadlineError';
  }
}

/**
 * What one pass under the account transition lock achieved: the build ran (or
 * had nothing left to do), or it must wait for a portfolio-vault finalization
 * and be re-driven from outside the lock.
 */
type BuildOutcome = 'built' | 'deferred';

/** Map key for one server-resident vault document (`vault_blobs` PK). */
const vaultBlobAddress = (vaultId: string, docId: string): string => `${vaultId}:${docId}`;

/** One current vault document as packaged: its bytes and the metadata describing them. */
type PackagedVaultDoc = VaultCiphertextExport['docs'][number];

export interface ExportServiceDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  exportRepo: ExportRepository;
  userRepo: UserRepository;
  passwordHasher: PasswordHasher;
  twoFactor: TwoFactorService;
  audit: AuditService;
  notify: NotificationCenter;
  /**
   * Hand the created job to the async builder: production enqueues onto the
   * `data.export` BullMQ queue; tests run {@link ExportService.buildExport}
   * synchronously (BullMQ can't run on ioredis-mock). `delayMs` re-drives the
   * same job later — how a build deferred by a vault finalization waits for the
   * sweep that clears it. A failure here is recorded on the row (never a silent
   * `pending` nothing will ever build), not raised at the requester.
   */
  enqueueBuild(jobId: string, opts?: { delayMs?: number }): Promise<void>;
  /**
   * Hold the same account-row lock paranoid enable takes exclusively. Builders,
   * downloads, and cleanup keep this lock for their complete file lifetime.
   */
  withAccountTransitionLock<T>(userId: string, run: () => Promise<T>): Promise<T>;
  logger?: Logger;
  /** Test seam: controllable clock. */
  now?: () => Date;
  /** Test seam: pause after collection while the account lock remains held. */
  afterCollect?: (userId: string) => void | Promise<void>;
  /** Test seam: shrink the build ceilings so the refusal path is provable. */
  limits?: { maxRows?: number; maxContentBytes?: number };
  /** Test seam: shrink {@link EXPORT_DOWNLOAD_MAX_MS}. */
  downloadMaxMs?: number;
}

export interface ExportStatusView {
  status: ExportStatus | null;
  jobId: string | null;
  requestedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  /** Coarse failure reason on a failed job (e.g. `EXPORT_TOO_LARGE`); else null. */
  error: string | null;
}

export interface ExportRequestResult {
  jobId: string;
  status: ExportStatus;
  downloadToken: string;
}

export interface ExportDownload {
  filePath: string;
  fileName: string;
  fileSize: number;
}

export interface ExportService {
  /** 1/day gate + re-auth → create the job, enqueue the build, return the raw token once. */
  requestExport(input: {
    userId: string;
    body: ExportRequest;
    ip?: string | null;
  }): Promise<ExportRequestResult>;
  /** The caller's latest job as a status view (never a secret). */
  getStatus(userId: string): Promise<ExportStatusView>;
  /** Build the zip for a job (the async worker body); idempotent on a ready job. */
  buildExport(jobId: string): Promise<void>;
  /**
   * Resolve (without consuming) a download for `(user, token)`; throws 404 when
   * it fails closed.
   *
   * Inspection only — it hands back a resolved archive path and never spends the
   * one-time token, so it must not be used to serve one. Every serving path goes
   * through {@link ExportService.withDownload}, which spends the token exactly
   * once the transfer has completed (#1812); the HTTP route is wired to that.
   */
  resolveDownload(input: { userId: string; token: string }): Promise<ExportDownload>;
  /**
   * Stream a download while holding the transition lock, and spend its one-time
   * token only once the transfer completes — an interrupted transfer leaves the
   * token usable for a retry inside the download window. The signal aborts when
   * the absolute {@link EXPORT_DOWNLOAD_MAX_MS} bound elapses — the caller must
   * stop streaming; the lock is released at that point regardless.
   */
  withDownload(
    input: { userId: string; token: string },
    use: (file: ExportDownload, signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  /** Delete every expired export's file + row; returns how many were pruned. */
  cleanupExpired(): Promise<number>;
  /**
   * Delete every file in the export directory no job row points at any more —
   * the artifacts a crash, a kill, or a lost row pointer would otherwise strand
   * forever. Returns how many were removed.
   */
  sweepOrphanedArtifacts(): Promise<number>;
  /**
   * Delete the user's export archives and their rows. Called before an account
   * is hard-deleted, where the FK cascade would otherwise drop the rows and
   * leave the cleartext archives behind with nothing able to reap them.
   */
  purgeUserArtifacts(userId: string): Promise<number>;
}

export function createExportService(deps: ExportServiceDeps): ExportService {
  const {
    config,
    db,
    redis,
    exportRepo,
    userRepo,
    passwordHasher,
    twoFactor,
    audit,
    notify,
    enqueueBuild,
    withAccountTransitionLock,
    logger,
  } = deps;
  const now = deps.now ?? (() => new Date());
  const dir = config.dataExport.dir;
  const downloadMaxMs = deps.downloadMaxMs ?? EXPORT_DOWNLOAD_MAX_MS;
  // Deployment-configurable (BT_EXPORT_MAX_CONTENT_BYTES) so an account whose
  // legitimate ciphertext outgrows the built-in default stays exportable — the
  // over-ceiling refusal is terminal, so without a knob such an account could
  // never obtain its §6.1 archive (#1812).
  const maxContentBytes =
    deps.limits?.maxContentBytes ?? config.dataExport.maxContentBytes ?? EXPORT_MAX_CONTENT_BYTES;

  const throttle = createProgressiveLimiter(
    redis,
    ACCOUNT_EXPORT_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  const filePathFor = (jobId: string) => joinPath(dir, `${jobId}.zip`);

  const hasPendingPortfolioMoveOut = async (userId: string): Promise<boolean> => {
    const [pending] = await db
      .select({ portfolioId: portfolioVaultTransitionStates.portfolioId })
      .from(portfolioVaultTransitionStates)
      .where(
        and(
          eq(portfolioVaultTransitionStates.userId, userId),
          eq(portfolioVaultTransitionStates.moveOutPostCommitPending, true),
        ),
      )
      .limit(1);
    return Boolean(pending);
  };

  const fileExists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Read the current server-resident vault documents in bounded batches, keyed
   * by their `(vaultId, docId)` address. Owner-scoped in SQL exactly like the
   * manifest projection it follows, and batched on BOTH halves of the PK, so
   * `EXPORT_VAULT_BLOB_READ_CHUNK` rows per statement is an exact bound even
   * when two of a user's vaults share a `docId`.
   *
   * The manifest fields are read WITH the bytes, in the same row: the earlier
   * projection and this read are two statements without a shared snapshot, and
   * vault writes do not take the account transition lock. Describing the blob by
   * the row it came from is what keeps `manifest.json` true of the `.btvault`
   * beside it when a doc is rewritten mid-build (#1812).
   */
  const readVaultBlobs = async (
    userId: string,
    addresses: { vaultId: string; docId: string }[],
  ): Promise<Map<string, PackagedVaultDoc>> => {
    const byAddress = new Map<string, PackagedVaultDoc>();
    const docIdsByVault = new Map<string, string[]>();
    for (const address of addresses) {
      const docIds = docIdsByVault.get(address.vaultId);
      if (docIds) docIds.push(address.docId);
      else docIdsByVault.set(address.vaultId, [address.docId]);
    }
    for (const [vaultId, docIds] of docIdsByVault) {
      for (let i = 0; i < docIds.length; i += EXPORT_VAULT_BLOB_READ_CHUNK) {
        const chunk = docIds.slice(i, i + EXPORT_VAULT_BLOB_READ_CHUNK);
        const rows = await db
          .select({
            docId: vaultBlobs.docId,
            docKind: vaultBlobs.docKind,
            version: vaultBlobs.version,
            formatVersion: vaultBlobs.formatVersion,
            sizeBytes: vaultBlobs.sizeBytes,
            updatedAt: vaultBlobs.updatedAt,
            blob: vaultBlobs.blob,
          })
          .from(vaultBlobs)
          .innerJoin(vaultConfigs, eq(vaultConfigs.id, vaultBlobs.vaultId))
          .where(
            and(
              eq(vaultConfigs.userId, userId),
              eq(vaultBlobs.vaultId, vaultId),
              inArray(vaultBlobs.docId, chunk),
            ),
          );
        for (const row of rows) {
          byAddress.set(vaultBlobAddress(vaultId, row.docId), {
            docId: row.docId,
            docKind: row.docKind as VaultDocKind,
            version: row.version,
            formatVersion: row.formatVersion,
            sizeBytes: row.sizeBytes,
            updatedAt: row.updatedAt,
            blob: row.blob,
          });
        }
      }
    }
    return byAddress;
  };

  /**
   * Record a coarse terminal failure on a row, never raising. Used on the paths
   * whose whole point is that the row must not be left `pending` — a throw here
   * would put back exactly the state being avoided.
   */
  const markFailedSafely = async (jobId: string, error: string): Promise<boolean> => {
    try {
      await exportRepo.markFailed(jobId, error);
      return true;
    } catch (err) {
      logger?.error({ err, jobId, error }, 'export: recording the job failure failed');
      return false;
    }
  };

  /**
   * Whether an existing job still holds the caller's 1/day slot. Mirrors
   * `reserveWithinRateLimit`'s condition exactly (a failed row never holds it,
   * and neither does a `pending` one that can no longer make progress) so the
   * cheap pre-check and the authoritative reservation can never disagree.
   */
  const holdsDailySlot = (row: ExportJobRow, requestedAt: Date): boolean => {
    if (row.status === 'failed') return false;
    if (
      row.status === 'pending' &&
      row.createdAt.getTime() <= requestedAt.getTime() - EXPORT_PENDING_STALE_MS
    ) {
      return false;
    }
    return row.createdAt.getTime() > requestedAt.getTime() - EXPORT_RATE_LIMIT_MS;
  };

  const rateLimited = (requestedAt: Date, latest: ExportJobRow): ApiError => {
    const elapsed = requestedAt.getTime() - latest.createdAt.getTime();
    const retryAfter = Math.ceil((EXPORT_RATE_LIMIT_MS - elapsed) / 1000);
    return new ApiError(
      429,
      'EXPORT_RATE_LIMITED',
      'You can request a data export once per day. Please try again later.',
      { retryAfter },
    );
  };

  /**
   * Re-drive a build the portfolio-vault finalization deferred, on the sweep's
   * clock rather than the queue's spent retry ladder. Runs OUTSIDE the account
   * transition lock (the re-drive must not re-enter it), and gives up into a
   * terminal — but immediately re-requestable — `failed` row once the deferral
   * window is exhausted, so `getStatus` can never stay `pending` forever.
   */
  const deferBuild = async (job: ExportJobRow): Promise<void> => {
    const waitedMs = now().getTime() - job.createdAt.getTime();
    if (waitedMs >= EXPORT_DEFERRAL_MAX_MS) {
      logger?.error(
        { jobId: job.id, waitedMs },
        'export build: portfolio vault finalization never cleared; failing the job',
      );
      await markFailedSafely(job.id, EXPORT_DEFERRED);
      return;
    }
    try {
      await enqueueBuild(job.id, { delayMs: EXPORT_DEFERRAL_RETRY_DELAY_MS });
      logger?.warn(
        { jobId: job.id, waitedMs, delayMs: EXPORT_DEFERRAL_RETRY_DELAY_MS },
        'export build deferred by portfolio vault finalization; re-driven after the finalize interval',
      );
    } catch (err) {
      // Nothing else will ever come back for this row.
      logger?.error({ err, jobId: job.id }, 'export build: deferred re-drive could not be queued');
      await markFailedSafely(job.id, EXPORT_DEFERRED);
    }
  };

  async function resolveDownloadUnlocked(input: {
    userId: string;
    token: string;
  }): Promise<ExportDownload> {
    // E4 restores the cleartext graph atomically, then converges derived rows
    // from a durable retry plan. Do not consume a one-shot download token or
    // stream an archive while those derived rows may still be incomplete.
    if (await hasPendingPortfolioMoveOut(input.userId)) {
      throw notFound('This export is no longer available.', 'EXPORT_NOT_FOUND');
    }
    if (!input.token) throw badRequest('A download token is required.', 'EXPORT_TOKEN_REQUIRED');
    const row = await exportRepo.findDownloadable({
      userId: input.userId,
      downloadTokenHash: hashToken(input.token),
      now: now(),
    });
    // Resolution validates the token but does NOT spend it: the token is
    // consumed only once the transfer completes, so a socket dropped at 90 %
    // leaves a retry possible inside the TTL instead of stranding a valid
    // archive behind a 429 for the rest of the day (#1812). A foreign, expired,
    // already-consumed, unknown or not-yet-ready token is one indistinguishable
    // 404 — never a distinct signal to a probing caller.
    if (!row || !row.filePath) {
      throw notFound('This export is no longer available.', 'EXPORT_NOT_FOUND');
    }
    // A `ready` row whose archive is gone from disk joins that same 404 instead of
    // becoming a 500 on the stream. The pointer can outlive the bytes: a paranoid
    // enable stages and unlinks the archive BEFORE its transaction commits, and
    // that transaction is allowed to fail outcome-ambiguously afterwards (see
    // `permanentlyRetirePrepared` — never restore an archive once unlink started),
    // rolling the row back to `ready` with a `filePath` that no longer resolves.
    // Operator-side deletion lands here too. Checked while the account transition
    // lock is held, so an enable cannot slip in between this probe and the stream.
    if (!(await fileExists(row.filePath))) {
      logger?.warn(
        { jobId: row.id },
        'export download: the ready archive is missing from disk; failing closed',
      );
      throw notFound('This export is no longer available.', 'EXPORT_NOT_FOUND');
    }
    const stamp = row.readyAt ?? row.createdAt;
    const day = stamp.toISOString().slice(0, 10);
    return {
      filePath: row.filePath,
      fileName: `bettertrack-export-${day}.zip`,
      fileSize: row.fileSize ?? 0,
    };
  }

  /** Count one failed re-auth, audit it, raise the right error. */
  async function failReauth(userId: string, ip: string | null | undefined, kind: string) {
    const decision = await throttle.consume(userId);
    await audit.record({
      action: AuditAction.AccountExportFail,
      targetType: 'user',
      targetId: userId,
      ip,
      meta: { kind, locked: !decision.allowed },
    });
    if (!decision.allowed) {
      throw tooManyRequests(decision.retryAfterSec, 'Too many attempts. Please wait and retry.');
    }
    if (kind === 'password') {
      throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
    }
    throw unauthorized('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
  }

  /** Verify the re-auth credential; throws on failure (mirrors account deletion). */
  async function verifyReauth(
    userId: string,
    body: ExportRequest,
    ip: string | null | undefined,
  ): Promise<void> {
    const user = await userRepo.findById(userId);
    if (!user) throw unauthorized();

    // Reject an already-cooling account before any credential verify, so a
    // blocked retry — even with a correct credential — can't ride through.
    const cooling = await throttle.peek(userId);
    if (cooling > 0) {
      throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
    }

    if (body.password !== undefined) {
      const ok = await passwordHasher.verify(user.passwordHash, body.password);
      if (!ok) await failReauth(userId, ip, 'password');
    } else if (!(await twoFactor.isEnabled(userId))) {
      throw unauthorized('Re-authenticate with your password.', 'TWO_FACTOR_NOT_ENABLED');
    } else if (body.recoveryCode !== undefined) {
      const ok = await twoFactor.consumeRecoveryCode(userId, body.recoveryCode);
      if (!ok) await failReauth(userId, ip, 'recovery_code');
    } else {
      const ok = await twoFactor.verifyTotpCode(userId, body.code!);
      if (!ok) await failReauth(userId, ip, 'totp');
    }
    await throttle.reset(userId);
  }

  function toStatus(row: ExportJobRow | null): ExportStatusView {
    if (!row) {
      return {
        status: null,
        jobId: null,
        requestedAt: null,
        expiresAt: null,
        sizeBytes: null,
        error: null,
      };
    }
    // A ready file past its window reads as `expired` (the cleanup job may not
    // have swept it yet), so the UI never offers a dead download link.
    const expired =
      row.status === 'ready' &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() <= now().getTime();
    return {
      status: expired ? 'expired' : row.status,
      jobId: row.id,
      requestedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      sizeBytes: row.fileSize ?? null,
      // Only meaningful on a failed row; a coarse code, never a stack.
      error: row.status === 'failed' ? row.error : null,
    };
  }

  return {
    async requestExport({ userId, body, ip }) {
      const requestedAt = now();
      // The 1/day gate is consulted BEFORE the re-auth, because verifying the
      // credential can destroy it: a matching recovery code is spent by the
      // very act of checking it (`used_at` is set on success), so a request the
      // allowance was always going to refuse must never reach that check and
      // burn a single-use code for a 429 (#1812). The reservation below stays
      // the authoritative, atomic gate — this is only the cheap non-destructive
      // pre-check, and it uses exactly the same condition.
      const latest = await exportRepo.findLatestForUser(userId);
      if (latest && holdsDailySlot(latest, requestedAt)) {
        throw rateLimited(requestedAt, latest);
      }

      await verifyReauth(userId, body, ip);

      const { token, tokenHash } = generateToken();
      const reservation = await exportRepo.reserveWithinRateLimit({
        userId,
        downloadTokenHash: tokenHash,
        since: new Date(requestedAt.getTime() - EXPORT_RATE_LIMIT_MS),
        stalePendingBefore: new Date(requestedAt.getTime() - EXPORT_PENDING_STALE_MS),
      });
      if (reservation.kind === 'rate_limited') {
        throw rateLimited(requestedAt, reservation.latest);
      }
      const { job } = reservation;
      await audit.record({
        action: AuditAction.AccountExportRequested,
        targetType: 'user',
        targetId: userId,
        ip,
        meta: { jobId: job.id },
      });

      try {
        await enqueueBuild(job.id);
      } catch (err) {
        // The row exists; a failed enqueue is an incident to log, not a request
        // failure (the user already re-authed and holds their token). It must
        // NOT be swallowed silently though: nothing will ever build this job, so
        // a row left `pending` would hide the request form and hold the daily
        // allowance for 24 h. Recorded as a failure the user can retry from — a
        // `failed` row consumes no allowance (#1812).
        logger?.error({ err, jobId: job.id }, 'export build enqueue failed');
        const recorded = await markFailedSafely(job.id, 'BUILD_FAILED');
        return {
          jobId: job.id,
          status: recorded ? 'failed' : job.status,
          downloadToken: token,
        };
      }

      return { jobId: job.id, status: job.status, downloadToken: token };
    },

    async getStatus(userId) {
      return toStatus(await exportRepo.findLatestForUser(userId));
    },

    async buildExport(jobId) {
      const job = await exportRepo.findById(jobId);
      if (!job) {
        logger?.warn({ jobId }, 'export build: job gone');
        return;
      }
      // Idempotent under BullMQ's at-least-once: a job already ready with its
      // file on disk is a no-op (a retry after a successful build).
      if (job.status === 'ready' && job.filePath) return;

      const outcome = await withAccountTransitionLock(
        job.userId,
        async (): Promise<BuildOutcome> => {
          const lockedJob = await exportRepo.findById(jobId);
          if (!lockedJob || (lockedJob.status === 'ready' && lockedJob.filePath)) return 'built';
          // Building now could capture restored cleartext before all derived rows
          // converge, depending on which finalizer phase won the lock. Reported
          // out of the lock (rather than thrown) so the re-drive is scheduled on
          // the finalize sweep's clock: the queue's own retry ladder is spent
          // inside ~3 s, i.e. before the sweep that clears the marker has run
          // once, which used to dead-letter the job and wedge the row (#1812).
          if (await hasPendingPortfolioMoveOut(job.userId)) return 'deferred';
          const filePath = filePathFor(jobId);
          const buildingPath = `${filePath}.building`;
          // Where the completion sequence got to, so the catch can tell an
          // unreferenced finished archive (must be removed) from one the row now
          // points at (must be kept).
          let renamed = false;
          let ready = false;
          try {
            const [accountRows, vaultDocRows] = await Promise.all([
              db
                .select({
                  privacyMode: users.privacyMode,
                  mediaSet: users.paranoidMediaSet,
                })
                .from(users)
                .where(eq(users.id, job.userId))
                .limit(1),
              // E1 per-vault ciphertext is independent of the legacy account-wide
              // privacy flag. Select only the vault addresses and their DECLARED
              // sizes — WITHOUT the opaque bytes — owner-scoped in SQL; the LEFT
              // JOIN keeps an empty server-backed vault visible in the manifest.
              // The bytes, and the metadata that describes them, are read below
              // once these declared sizes have been checked against the packaging
              // ceiling: a per-doc cap times an uncapped number of vaulted
              // portfolios is otherwise gigabytes resident in the worker before
              // any limit is consulted (#1812).
              db
                .select({
                  vaultId: vaultConfigs.id,
                  media: vaultConfigs.media,
                  docId: vaultBlobs.docId,
                  sizeBytes: vaultBlobs.sizeBytes,
                })
                .from(vaultConfigs)
                .leftJoin(vaultBlobs, eq(vaultBlobs.vaultId, vaultConfigs.id))
                .where(
                  and(
                    eq(vaultConfigs.userId, job.userId),
                    arrayContains(vaultConfigs.media, ['server']),
                  ),
                ),
            ]);
            const [account] = accountRows;
            if (!account) return 'built';

            const paranoid = account.privacyMode === 'paranoid';
            // Same treatment for the legacy account-wide vault: its declared size
            // joins the pre-flight sum, its bytes are read afterwards.
            const [paranoidVaultMeta] =
              paranoid && (account.mediaSet as VaultMediaSet | null)?.includes('server')
                ? await db
                    .select({
                      version: paranoidVaults.version,
                      formatVersion: paranoidVaults.formatVersion,
                      sizeBytes: paranoidVaults.sizeBytes,
                      updatedAt: paranoidVaults.updatedAt,
                    })
                    .from(paranoidVaults)
                    .where(eq(paranoidVaults.userId, job.userId))
                    .limit(1)
                : [];

            // Pre-flight packaging budget, applied to the DECLARED ciphertext
            // sizes before a single byte is materialized. Same contract the row
            // ceiling states for itself: refuse the runaway account without ever
            // allocating it. `addFile` remains the authoritative accounting of
            // everything the archive actually carries.
            const ciphertextBytes =
              vaultDocRows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0) +
              (paranoidVaultMeta?.sizeBytes ?? 0);
            if (ciphertextBytes > maxContentBytes) {
              throw new ExportTooLargeError('content_bytes', ciphertextBytes, maxContentBytes);
            }

            const docsByAddress = await readVaultBlobs(
              job.userId,
              vaultDocRows
                .filter((row) => row.docId !== null)
                .map((row) => ({ vaultId: row.vaultId, docId: row.docId! })),
            );

            const vaultsById = new Map<string, VaultCiphertextExport>();
            for (const row of vaultDocRows) {
              let vault = vaultsById.get(row.vaultId);
              if (!vault) {
                vault = {
                  vaultId: row.vaultId,
                  media: row.media as VaultMediaList,
                  docs: [],
                };
                vaultsById.set(row.vaultId, vault);
              }
              if (row.docId === null) continue;
              const doc = docsByAddress.get(vaultBlobAddress(row.vaultId, row.docId));
              // The doc was removed between the address read and the byte read.
              // Not packageable as read; a plain build failure the queue retries,
              // never a half-truthful archive. A doc REWRITTEN in that window is
              // packaged from its own row, so the manifest still describes the
              // bytes carried beside it.
              if (!doc) throw new Error('current vault document vanished mid-build');
              vault.docs.push(doc);
            }

            const collected = await collectUserExport(db, job.userId, {
              serverOnly: paranoid,
              ...(deps.limits?.maxRows !== undefined ? { maxRows: deps.limits.maxRows } : {}),
            });
            await deps.afterCollect?.(job.userId);
            // Re-read the metadata WITH the bytes, for the same reason the
            // per-vault docs do: the pre-flight projection above is a separate
            // statement, so a vault rewritten in between would otherwise be
            // described by the version/size it no longer has.
            const [paranoidBlobRow] = paranoidVaultMeta
              ? await db
                  .select({
                    version: paranoidVaults.version,
                    formatVersion: paranoidVaults.formatVersion,
                    sizeBytes: paranoidVaults.sizeBytes,
                    updatedAt: paranoidVaults.updatedAt,
                    blob: paranoidVaults.blob,
                  })
                  .from(paranoidVaults)
                  .where(eq(paranoidVaults.userId, job.userId))
                  .limit(1)
              : [];
            // A vault written away between the two reads simply is not packaged;
            // the manifest then reports `included: false` rather than claiming a
            // file the archive does not carry.
            const vault = paranoidVaultMeta && paranoidBlobRow ? paranoidBlobRow : undefined;
            const generatedAt = now();
            const zip = buildExportZip({
              userId: job.userId,
              collected,
              generatedAt,
              vaults: [...vaultsById.values()],
              maxContentBytes,
              ...(paranoid
                ? {
                    paranoid: {
                      mediaSet: account.mediaSet as VaultMediaSet,
                      vault: vault ?? null,
                    },
                  }
                : {}),
            });
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await chmod(dir, 0o700);
            await writeFile(buildingPath, zip, { mode: 0o600 });
            await chmod(buildingPath, 0o600);
            await rename(buildingPath, filePath);
            renamed = true;
            await exportRepo.markReady({
              id: jobId,
              filePath,
              fileSize: zip.byteLength,
              expiresAt: new Date(generatedAt.getTime() + EXPORT_DOWNLOAD_TTL_MS),
              readyAt: generatedAt,
            });
            ready = true;
          } catch (err) {
            await rm(buildingPath, { force: true }).catch((rmErr) => {
              logger?.warn({ err: rmErr, jobId }, 'export build: temp file unlink failed');
            });
            // The renamed archive is a complete cleartext copy of the account that
            // no row points at — nothing would ever reap it (the cleanup sweep
            // only unlinks paths recorded on a row). Remove it here. If `markReady`
            // failed outcome-ambiguously and the row did commit, the row now points
            // at a missing file, which `resolveDownloadUnlocked` already fails
            // closed on, and the `failed` status below matches that reality.
            if (renamed && !ready) {
              await rm(filePath, { force: true }).catch((rmErr) => {
                logger?.warn({ err: rmErr, jobId }, 'export build: orphan archive unlink failed');
              });
            }
            logger?.error({ err, jobId }, 'export build failed');
            if (err instanceof ExportTooLargeError) {
              // Deterministic: the same account exceeds the same ceiling on every
              // attempt, so this is a terminal, typed failure rather than work to
              // re-queue. A `failed` row does not consume the 1/day allowance
              // (`reserveWithinRateLimit` ignores failed jobs), so the user can
              // act and retry immediately.
              await exportRepo.markFailed(jobId, EXPORT_TOO_LARGE);
              logger?.error(
                { jobId, dimension: err.dimension, measured: err.measured, limit: err.limit },
                'export build refused: account exceeds the export ceiling',
              );
              return 'built';
            }
            await exportRepo.markFailed(jobId, 'BUILD_FAILED');
            throw err;
          }
          // Outside the failure path on purpose: the archive is on disk, the row is
          // `ready`, and the token is live. A failed notice must not roll that back
          // to `failed` — the old ordering left a valid token whose download could
          // then only 404 forever. The build is complete either way; the user still
          // sees `ready` when they poll.
          try {
            // Inform the owner (inbox / push): the notice deep-links to the export
            // block in Settings → Account. It carries NO token.
            await notify.emit({
              type: 'account.data_export',
              userId: job.userId,
              occurredAt: now().toISOString(),
            });
          } catch (err) {
            logger?.warn({ err, jobId }, 'export build: ready notification failed');
          }
          return 'built';
        },
      );
      // Scheduled outside the lock: the re-drive must not re-enter it.
      if (outcome === 'deferred') await deferBuild(job);
    },

    resolveDownload({ userId, token }) {
      return withAccountTransitionLock(userId, () => resolveDownloadUnlocked({ userId, token }));
    },

    withDownload(input, use) {
      return withAccountTransitionLock(input.userId, async () => {
        const file = await resolveDownloadUnlocked(input);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), downloadMaxMs);
        // A pending download bound must never be what keeps the process alive.
        timer.unref?.();
        const streamed = use(file, controller.signal);
        // The race can settle before `streamed` does; keep its later rejection
        // from surfacing as an unhandled rejection.
        streamed.catch(() => undefined);
        try {
          // The abort tells the caller to stop streaming, and the race releases
          // the account lock (and with it the pooled connection and its open
          // transaction) at the deadline whether or not the caller cooperates.
          await Promise.race([
            streamed,
            new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener(
                'abort',
                () => reject(new ExportDownloadDeadlineError()),
                { once: true },
              );
            }),
          ]);
          // Only a COMPLETED transfer spends the one-time token — a dropped
          // socket, a stall or the absolute deadline leaves it live for a retry
          // inside the download window. Still inside the account transition
          // lock, so no concurrent download can slip between the two.
          const consumed = await exportRepo.consumeDownloadable({
            userId: input.userId,
            downloadTokenHash: hashToken(input.token),
            now: now(),
          });
          if (!consumed) {
            logger?.warn(
              { userId: input.userId },
              'export download: the token was already gone when the transfer completed',
            );
          }
        } finally {
          clearTimeout(timer);
        }
      });
    },

    async cleanupExpired() {
      const expired = await exportRepo.findExpired(now());
      let pruned = 0;
      for (const row of expired) {
        await withAccountTransitionLock(row.userId, async () => {
          const current = await exportRepo.findById(row.id);
          if (!current || !current.expiresAt || current.expiresAt > now()) return;
          if (current.filePath) {
            // `force` swallows ENOENT so a missing file still prunes cleanly.
            await rm(current.filePath, { force: true }).catch((err) => {
              logger?.warn({ err, jobId: current.id }, 'export cleanup: file unlink failed');
            });
          }
          await exportRepo.deleteById(current.id);
          pruned += 1;
        });
      }
      return pruned;
    },

    async sweepOrphanedArtifacts() {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
        logger?.warn({ err }, 'export sweep: export directory is unreadable');
        return 0;
      }
      const artifacts = entries.filter(
        (name) => name.endsWith('.zip') || name.endsWith('.zip.building'),
      );
      // Bounded work per run: a directory that somehow grew huge must not turn
      // one cleanup tick into an unbounded stat/unlink storm. The remainder is
      // simply swept on the next run.
      const scanned = artifacts.slice(0, EXPORT_SWEEP_MAX_ENTRIES);
      if (artifacts.length > scanned.length) {
        logger?.warn(
          { scanned: scanned.length, deferred: artifacts.length - scanned.length },
          'export sweep: entry cap reached; the remaining files are deferred to the next run',
        );
      }
      const cutoff = now().getTime() - EXPORT_ORPHAN_GRACE_MS;
      const candidates: string[] = [];
      for (const name of scanned) {
        const path = joinPath(dir, name);
        const info = await stat(path).catch(() => null);
        // Younger than the grace window ⇒ it may belong to a build in flight
        // (written, maybe renamed, not yet recorded). Never a candidate.
        if (!info || !info.isFile() || info.mtimeMs > cutoff) continue;
        candidates.push(path);
      }
      // A `.building` path is never recorded on a row, so it can only ever be a
      // leftover; a `.zip` survives exactly as long as some row points at it.
      const referenced = await exportRepo.findReferencedFilePaths(candidates);
      let removed = 0;
      for (const path of candidates) {
        if (referenced.has(path)) continue;
        try {
          await rm(path, { force: true });
          removed += 1;
        } catch (err) {
          logger?.warn({ err }, 'export sweep: orphan unlink failed');
        }
      }
      if (removed > 0) logger?.warn({ removed }, 'export sweep: orphaned artifacts removed');
      return removed;
    },

    async purgeUserArtifacts(userId) {
      return withAccountTransitionLock(userId, async () => {
        const rows = await exportRepo.findAllForUser(userId);
        let purged = 0;
        for (const row of rows) {
          if (row.filePath) {
            // `force` swallows ENOENT: an already-gone file still purges cleanly.
            await rm(row.filePath, { force: true }).catch((err) => {
              logger?.warn({ err, jobId: row.id }, 'export purge: file unlink failed');
            });
          }
          await exportRepo.deleteById(row.id);
          purged += 1;
        }
        return purged;
      });
    },
  };
}
