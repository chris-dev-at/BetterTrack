import type {
  AlertFollowRecipient,
  UserFollowsRepository,
} from '../../data/repositories/userFollowsRepository';
import { ParanoidModeError, type ParanoidModeGuard } from '../account/paranoidEnforcement';

export type AlertFollowTrigger = 'create' | 'fire';

export type AlertFollowRepository = Pick<
  UserFollowsRepository,
  'listAlertFollowRecipientIds' | 'listAlertFollowRecipients'
>;

export interface AlertFollowerFanoutDeps {
  follows: AlertFollowRepository;
  paranoid: Pick<ParanoidModeGuard, 'runAllowed' | 'runAllowedWithOptional'>;
}

/**
 * Resolve an alert follower audience without allowing either endpoint of the
 * social edge to cross a paranoid transition. The first query discovers ids
 * only under the owner's lock. The second scope holds the owner and every
 * discovered follower together, enriches only admitted followers, and keeps
 * those locks through notification enqueue.
 */
export async function withAlertFollowRecipients(
  deps: AlertFollowerFanoutDeps,
  ownerId: string,
  trigger: AlertFollowTrigger,
  action: (recipients: AlertFollowRecipient[]) => Promise<void>,
): Promise<void> {
  try {
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
