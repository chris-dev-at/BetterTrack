import { Router } from 'express';

import { adminBackupStatusResponseSchema } from '@bettertrack/contracts';

import { readBackupStatus } from '../../services/health/backupStatus';
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
}
