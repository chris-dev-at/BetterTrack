import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';

import type { Redis } from 'ioredis';

import type { ExportRequest, ExportStatus } from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { Database } from '../../data/db';
import type { ExportRepository } from '../../data/repositories/exportRepository';
import type { ExportJobRow } from '../../data/schema';
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
import { buildExportZip } from './zip';

/** One request per this window per user (§13.4 V4-P6a "rate-limited 1/day"). */
export const EXPORT_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
/** How long a ready export stays downloadable before the cleanup job prunes it. */
export const EXPORT_DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

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
   * synchronously (BullMQ can't run on ioredis-mock). Failures here never fail
   * the request — the row exists and the job (or a manual re-drive) builds it.
   */
  enqueueBuild(jobId: string): Promise<void>;
  logger?: Logger;
  /** Test seam: controllable clock. */
  now?: () => Date;
}

export interface ExportStatusView {
  status: ExportStatus | null;
  jobId: string | null;
  requestedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
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
  /** Re-auth + 1/day gate → create the job, enqueue the build, return the raw token once. */
  requestExport(input: {
    userId: string;
    body: ExportRequest;
    ip?: string | null;
  }): Promise<ExportRequestResult>;
  /** The caller's latest job as a status view (never a secret). */
  getStatus(userId: string): Promise<ExportStatusView>;
  /** Build the zip for a job (the async worker body); idempotent on a ready job. */
  buildExport(jobId: string): Promise<void>;
  /** Resolve a download for `(user, token)`; throws 404 when it fails closed. */
  resolveDownload(input: { userId: string; token: string }): Promise<ExportDownload>;
  /** Delete every expired export's file + row; returns how many were pruned. */
  cleanupExpired(): Promise<number>;
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
    logger,
  } = deps;
  const now = deps.now ?? (() => new Date());
  const dir = config.dataExport.dir;

  const throttle = createProgressiveLimiter(
    redis,
    ACCOUNT_EXPORT_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  const filePathFor = (jobId: string) => joinPath(dir, `${jobId}.zip`);

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
      return { status: null, jobId: null, requestedAt: null, expiresAt: null, sizeBytes: null };
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
    };
  }

  return {
    async requestExport({ userId, body, ip }) {
      await verifyReauth(userId, body, ip);

      // 1/day gate: a non-failed job within the window blocks a fresh request
      // (a failed one may be retried immediately). Retry-After points at the
      // moment the window opens again.
      const latest = await exportRepo.findLatestForUser(userId);
      if (latest && latest.status !== 'failed') {
        const elapsed = now().getTime() - latest.createdAt.getTime();
        if (elapsed < EXPORT_RATE_LIMIT_MS) {
          const retryAfter = Math.ceil((EXPORT_RATE_LIMIT_MS - elapsed) / 1000);
          throw new ApiError(
            429,
            'EXPORT_RATE_LIMITED',
            'You can request a data export once per day. Please try again later.',
            { retryAfter },
          );
        }
      }

      const { token, tokenHash } = generateToken();
      const job = await exportRepo.create({ userId, downloadTokenHash: tokenHash });
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
        // failure (the user already re-authed and holds their token).
        logger?.error({ err, jobId: job.id }, 'export build enqueue failed');
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

      try {
        const collected = await collectUserExport(db, job.userId);
        const generatedAt = now();
        const zip = buildExportZip({ userId: job.userId, collected, generatedAt });
        await mkdir(dir, { recursive: true });
        const filePath = filePathFor(jobId);
        await writeFile(filePath, zip);
        await exportRepo.markReady({
          id: jobId,
          filePath,
          fileSize: zip.byteLength,
          expiresAt: new Date(generatedAt.getTime() + EXPORT_DOWNLOAD_TTL_MS),
          readyAt: generatedAt,
        });
        // Inform the owner (inbox / push): the notice deep-links to the export
        // block in Settings → Account. It carries NO token — the requester
        // already holds it from the request response, so no secret rides the
        // durable queue or lands in the inbox row.
        await notify.emit({
          type: 'account.data_export',
          userId: job.userId,
          occurredAt: generatedAt.toISOString(),
        });
      } catch (err) {
        logger?.error({ err, jobId }, 'export build failed');
        await exportRepo.markFailed(jobId, 'BUILD_FAILED');
        throw err;
      }
    },

    async resolveDownload({ userId, token }) {
      if (!token) throw badRequest('A download token is required.', 'EXPORT_TOKEN_REQUIRED');
      const row = await exportRepo.findDownloadable({
        userId,
        downloadTokenHash: hashToken(token),
        now: now(),
      });
      // Fail closed: a foreign, expired, unknown or not-yet-ready token is an
      // indistinguishable 404 — never a distinct signal to a probing caller.
      if (!row || !row.filePath) {
        throw notFound('This export is no longer available.', 'EXPORT_NOT_FOUND');
      }
      const stamp = row.readyAt ?? row.createdAt;
      const day = stamp.toISOString().slice(0, 10);
      return {
        filePath: row.filePath,
        fileName: `bettertrack-export-${day}.zip`,
        fileSize: row.fileSize ?? 0,
      };
    },

    async cleanupExpired() {
      const expired = await exportRepo.findExpired(now());
      let pruned = 0;
      for (const row of expired) {
        if (row.filePath) {
          // `force` swallows ENOENT so a missing file (already gone) still
          // prunes its row cleanly.
          await rm(row.filePath, { force: true }).catch((err) => {
            logger?.warn({ err, jobId: row.id }, 'export cleanup: file unlink failed');
          });
        }
        await exportRepo.deleteById(row.id);
        pruned += 1;
      }
      return pruned;
    },
  };
}
