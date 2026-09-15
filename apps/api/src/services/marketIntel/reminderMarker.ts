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
 *    claims freshly. A caller that can IDENTIFY its event independently of the
 *    date (see {@link ReminderMarkerSpec.identity}) also stores that identity
 *    beside the date, so proximity alone can no longer merge two events the
 *    payload itself says are different — and, beyond the proximity window, can
 *    still recognise an event that MOVED, on the payload's own evidence rather
 *    than on distance (see {@link ReminderMarkerSpec.amendmentDays}).
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
  /** How far a date may move and still be the same event, on DISTANCE alone. */
  matchDays: number;
  /** TTL of both keys; far longer than the scan's window. */
  ttlSeconds: number;
  /**
   * The outer band — beyond `matchDays` — in which a moved date may still be the
   * same event, but only on EVIDENCE rather than on proximity: `anchorVacated`
   * must say the anchored event is gone from the caller's current payload, and
   * {@link identity} then confirms or refuses. Defaults to `matchDays` (no outer
   * band), which is what the earnings scan uses.
   *
   * Widening `matchDays` instead would be the #1894 defect again: distance alone
   * merges two dates, and two real events (a weekly distributor's payouts) sit
   * that far apart. The band is inert without both an `identity` concept and an
   * `anchorVacated` answer.
   */
  amendmentDays?: number;
  /**
   * Whether the date the anchor names is NO LONGER accounted for by the caller's
   * current payload — i.e. it is still in the future, and the provider no longer
   * lists an event on it. That is the positive evidence of a MOVE: the event
   * did not happen beside the candidate, it became the candidate.
   *
   * False whenever the anchored date is still listed (the two events coexist:
   * the provider itself says they are two) or has already arrived (it happened;
   * a later nearby date is the next one). Never called outside the band above,
   * and never for the anchor's own date.
   */
  anchorVacated?: (anchorDateKey: string) => boolean;
  /**
   * What identifies this event APART from its date — for a payout, the money it
   * pays (see `dividendEventsJob.payoutIdentity`). Supplied, it decides a
   * within-`matchDays` collision on a DIFFERENT date instead of the distance
   * alone — and, inside {@link amendmentDays}, confirms or refuses a move the
   * payload has evidenced (the anchor's own date is decided as `same-date`
   * first, and a date outside both windows is simply a new event): an equal
   * identity is the same event (an amended date), a different one is a second
   * event and claims freshly, and an identity the payload does not carry — or
   * an anchor written before identities existed — is `ambiguous`: the claim
   * still refuses (a duplicate notification is the worse failure) but says so,
   * so the caller can count the drop as something other than a clean no-op.
   *
   * Omitted entirely (the earnings scan, whose reports carry nothing stable
   * besides the date), the marker behaves exactly as it always has.
   */
  identity?: string | null;
}

/** Why a claim refused. */
export type ReminderDuplicateReason =
  /** This exact date is already claimed — the daily re-scan's normal outcome. */
  | 'same-date'
  /** The anchor names the same event on a nearby date — an amended date. */
  | 'same-event'
  /**
   * A DIFFERENT nearby date, and nothing says whether it is the same event.
   * Silent to avoid a double notification, and NOT a clean no-op: the caller
   * counts it apart.
   */
  | 'ambiguous';

export type ReminderClaim =
  /** A marker already covers this event — stay silent. */
  | { status: 'duplicate'; reason: ReminderDuplicateReason }
  /** The marker store failed; nothing was written, nothing may be emitted. */
  | { status: 'unavailable'; err: unknown }
  /**
   * The event is claimed and may be emitted. Call {@link release} — and only
   * then — when the transport REFUSED the event, so the next scan retries.
   */
  | { status: 'claimed'; release: () => Promise<void> };

/** The anchor's stored form: the date, plus the identity when one was supplied. */
function encodeAnchor(dateKey: string, identity: string | null | undefined): string {
  return identity === undefined || identity === null ? dateKey : `${dateKey}|${identity}`;
}

/**
 * Split a stored anchor back into its date and identity. An anchor written
 * before identities existed (a bare `YYYY-MM-DD`) parses to a null identity,
 * which is what makes it ambiguous rather than silently matching.
 */
function decodeAnchor(raw: string): { dateKey: string; identity: string | null } {
  const sep = raw.indexOf('|');
  if (sep === -1) return { dateKey: raw, identity: null };
  return { dateKey: raw.slice(0, sep), identity: raw.slice(sep + 1) };
}

