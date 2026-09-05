/**
 * Per-type e-mail rules (§6.10), shared by the three places that must agree on
 * them (#1816).
 *
 * The dispatcher's instant path decides per type whether an e-mail ships at all
 * — a handful of types deliberately ship none. That decision used to live only
 * inside its `sendEmail` switch, so the deferred paths (a digest row, a
 * quiet-hours deferral) enqueued an e-mail for a type that never sends one
 * instantly, and the settings write path persisted an e-mail cell the SPA merely
 * *renders* as locked. Both now consult this module instead.
 */

/**
 * Types with NO e-mail template, i.e. the cells the settings grid locks:
 *  - `account.temp_password` — its e-mail is transactional (it carries the
 *    credential) and is sent directly at the source, never by the dispatcher;
 *  - `account.data_export` — in-app / push only: the download is gated by a
 *    token the requester already holds, so an e-mail would carry no actionable
 *    link;
 *  - `budget.exceeded` — a lightweight nudge; the dashboards are the system of
 *    record (V5-P9).
 *
 * `account.invite` is locked in the grid too but is not a dispatchable type
 * (it routes to people who have no account yet), so it has nothing to gate here.
 */
export const NOTIFICATION_TYPES_WITHOUT_EMAIL = [
  'account.temp_password',
  'account.data_export',
  'budget.exceeded',
] as const;

/**
 * Whether this notification type ships an e-mail at all. Unknown types answer
 * yes: only the explicit list above is locked, so a synthetic type (the digest
 * summary) and every future type keep the default behaviour.
 */
export function notificationTypeShipsEmail(type: string): boolean {
  return !(NOTIFICATION_TYPES_WITHOUT_EMAIL as readonly string[]).includes(type);
}
