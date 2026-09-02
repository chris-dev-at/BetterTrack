import { Router } from 'express';

import {
  adminBackupStatusResponseSchema,
  adminOpsJobsResponseSchema,
  adminOpsProvidersResponseSchema,
} from '@bettertrack/contracts';

import { readBackupStatus } from '../../services/health/backupStatus';
import { readJobOps } from '../../services/ops/jobOpsService';
import { readProviderOps } from '../../services/ops/providerOpsService';
import type { AppContext } from '../context';

/**
 * Admin operations reads (#1406 W1). Registered FLAT onto the admin router (the
 * OpenAPI coverage checker only reconstructs top-level mounts), behind
 * `requireAdmin` + the mandatory-2FA gate the parent applies — the same policy
 * every sibling admin surface carries.
 *
 * Strictly READ-ONLY. Nothing here starts a dump, a drill, or an upload: the
 * backup lifecycle belongs to the scheduler sidecar, and an admin panel that
 * could trigger it would put a destructive-adjacent control behind a browser
 * session. `ctx` is read PER-REQUEST, never at mount — route factories stay
 * side-effect free at mount time (checkOpenapiCoverage relies on it).
 */
export function registerAdminOpsRoutes(router: Router, ctx: AppContext): void {
  // Backup / restore-drill readiness for the Overview tile. Fails soft: an
  // unconfigured or unreadable status file answers 200 with `configured: false`
  // rather than turning the operator's landing page into an error.
  router.get('/ops/backup-status', async (_req, res) => {
    const status = await readBackupStatus(ctx.config.backup.statusFile);
    res.json(adminBackupStatusResponseSchema.parse(status));
  });

  // Queue depths, repeatable schedules with their next/last run, and the §9
  // dead-letter list — the "Health & queues" tab of the W4 cockpit (#1406).
  //
  // READ-ONLY, and structurally so: the DECISION killed generic queue
  // retry/discard/mass-retry, so there is no companion POST here to guard. Job
  // payloads never leave the process (see `jobOpsService`), which is the same
  // boundary Bull Board's `[redacted]` formatters hold.
  router.get('/ops/jobs', async (_req, res) => {
    const body = await readJobOps({ queues: ctx.queues, redis: ctx.redis });
    res.json(adminOpsJobsResponseSchema.parse(body));
  });

  // Per-capability breaker state, cache hit/stale rates and provider call
  // outcomes — the "Providers" tab (#1406 W4). No quota gauge: Yahoo is keyless
  // and the DECISION rejected inventing one.
  router.get('/ops/providers', async (_req, res) => {
    const body = await readProviderOps({ marketData: ctx.marketData });
    res.json(adminOpsProvidersResponseSchema.parse(body));
  });
}
