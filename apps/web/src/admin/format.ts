/**
 * Admin date formatting (de-AT locale, PROJECTPLAN.md §7.1).
 *
 * The shared implementation now lives in the app-wide `lib/format` kit; this
 * module is kept as a stable re-export so existing admin imports
 * (`AuditPage`, `InvitesPage`, `UsersPage`) keep working unchanged.
 */
export { formatDate, formatDateTime } from '../lib/format';
