/**
 * Hard ceilings on one account export (#1714).
 *
 * A build is fully buffered four times over — every selected row lives in
 * memory, `JSON.stringify` makes a pretty-printed copy per entity, `strToU8`
 * makes a UTF-8 copy of that, and `zipSync` compresses synchronously into yet
 * another buffer. In production the build runs inside the worker, so an
 * unbounded account does not merely fail its own export: it OOM-kills every
 * background job in the process, and each attempt leaves a partial cleartext
 * artifact behind. Two ceilings make that failure a clean, typed one instead:
 *
 *  - {@link EXPORT_MAX_ROWS} caps the append-only tables — and the
 *    machine-generated link rows that grow at a multiple of them, such as the
 *    auto-stamped `cash_movement_tags` — BEFORE any row is materialized (a
 *    counting pre-flight in the collector), so the runaway case never
 *    allocates.
 *  - {@link EXPORT_MAX_CONTENT_BYTES} caps the packaged bytes as the archive is
 *    assembled, which is the dimension a few very large rows blow through
 *    without tripping the row count. The server-resident vault ciphertext is
 *    additionally summed from its declared sizes before any blob is read, so
 *    that dimension is refused pre-flight too (#1812), and the ceiling is
 *    deployment-configurable (`BT_EXPORT_MAX_CONTENT_BYTES`) because a
 *    legitimately larger account must still be able to obtain its archive.
 *
 * Both are deliberately far above any real single-owner account: 1,000,000
 * ledger/notification rows and 128 MiB of packaged content are several orders of
 * magnitude past a decade of daily use.
 *
 * `export_jobs.file_size` is an `integer` column (max 2,147,483,647). The
 * content ceiling bounds the archive well under that — a zip is at most its
 * content plus per-entry headers — so {@link EXPORT_MAX_ARCHIVE_BYTES} sits an
 * order of magnitude below the column's limit and the numeric-overflow path on
 * `markReady` is unreachable by construction.
 */

/** Rows across the append-only tables an export copies; counted pre-flight. */
export const EXPORT_MAX_ROWS = 1_000_000;

/** Sum of every packaged file's uncompressed bytes (JSON + CSV + vault blobs). */
export const EXPORT_MAX_CONTENT_BYTES = 128 * 1024 * 1024;

/**
 * Belt-and-braces bound on the finished archive. Unreachable given the content
 * ceiling; it exists so `export_jobs.file_size` provably never overflows even if
 * the packaging gains a file the content accounting misses.
 */
export const EXPORT_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/** The coarse reason persisted on `export_jobs.error` for an over-ceiling build. */
export const EXPORT_TOO_LARGE = 'EXPORT_TOO_LARGE';

export type ExportLimitDimension = 'rows' | 'content_bytes' | 'archive_bytes';

/**
 * A build refused for exceeding a ceiling. Deterministic: the same account
 * exceeds it on every retry, so the service records it as a typed terminal
 * failure rather than re-queueing the work.
 */
export class ExportTooLargeError extends Error {
  readonly code = EXPORT_TOO_LARGE;
  readonly dimension: ExportLimitDimension;
  readonly measured: number;
  readonly limit: number;

  constructor(dimension: ExportLimitDimension, measured: number, limit: number) {
    super(`account export exceeds the ${dimension} ceiling (${measured} > ${limit})`);
    this.name = 'ExportTooLargeError';
    this.dimension = dimension;
    this.measured = measured;
    this.limit = limit;
  }
}

/**
 * `JSON.stringify` on one very large entity throws `RangeError: Invalid string
 * length` before any ceiling of ours is consulted. That is the same condition —
 * an account too big to package — so it is normalized into the same typed
 * failure instead of surfacing as an opaque build error.
 */
export function stringifyBounded(value: unknown, dimension: ExportLimitDimension): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new ExportTooLargeError(dimension, Number.POSITIVE_INFINITY, EXPORT_MAX_CONTENT_BYTES);
    }
    throw err;
  }
}
