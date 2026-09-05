import type { Redis } from 'ioredis';

/**
 * The durable "notify once" marker shared by the two market-intel scans
 * (§13.5 V5-P5): the earnings reminder and the dividend-event scan.
 *
 * Both scans re-see the same upcoming report / payout on every daily run for as
 * long as it sits inside their window, and both must notify exactly once per
 * `(recipient, asset, date)`. The dispatcher's own `(user, eventKey)` dedupe
 * cannot carry that guarantee alone: its marker **is** the inbox row, and a
 * visible inbox row is hard-deletable by its owner
 * (`notificationRepository.deleteOne` / `deleteBulk`). A recipient who reads and
 * clears the notification would otherwise be re-notified on every remaining day
 * of the window — on every channel, not just in-app. This marker is the scan's
 * OWN server-side guard, invisible to and untouchable by the recipient.
 *
 * Two keys per `(recipient, asset)`:
 *
 *  - the **anchor** holds the date already notified about, so a provider that
 *    merely moves an estimated date inside the window (Yahoo publishes an
 *    estimate until the company confirms) is recognised as the SAME event and
 *    stays silent — the #1758 ruling: exactly one notification per event, with
 *    no "date changed" follow-up. A genuinely later event (a quarter for
 *    earnings, a month or a quarter for a payout) is far outside `matchDays` and
 *    claims freshly.
 *  - the per-date **lock**, taken with `SET NX`, which is what makes the claim
 *    atomic between two concurrent scans — the anchor's read-then-write pair is
 *    not.
 *
 * ORDERING — the crash window. Both keys are written BEFORE the notification is
 * handed to the durable transport, and are rolled back only when the transport
 * reports a failure. Writing the anchor *after* the emit (as the earnings scan
 * did) left a window in which a SIGKILL between the enqueue ack and the anchor
 * write kept the per-date lock but no anchor: the provider then firming the date
 * to `D+1` produced a fresh lock key AND a fresh dispatcher event key, i.e. a
 * SECOND reminder for one report — the exact defect #1758 closed. Claiming first
 * turns the residue of a crash from "duplicate notification" into "one
 * notification skipped"; that second shape already existed for the same-date
 * path (the `SET NX` lock has always preceded the emit), so this ordering
 * removes a failure class rather than trading one for another.
 */

/** Whole days between two `YYYY-MM-DD` day strings, sign-independent. */
export function dayDistance(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00.000Z`);
  const right = Date.parse(`${b}T00:00:00.000Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86_400_000;
}

export interface ReminderMarkerSpec {
  redis: Redis;
  /** Per-`(recipient, asset, date)` key; `SET NX` on it makes the claim atomic. */
  lockKey: string;
  /** Per-`(recipient, asset)` key holding the date already notified about. */
  anchorKey: string;
  /** The candidate date, `YYYY-MM-DD`. */
  dateKey: string;
  /** How far a date may move and still be the same event. */
  matchDays: number;
  /** TTL of both keys; far longer than the scan's window. */
  ttlSeconds: number;
}

export type ReminderClaim =
  /** A marker already covers this event — stay silent. */
  | { status: 'duplicate' }
  /** The marker store failed; nothing was written, nothing may be emitted. */
  | { status: 'unavailable'; err: unknown }
  /**
   * The event is claimed and may be emitted. Call {@link release} — and only
   * then — when the transport REFUSED the event, so the next scan retries.
   */
  | { status: 'claimed'; release: () => Promise<void> };

/**
 * Claim the right to notify exactly once about one `(recipient, asset, date)`.
 *
 * Never throws: with the marker store unreachable there is no safe way to
 * notify, so the caller records the skip and the next scan retries inside the
 * same window.
 */
export async function claimReminderMarker(spec: ReminderMarkerSpec): Promise<ReminderClaim> {
  const { redis, lockKey, anchorKey, dateKey, matchDays, ttlSeconds } = spec;
  let locked = false;
  try {
    const anchor = await redis.get(anchorKey);
    if (anchor !== null && dayDistance(anchor, dateKey) <= matchDays)
      return { status: 'duplicate' };

    const acquired = await redis.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
    if (acquired !== 'OK') return { status: 'duplicate' };
    locked = true;

    // Anchored BEFORE the emit — see the ordering note above.
    await redis.set(anchorKey, dateKey, 'EX', ttlSeconds);

    return {
      status: 'claimed',
      // Best effort: a rollback that itself fails strands this event's marker
      // and the next scan stays silent about it — the same residue a crash
      // leaves, and the same trade the ordering above already makes. It must
      // never turn a refused enqueue into a thrown scan.
      release: async () => {
        try {
          await redis.del(lockKey);
          if (anchor === null) await redis.del(anchorKey);
          else await redis.set(anchorKey, anchor, 'EX', ttlSeconds);
        } catch {
          /* stranded, not duplicated */
        }
      },
    };
  } catch (err) {
    if (locked) await redis.del(lockKey).catch(() => undefined);
    return { status: 'unavailable', err };
  }
}
