import { readFile, stat } from 'node:fs/promises';

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
 *  - the file is size-capped before it is read, and the read is line-capped;
 *  - only whitelisted keys are kept, each validated against a strict pattern;
 *  - every failure (absent, unreadable, unparsable, wrong schema) resolves to a
 *    calm `configured: false` / `unknown` payload instead of throwing.
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
 * Parse the key=value body. Unknown keys, malformed lines, oversized values and
 * duplicate keys past the first are dropped silently — the file is evidence, not
 * a command channel, so partial evidence is better than a hard failure.
 */
function parseStatusFile(text: string): StatusMap {
  const allowed = new Set<string>([...NUMERIC_KEYS, ...TAG_KEYS, 'schema_version']);
  const parsed: StatusMap = new Map();
  const lines = text.split('\n', MAX_STATUS_FILE_LINES);

  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!allowed.has(key) || parsed.has(key)) continue;
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

/** Age in whole seconds, clamped at 0 so clock skew never reports a negative. */
function ageOf(epochSeconds: number | null, nowMs: number): number | null {
  if (epochSeconds === null) return null;
  return Math.max(0, Math.floor(nowMs / 1000) - epochSeconds);
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
 * Fold the evidence into one operator verdict.
 *
 * A missing or stale DUMP is critical: there is no recent recovery point. A
 * missing or stale restore DRILL is a warning: the recovery point exists but is
 * unproven. The scheduler's own `health_outcome` wins over our thresholds when
 * it disagrees, because it was evaluated against that deployment's configured
 * limits rather than the documented defaults.
 */
function verdict(
  backupAge: number | null,
  restoreAge: number | null,
  offsiteOutcome: string | null,
  schedulerOutcome: string | null,
  schedulerReason: string | null,
): { level: AdminBackupStatusLevel; reason: AdminBackupStatusReason } {
  if (backupAge === null) return { level: 'critical', reason: 'backup_missing' };
  if (backupAge > BACKUP_MAX_AGE_SECONDS) return { level: 'critical', reason: 'backup_stale' };
  if (
    schedulerOutcome === 'stale' &&
    schedulerReason !== null &&
    schedulerReason.startsWith('backup')
  ) {
    return { level: 'critical', reason: 'scheduler_unhealthy' };
  }
  if (restoreAge === null) return { level: 'warn', reason: 'restore_missing' };
  if (restoreAge > RESTORE_MAX_AGE_SECONDS) return { level: 'warn', reason: 'restore_stale' };
  if (schedulerOutcome === 'stale') return { level: 'warn', reason: 'scheduler_unhealthy' };
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
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_STATUS_FILE_BYTES) {
      return unconfigured('unknown', 'unreadable', nowIso);
    }
    text = await readFile(path, 'utf8');
  } catch {
    // Absent, unmounted, or unreadable: the tile says so and the request stays a
    // 200. An operator page must not 500 because a sidecar has not run yet.
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
      ageSeconds: backupAge,
      lastAttemptOutcome: tag(status, 'last_attempt_outcome'),
      artifactBytes: numeric(status, 'last_artifact_bytes'),
      maxAgeSeconds: BACKUP_MAX_AGE_SECONDS,
    },
    restore: {
      lastSuccessAt: isoOf(restoreSuccess),
      ageSeconds: restoreAge,
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
