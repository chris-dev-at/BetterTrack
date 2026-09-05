import type {
  AlertFollowRecipient,
  UserFollowsRepository,
} from '../../data/repositories/userFollowsRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { ParanoidModeError, type ParanoidModeGuard } from '../account/paranoidEnforcement';

export type AlertFollowTrigger = 'create' | 'fire';

export type AlertFollowRepository = Pick<
  UserFollowsRepository,
  'listAlertFollowRecipientIds' | 'listAlertFollowRecipients'
>;

export interface AlertFollowerFanoutDeps {
  follows: AlertFollowRepository;
  /**
   * The owner's `alertsVisibleToFollowers` opt-in (#455) — read BEFORE any lock
   * so a non-publishing owner costs zero privacy-lock transactions.
   */
  users: Pick<UserRepository, 'getAlertsVisibleToFollowers'>;
  paranoid: Pick<ParanoidModeGuard, 'runAllowed' | 'runAllowedWithOptional'>;
}

/**
 * Resolve an alert follower audience without allowing either endpoint of the
 * social edge to cross a paranoid transition. The first query discovers ids
 * only under the owner's lock. The second scope holds the owner and every
 * discovered follower together, enriches only admitted followers, and keeps
 * those locks through notification enqueue.
 *
 * Both recipient queries INNER JOIN the owner's `alerts_visible_to_followers`
 * opt-in, so an owner who does not publish alert activity — the default, and
 * the overwhelming majority — can have no recipient at all. That one flag is
 * therefore read first, unlocked: no follower content is touched, and the read
 * is fail-closed in both directions. A stale `true` costs nothing (the locked
 * queries re-check the flag and are still the deciding read); a stale `false`
 * only suppresses fan-out, exactly as an owner unsharing a moment later would.
 */
export async function withAlertFollowRecipients(
  deps: AlertFollowerFanoutDeps,
  ownerId: string,
  trigger: AlertFollowTrigger,
  action: (recipients: AlertFollowRecipient[]) => Promise<void>,
): Promise<void> {
  try {
    if (!(await deps.users.getAlertsVisibleToFollowers(ownerId))) {
      await action([]);
      return;
    }
    const candidateIds = await deps.paranoid.runAllowed(ownerId, 'sharing', () =>
      deps.follows.listAlertFollowRecipientIds(ownerId, trigger),
    );
    await deps.paranoid.runAllowedWithOptional(
      [ownerId],
      candidateIds,
      'sharing',
      async (allowedFollowerIds) => {
        const recipients = await deps.follows.listAlertFollowRecipients(ownerId, trigger, [
          ...allowedFollowerIds,
        ]);
        await action(recipients);
      },
    );
  } catch (error) {
    // Follower sharing is killed, but the owner's private alert operation stays
    // available. A winning owner transition therefore suppresses only fan-out.
    if (error instanceof ParanoidModeError) return;
    throw error;
  }
}

/** A per-run memo of one trigger's follower audiences, keyed by owner. */
export interface AlertFollowRecipientCache {
  /**
   * Run `action` with `ownerId`'s audience for this cache's trigger, resolving
   * it at most once per owner for the cache's lifetime.
   */
  withRecipients(
    ownerId: string,
    action: (recipients: AlertFollowRecipient[]) => Promise<void>,
  ): Promise<void>;
}

/**
 * Resolve each owner's alert-follow audience ONCE per run and reuse it.
 *
 * The resolution depends only on `(ownerId, trigger)` yet costs two
 * `withLockedPrivacyModes` transactions on a `max: 10` pool, so paying it per
 * fired alert made a market-wide event (every `pct_day_down` alert firing at
 * once) cost 2N BEGIN/`FOR KEY SHARE`/COMMIT round-trips before any
 * notification work — enough for a run to outlast its own 60 s period and
 * overlap the next one.
 *
 * What the reuse gives up: only the FIRST fire of a run holds the owner+
 * follower locks across its enqueue; that owner's later fires in the same run
 * emit against the audience snapshot taken then. A paranoid transition or an
 * unshare landing mid-run is therefore honoured from the next run (≤ one minute
 * for the evaluator) rather than mid-loop. A suppressed owner is memoised as an
 * empty audience, so a paranoid owner costs one refusal per run, not one per
 * fire.
 */
export function createAlertFollowRecipientCache(
  deps: AlertFollowerFanoutDeps,
  trigger: AlertFollowTrigger,
): AlertFollowRecipientCache {
  const resolved = new Map<string, AlertFollowRecipient[]>();
  return {
    async withRecipients(ownerId, action) {
      const cached = resolved.get(ownerId);
      if (cached) {
        await action(cached);
        return;
      }
      let entered = false;
      await withAlertFollowRecipients(deps, ownerId, trigger, async (recipients) => {
        entered = true;
        // Memoise before the action so a failing emit still costs one
        // resolution per run, not one per fire.
        resolved.set(ownerId, recipients);
        await action(recipients);
      });
      // Returned without entering: the owner does not publish, or a winning
      // paranoid transition suppressed the fan-out. Either way they have no
      // audience for the rest of this run. A THROWN resolution is deliberately
      // not memoised, so a transient failure does not poison the run.
      if (!entered) resolved.set(ownerId, []);
    },
  };
}
