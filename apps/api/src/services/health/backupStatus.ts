import { open } from 'node:fs/promises';

import {
  BACKUP_FRESHNESS_MAX_HOURS,
  BACKUP_RESTORE_DRILL_MAX_DAYS,
  type AdminBackupStatusLevel,
  type AdminBackupStatusReason,
  type AdminBackupStatusResponse,
} from '@bettertrack/contracts';

/**
 * Read-only reader for the deploy's backup status file (#1406 W1).
 *
 * The file is written by `infra/backup/status.sh` (`schema_version=1`, plain
 * `key=value` lines, atomically renamed). This module is the API's counterpart
 * to the shell readers, and it treats the file as UNTRUSTED input even though we
 * write it: it is a mounted artifact from another container, so a corrupted or
 * tampered file must degrade the tile, never the process.
 *
 * The defences, in order:
 *  - the path comes only from configuration, never from a request, so there is
 *    no traversal surface at all;
 *  - the descriptor is opened ONCE and sized through `fstat` on that same
 *    descriptor, so the size the cap is checked against is the size of the bytes
 *    actually read — a `stat`-then-`readFile` pair could be swapped in between;
 *  - the read is line-capped and every value is pattern-checked;
 *  - only whitelisted keys are kept;
 *  - every failure (absent, unreadable, unparsable, wrong schema) resolves to a
 *    calm `configured: false` / `unknown` payload instead of throwing — but a
 *    PERMISSION failure gets its own reason, because "your backup evidence exists
 *    and this container cannot see it" must never be reported as "no backups
 *    configured here". Verify a live deployment with:
 *      docker compose exec api cat /status/backup-status.env
 */

/** A status file this size is already nonsense; refuse before reading it. */
const MAX_STATUS_FILE_BYTES = 64 * 1024;
const MAX_STATUS_FILE_LINES = 200;

const SUPPORTED_SCHEMA_VERSION = '1';

const BACKUP_MAX_AGE_SECONDS = BACKUP_FRESHNESS_MAX_HOURS * 60 * 60;
const RESTORE_MAX_AGE_SECONDS = BACKUP_RESTORE_DRILL_MAX_DAYS * 24 * 60 * 60;

/** Epoch seconds, bounded so a garbage value can never become a huge age. */
const EPOCH_PATTERN = /^\d{1,12}$/;
/** Outcome/reason tags the scripts emit: lowercase words joined by underscores. */
const TAG_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const COUNT_PATTERN = /^\d{1,15}$/;

const NUMERIC_KEYS = [
  'last_success_epoch',
  'last_artifact_bytes',
  'restore_last_success_epoch',
  'offsite_uploaded_count',
  'health_last_check_epoch',
] as const;

const TAG_KEYS = [
  'last_attempt_outcome',
  'restore_last_outcome',
  'offsite_outcome',
  'health_outcome',
  'health_reason',
] as const;

type StatusMap = Map<string, string>;

/**
 * Parse the key=value body. Unknown keys, malformed lines and oversized values
 * are dropped silently — the file is evidence, not a command channel, so partial
 * evidence beats a hard failure.
 *
 * A duplicated key resolves to the LAST occurrence, matching `bt_status_get` in
 * `infra/backup/status.sh`, whose awk assigns on every match and prints at END.
 * `bt_status_update` rewrites the file rather than appending, so duplicates
 * should never exist — but when the API and the shell disagree about a malformed
 * file, the shell is the definition, and an operator comparing the tile against
 * `bt_status_get` output must not see two different answers.
 */
function parseStatusFile(text: string): StatusMap {
  const allowed = new Set<string>([...NUMERIC_KEYS, ...TAG_KEYS, 'schema_version']);
  const parsed: StatusMap = new Map();
  const lines = text.split('\n', MAX_STATUS_FILE_LINES);

  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!allowed.has(key)) continue;
    const value = line.slice(separator + 1).trim();
    if (value.length === 0 || value.length > 64) continue;
    parsed.set(key, value);
  }
  return parsed;
}

