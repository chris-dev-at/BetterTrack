import { Router } from 'express';

import {
  monitoringStatusResponseSchema,
  updateMonitoringExternalAccessRequestSchema,
  type UpdateMonitoringExternalAccessRequest,
} from '@bettertrack/contracts';

import type { AppContext } from '../context';
import { validateBody } from '../middleware/validate';

/**
 * Admin monitoring / Diagnostics endpoints (PROJECTPLAN.md §13.5 V5-P2 arc (a),
 * owner directive 2026-07-19). Registered FLAT onto the admin router (the
 * OpenAPI coverage checker only reconstructs top-level mounts), behind
 * `requireAdmin` + the mandatory-2FA gate the parent applies.
 *
 * These are the small JSON reads/writes that back the admin Diagnostics panel —
 * distinct from the heavier Grafana reverse proxy (mounted at the app root so it
 * bypasses CSRF + the general limiter, see {@link createGrafanaProxyMiddleware}).
 *
 * `ctx.monitoring` is read PER-REQUEST, never at mount — route factories stay
 * side-effect free at mount time (checkOpenapiCoverage relies on it).
 */
export function registerAdminMonitoringRoutes(router: Router, ctx: AppContext): void {
  // Reachable/not-reachable status + external-access posture. The probe fails
  // soft, so this always answers — the panel degrades gracefully when the stack
  // is down or unconfigured.
  router.get('/monitoring/status', async (_req, res) => {
    res.json(monitoringStatusResponseSchema.parse(await ctx.monitoring.status()));
  });

  // Runtime kill-switch for the admin-proxied external reach. Off takes effect on
  // the next proxy request (no redeploy) and can never widen exposure past the
  // deploy + password gates. Audit-logged in the service.
  router.patch(
    '/monitoring/external-access',
    validateBody(updateMonitoringExternalAccessRequestSchema),
    async (req, res) => {
      const { enabled } = req.valid?.body as UpdateMonitoringExternalAccessRequest;
      const status = await ctx.monitoring.setExternalAccessRuntime(enabled, {
        id: req.authUser!.id,
        ip: req.ip,
      });
      res.json(monitoringStatusResponseSchema.parse(status));
    },
  );
}