/**
 * Claim the right to notify exactly once about one `(recipient, asset, date)`.
 *
 * Never throws: with the marker store unreachable there is no safe way to
 * notify, so the caller records the skip and the next scan retries inside the
 * same window.
 */
export async function claimReminderMarker(spec: ReminderMarkerSpec): Promise<ReminderClaim> {
  const { redis, lockKey, anchorKey, dateKey, matchDays, ttlSeconds, identity } = spec;
  const amendmentDays = Math.max(spec.amendmentDays ?? matchDays, matchDays);
  let locked = false;
  try {
    const anchor = await redis.get(anchorKey);
    if (anchor !== null) {
      const previous = decodeAnchor(anchor);
      const distance = dayDistance(previous.dateKey, dateKey);
      const withinMatch = distance <= matchDays;
      // The outer band: too far for proximity to mean anything, close enough
      // that one event could have MOVED here. Nothing is merged on distance —
      // the caller has to say the anchored event vacated its date, and the
      // identity has to agree.
      const movedInBand =
        !withinMatch &&
        distance <= amendmentDays &&
        identity !== undefined &&
        spec.anchorVacated?.(previous.dateKey) === true;
      if (withinMatch || movedInBand) {
        // Distance ZERO is not a proximity question at all: it is the same date,
        // which the per-date `SET NX` lock below would classify `same-date` on
        // its own. Deciding it HERE, before the identity branches, is what keeps
        // the ordinary daily re-scan a clean suppression — an event whose
        // payload carries no identity (a payout Yahoo dates no amount to, see
        // `yahooMapping.declaredAmountOn`), or an anchor written before
        // identities existed, would otherwise be `ambiguous` on every day of the
        // window and turn every run after the first notification into a degraded
        // one. Only a DIFFERENT nearby date is genuinely undecidable.
        if (withinMatch && previous.dateKey === dateKey)
          return { status: 'duplicate', reason: 'same-date' };
        // Without an identity concept the distance IS the rule, exactly as
        // before — and so is the marker it leaves behind (the band above is
        // unreachable without an identity, so this is the earnings scan, whose
        // 21-day window no drift can walk out of inside one report cycle).
        if (identity === undefined) return { status: 'duplicate', reason: 'same-event' };
        // With one, only an equal identity keeps the marker silent for a date
        // this far away; a different identity falls through and claims, because
        // a payout that was cancelled and replaced by a different one is a
        // second notification, not a silent amendment.
        const reason: ReminderDuplicateReason | null =
          identity !== null && previous.identity === identity
            ? 'same-event'
            : identity === null || previous.identity === null
              ? 'ambiguous'
              : null;
        if (reason !== null) {
          // TRANSFER the claim to the date the event moved to, and only then
          // refuse. Refusing WITHOUT moving the marker leaves the decision to be
          // re-taken on every later scan against evidence that decays: the
          // anchored date eventually ARRIVES, `anchorVacated` goes false (an
          // arrived date is not a vanished one), the distance falls through to a
          // per-date lock that was never taken, and a second notification goes
          // out for one event — on the day the date it names never happened.
          // After the transfer the distance is ZERO forever after, so the answer
          // is `same-date` no matter what the payload does next.
          //
          // The key shapes are unchanged: the per-date `SET NX` is taken for the
          // date being refused (its result is deliberately ignored — either this
          // scan takes it or a concurrent one already holds it, and both mean
          // the same thing: this date must never be emitted), and the anchor
          // still holds exactly one date per (recipient, asset). An identity the
          // candidate does not carry is never allowed to erase one the anchor
          // already knows.
          await redis.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
          await redis.set(
            anchorKey,
            encodeAnchor(dateKey, identity ?? previous.identity),
            'EX',
            ttlSeconds,
          );
          return { status: 'duplicate', reason };
        }
      }
    }
    const acquired = await redis.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
    if (acquired !== 'OK') return { status: 'duplicate', reason: 'same-date' };
    locked = true;

    // Anchored BEFORE the emit — see the ordering note above.
    await redis.set(anchorKey, encodeAnchor(dateKey, identity), 'EX', ttlSeconds);

    return {
      status: 'claimed',
      // Best effort: a rollback that itself fails strands this event's marker
      // and the next scan stays silent about it — the same residue a crash
      // leaves, and the same trade the ordering above already makes. It must
      // never turn a refused enqueue into a thrown scan.
      release: async () => {
        try {
          await redis.del(lockKey);
          // Restored VERBATIM, identity and all — the anchor's stored form is
          // opaque to the rollback.
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
