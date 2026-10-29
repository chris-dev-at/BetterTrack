import type { QueueName } from './types';

/**
 * Custom BullMQ job ids (PROJECTPLAN.md §9), built in one place since #1184.
 *
 * BullMQ checks every custom `jobId` in `Job.validateOptions` before the add
 * script runs (bullmq@5.81.3 as the lockfile resolves it; apps/api declares
 * `^5.79.2`):
 *
 *  - `Custom Id cannot contain :` — any ':' throws unless the id splits into
 *    exactly three ':'-segments, the legacy `repeat:<key>:<millis>` shape kept
 *    for old repeatable jobs (a TODO there makes it a plain `includes(':')` in
 *    the next breaking release);
 *  - `Custom Id cannot be integers` — an id that `parseInt` round-trips.
 *
 * `prices.backfill:<assetId>` (two segments) and
 * `announcements.publishDue:<id>:<attempt>:<bucket>` (four) were therefore
 * refused on every production add, while the suites — which record enqueues
 * through fakes that accept any id — stayed green.
 *
 * The shape is `<queue>-<part>-<part>…`:
 *
 *  - no ':' anywhere, including the three-segment form BullMQ happens to let
 *    through: that shape is its own scheduler iterations' (`repeat:<id>:<ms>`);
 *  - the queue-name prefix (itself ':'-free — QueueBase refuses one) keeps an id
 *    from ever being an integer and tells an operator whose job it is;
 *  - every part is `encodeURIComponent`-ed, so a ':' in a caller's value can
 *    never reach BullMQ (it becomes `%3A`). That is the identity on the UUIDs and
 *    integers every caller passes today, so ids stay readable in the admin queue
 *    view.
 *
 * Uniqueness — the property every dedupe built on these ids rests on: the
 * prefix is fixed per queue and a call site always passes the same number of
 * parts, so the id is unambiguous as long as at most ONE of its parts can itself
 * contain '-' (today: one UUID plus non-negative integers). A call site with two
 * free-form parts must not rely on this joining alone.
 */
export const JOB_ID_SEPARATOR = '-';

export function customJobId(queue: QueueName, ...parts: ReadonlyArray<string | number>): string {
  return [queue, ...parts.map((part) => encodeURIComponent(String(part)))].join(JOB_ID_SEPARATOR);
}