function numeric(status: StatusMap, key: (typeof NUMERIC_KEYS)[number]): number | null {
  const raw = status.get(key);
  if (raw === undefined) return null;
  const pattern =
    key === 'last_artifact_bytes' || key.endsWith('count') ? COUNT_PATTERN : EPOCH_PATTERN;
  if (!pattern.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function tag(status: StatusMap, key: (typeof TAG_KEYS)[number]): string | null {
  const raw = status.get(key);
  return raw !== undefined && TAG_PATTERN.test(raw) ? raw : null;
}

/** Epoch seconds → ISO timestamp, or null when the value is absent/implausible. */
function isoOf(epochSeconds: number | null): string | null {
  if (epochSeconds === null) return null;
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * How far a recorded timestamp may sit in the future before it stops being clock
 * jitter and starts being unusable evidence. `healthcheck.sh` refuses ANY negative
 * age (`backup_clock_skew`); a small tolerance here keeps a second or two of drift
 * between two containers from painting the tile red, while a genuinely wrong clock
 * — or a hand-edited epoch — can no longer clamp itself to a fresh-looking zero.
 */
const CLOCK_SKEW_TOLERANCE_SECONDS = 10 * 60;

/**
 * Age in whole seconds. `null` when there is no timestamp; `'skewed'` when the
 * timestamp is implausibly far in the future, which is NOT the same as fresh.
 */
function ageOf(epochSeconds: number | null, nowMs: number): number | null | 'skewed' {
  if (epochSeconds === null) return null;
  const age = Math.floor(nowMs / 1000) - epochSeconds;
  if (age < -CLOCK_SKEW_TOLERANCE_SECONDS) return 'skewed';
  return Math.max(0, age);
}

/** A skewed age is not a number the tile may show; the reason explains it. */
function reportableAge(age: number | null | 'skewed'): number | null {
  return age === 'skewed' ? null : age;
}

/**
 * Whether a filesystem rejection was about permissions rather than absence.
 * EACCES is the direct case; EPERM covers the platform variants.
 */
function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function unconfigured(
  level: AdminBackupStatusLevel,
  reason: AdminBackupStatusReason,
  nowIso: string,
): AdminBackupStatusResponse {
  return {
    configured: false,
    level,
    reason,
    checkedAt: nowIso,
    backup: {
      lastSuccessAt: null,
      ageSeconds: null,
      lastAttemptOutcome: null,
      artifactBytes: null,
      maxAgeSeconds: BACKUP_MAX_AGE_SECONDS,
    },
    restore: {
      lastSuccessAt: null,
      ageSeconds: null,
      lastOutcome: null,
      maxAgeSeconds: RESTORE_MAX_AGE_SECONDS,
    },
    offsite: { outcome: null, uploadedCount: null },
    scheduler: { outcome: null, reason: null, checkedAt: null },
  };
}

/**
 * Scheduler `health_reason` values that mean the RECOVERY POINT itself is gone or
 * untrustworthy, not merely unproven. `healthcheck.sh` marks the container stale
 * for a missing/old dump (`backup_missing`, `backup_too_old`, `backup_clock_skew`)
 * AND for artifact loss — `artifact_missing`, `artifact_invalid`,
 * `artifact_size_missing`, `artifact_size_mismatch`, `artifact_checksum_missing`.
 * A recorded dump whose file has vanished or no longer matches its checksum is a
 * total loss of that recovery point, so it ranks critical exactly like a missing
 * dump. Everything else the scheduler can complain about (restore evidence) stays
 * a warning.
 */
const CRITICAL_SCHEDULER_REASON = /^(?:backup|artifact)/;

/**
 * Fold the evidence into one operator verdict.
 *
 * A missing or stale DUMP is critical: there is no recent recovery point. A
 * missing or stale restore DRILL is a warning: the recovery point exists but is
 * unproven. The scheduler's own `health_outcome` is AUTHORITATIVE over our
 * thresholds, because it was evaluated against that deployment's configured
 * limits rather than the documented defaults — and it sees things the status
 * fields alone do not, such as the artifact having disappeared from disk.
 */
function verdict(
  backupAge: number | null | 'skewed',
  restoreAge: number | null | 'skewed',
  offsiteOutcome: string | null,
  schedulerOutcome: string | null,
  schedulerReason: string | null,
): { level: AdminBackupStatusLevel; reason: AdminBackupStatusReason } {
  const schedulerUnhealthy = schedulerOutcome !== null && schedulerOutcome !== 'healthy';

  if (backupAge === null) return { level: 'critical', reason: 'backup_missing' };
  // A dump dated in the future is not a fresh dump: it is evidence written by a
  // machine whose clock we cannot trust, so it must not be read as green.
  if (backupAge === 'skewed' || restoreAge === 'skewed') {
    return { level: 'critical', reason: 'clock_skew' };
  }
  if (backupAge > BACKUP_MAX_AGE_SECONDS) return { level: 'critical', reason: 'backup_stale' };
  if (
    schedulerUnhealthy &&
    schedulerReason !== null &&
    CRITICAL_SCHEDULER_REASON.test(schedulerReason)
  ) {
    return { level: 'critical', reason: 'scheduler_unhealthy' };
  }
  if (restoreAge === null) return { level: 'warn', reason: 'restore_missing' };
  if (restoreAge > RESTORE_MAX_AGE_SECONDS) return { level: 'warn', reason: 'restore_stale' };
  if (schedulerUnhealthy) return { level: 'warn', reason: 'scheduler_unhealthy' };
  if (offsiteOutcome === 'failed') return { level: 'warn', reason: 'offsite_failed' };
  return { level: 'ok', reason: 'healthy' };
}

/**
 * Read and project the status file. `path` is `undefined` on a deployment that
 * wires no backup sidecar; that is the documented local-dev shape, not an error.
 */
export async function readBackupStatus(
  path: string | undefined,
  now: Date = new Date(),
): Promise<AdminBackupStatusResponse> {
  const nowIso = now.toISOString();
  if (path === undefined || path.trim() === '')
    return unconfigured('unknown', 'not_configured', nowIso);

  let text: string;
  try {
    // One descriptor for both the size check and the read, so the cap applies to
    // the bytes actually consumed rather than to whatever `stat` saw a moment
    // earlier.
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_STATUS_FILE_BYTES) {
        return unconfigured('unknown', 'unreadable', nowIso);
      }
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    // A permission failure is its own answer, and a CRITICAL one. The scheduler
    // runs as root and the api runs unprivileged, so a mode/owner mistake on the
    // shared volume is the realistic way this endpoint goes quiet. Reporting it
    // as "no backups configured" would read as benign while the operator has in
    // fact lost all visibility of whether the database is recoverable.
    if (isPermissionError(err)) {
      return unconfigured('critical', 'permission_denied', nowIso);
    }
    // Everything else (absent, unmounted, not yet written) stays a calm 200: an
    // operator page must not 500 because a sidecar has not run yet.
    return unconfigured('unknown', 'unreadable', nowIso);
  }

  const status = parseStatusFile(text);
  if (status.get('schema_version') !== SUPPORTED_SCHEMA_VERSION) {
    return unconfigured('unknown', 'unreadable', nowIso);
  }

  const nowMs = now.getTime();
  const backupSuccess = numeric(status, 'last_success_epoch');
  const restoreSuccess = numeric(status, 'restore_last_success_epoch');
  const backupAge = ageOf(backupSuccess, nowMs);
  const restoreAge = ageOf(restoreSuccess, nowMs);
  const offsiteOutcome = tag(status, 'offsite_outcome');
  const schedulerOutcome = tag(status, 'health_outcome');
  const schedulerReason = tag(status, 'health_reason');

  const { level, reason } = verdict(
    backupAge,
    restoreAge,
    offsiteOutcome,
    schedulerOutcome,
    schedulerReason,
  );

  return {
    configured: true,
    level,
    reason,
    checkedAt: nowIso,
    backup: {
      lastSuccessAt: isoOf(backupSuccess),
      // A skewed timestamp reports NO age rather than a fabricated one; the
      // `clock_skew` reason carries the explanation.
      ageSeconds: reportableAge(backupAge),
      lastAttemptOutcome: tag(status, 'last_attempt_outcome'),
      artifactBytes: numeric(status, 'last_artifact_bytes'),
      maxAgeSeconds: BACKUP_MAX_AGE_SECONDS,
    },
    restore: {
      lastSuccessAt: isoOf(restoreSuccess),
      ageSeconds: reportableAge(restoreAge),
      lastOutcome: tag(status, 'restore_last_outcome'),
      maxAgeSeconds: RESTORE_MAX_AGE_SECONDS,
    },
    offsite: {
      outcome: offsiteOutcome,
      uploadedCount: numeric(status, 'offsite_uploaded_count'),
    },
    scheduler: {
      outcome: schedulerOutcome,
      reason: schedulerReason,
      checkedAt: isoOf(numeric(status, 'health_last_check_epoch')),
    },
  };
}
