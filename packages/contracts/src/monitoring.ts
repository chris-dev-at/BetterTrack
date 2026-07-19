import { z } from 'zod';

/**
 * Admin monitoring / diagnostics surface (PROJECTPLAN.md §13.5 V5-P2 arc (a),
 * owner directive 2026-07-19). The observability stack (Prometheus + Grafana +
 * infra exporters) is self-provisioned in the deploy compose and never routed
 * through the public web front proxy. This contract backs the admin Diagnostics
 * panel: it reports whether monitoring is configured + reachable, and — because
 * the owner asked to reach it from OUTSIDE the LAN too — whether the
 * admin-authenticated external-access path is currently effective.
 *
 * Hard invariants encoded here (see `services/observability/monitoringService`):
 *  - Prometheus is NEVER directly exposed (no `prometheus` embed URL); Grafana
 *    is the only surface an admin can reach, and only through an authenticated
 *    path (the admin-app proxy, or an auth-gated subdomain).
 *  - External exposure is refused unless the Grafana admin password is set — the
 *    app never puts `admin/admin` on a public door.
 *  - The default is safe: absent explicit external-access config the surfaces
 *    stay localhost/LAN-only, and the panel degrades gracefully.
 */

/** Reachability of a probed dependency: server-side health check, fails soft. */
export const monitoringReachabilitySchema = z
  .object({
    /** Whether this process could reach the service just now (short-timeout probe). */
    reachable: z.boolean(),
    /** Optional short, non-sensitive detail (e.g. `timeout`, `http 502`). */
    detail: z.string().nullable(),
  })
  .strict();
export type MonitoringReachability = z.infer<typeof monitoringReachabilitySchema>;

/**
 * The external-access posture for the admin-proxied Grafana path. `effective` is
 * the single gate the proxy enforces: it is true ONLY when the deploy enabled
 * external access AND the Grafana admin password is set AND the runtime
 * kill-switch is on. Any one false ⇒ external reach is refused and the surfaces
 * stay localhost/LAN-only.
 */
export const monitoringExternalAccessSchema = z
  .object({
    /** Deploy-level toggle (`BT_OBS_EXTERNAL_ACCESS`). */
    deployEnabled: z.boolean(),
    /** Whether a non-default Grafana admin password is set (`BT_GRAFANA_ADMIN_PASSWORD`). */
    passwordSet: z.boolean(),
    /** Runtime admin kill-switch (default on); an admin can flip it off with no redeploy. */
    killSwitchOn: z.boolean(),
    /** The resolved gate: all three true. When false the proxy refuses (404). */
    effective: z.boolean(),
    /** When the runtime kill-switch was last written; null while at its default. */
    updatedAt: z.string().datetime().nullable(),
    /** The admin who last wrote the kill-switch; null if unset or gone. */
    updatedBy: z.string().uuid().nullable(),
  })
  .strict();
export type MonitoringExternalAccess = z.infer<typeof monitoringExternalAccessSchema>;

/** `GET /admin/monitoring/status` — the Diagnostics panel's whole read. */
export const monitoringStatusResponseSchema = z
  .object({
    /** Grafana configuration + reachability (the embeddable dashboard surface). */
    grafana: monitoringReachabilitySchema.extend({
      /** Whether a Grafana upstream URL is configured for this process to reach. */
      configured: z.boolean(),
    }),
    /** Prometheus reachability — server-side only; it is never exposed to a client. */
    prometheus: monitoringReachabilitySchema.extend({
      configured: z.boolean(),
    }),
    externalAccess: monitoringExternalAccessSchema,
    /**
     * Explicit public Grafana URL when the auth-gated-subdomain path is set up
     * (`BT_GRAFANA_PUBLIC_URL`), else null. When null and `externalAccess.effective`
     * is true, the client embeds the admin-proxy path under its own API origin.
     */
    externalUrl: z.string().url().nullable(),
    /** ISO timestamp the probes ran at. */
    checkedAt: z.string().datetime(),
  })
  .strict();
export type MonitoringStatusResponse = z.infer<typeof monitoringStatusResponseSchema>;

/**
 * `PATCH /admin/monitoring/external-access` — flip the runtime kill-switch that
 * gates the admin-proxied external reach. Off takes effect on the very next
 * proxy request (no redeploy); it can never widen exposure past the deploy /
 * password gates. Returns the refreshed status.
 */
export const updateMonitoringExternalAccessRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type UpdateMonitoringExternalAccessRequest = z.infer<
  typeof updateMonitoringExternalAccessRequestSchema
>;
