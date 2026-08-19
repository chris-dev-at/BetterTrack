import type { DomainEvent } from '../events';
import type { ParanoidVaultRepository } from '../data/repositories/paranoidVaultRepository';
import {
  isParanoidKilledWebhookEvent,
  paranoidWebhookSubjectIds,
  ParanoidModeError,
  hasParanoidJobPolicy,
  paranoidJobPolicy,
  paranoidJobPolicyNames,
  type ParanoidModeGuard,
} from '../services/account/paranoidEnforcement';

import { QUEUE_NAMES, type JobDefinition, type QueueName } from './types';

const PARANOID_JOB_BOUND = Symbol('paranoid-job-bound');
const PARANOID_USER_FILTER_JOB = Symbol('paranoid-user-filter-job');

export const PARANOID_RETIRED_PURGE_SCHEDULER_ID = 'paranoid.retiredPurge';
/** Hourly keeps the automatic deletion close to the promised `purgeAfter`. */
export const PARANOID_RETIRED_PURGE_CRON = '17 * * * *';
export const PARANOID_RETIRED_PURGE_TZ = 'UTC';
export const PARANOID_RETIRED_PURGE_BATCH_SIZE = 100;
export const PARANOID_RETIRED_PURGE_MAX_ROWS_PER_RUN = 10_000;

export interface ParanoidRetiredPurgeJobDeps {
  vaults: Pick<ParanoidVaultRepository, 'listElapsedRetirements' | 'purgeElapsedRetirement'>;
  now?: () => Date;
  batchSize?: number;
  maxRowsPerRun?: number;
}

/**
 * Delete expired Drive-only recovery copies without requiring the owner to
 * return. The retirement generation `(userId, retiredVersion)` is the natural
 * idempotency key: repeat/concurrent runs converge after deletion, and the
 * repository rechecks that exact generation under the user's row lock before
 * touching bytes. It also refuses active server media and staged candidates.
 *
 * The scan is a RESTARTED sweep, not a draining queue: every run begins at
 * `userId` order zero, and a retirement a guard permanently refuses (server
 * media re-added and left live, or the account back on `privacyMode: 'normal'`)
 * keeps its place in that order and its share of the per-run ceiling. The
 * elapsed set is bounded by the number of paranoid accounts that ever switched
 * to Drive-only, so a blocked prefix wider than `maxRowsPerRun` is not a state
 * this deployment can reach — but it is a real precondition, so the run makes
 * it observable rather than silent: `skipped` counts the refusals and the
 * ceiling warning carries the cursor it stopped at, so a prefix that never
 * advances between runs shows up as a stalled `lastUserId` with a non-zero
 * `skipped`.
 */
export function createParanoidRetiredPurgeJob(
  deps: ParanoidRetiredPurgeJobDeps,
): JobDefinition<'paranoid.retiredPurge'> {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? PARANOID_RETIRED_PURGE_BATCH_SIZE;
  const maxRowsPerRun = deps.maxRowsPerRun ?? PARANOID_RETIRED_PURGE_MAX_ROWS_PER_RUN;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('paranoid retirement purge batch size must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRowsPerRun) || maxRowsPerRun < batchSize) {
    throw new Error(
      'paranoid retirement purge per-run ceiling must be an integer at least one batch wide',
    );
  }

  return {
    name: QUEUE_NAMES.paranoidRetiredPurge,
    async handler(_job, ctx) {
      const runAt = now();
      let afterUserId: string | undefined;
      let examined = 0;
      let purged = 0;
      let converged = 0;
      let skipped = 0;
      let drained = false;

      while (examined < maxRowsPerRun) {
        const limit = Math.min(batchSize, maxRowsPerRun - examined);
        const retirements = await deps.vaults.listElapsedRetirements({
          now: runAt,
          afterUserId,
          limit,
        });
        if (retirements.length === 0) {
          drained = true;
          break;
        }

        for (const retirement of retirements) {
          const result = await deps.vaults.purgeElapsedRetirement({
            ...retirement,
            caller: 'retention-worker',
            now: runAt,
          });
          if (result.status === 'ok') purged += 1;
          else if (result.status === 'already_purged') converged += 1;
          else skipped += 1;
        }
        examined += retirements.length;
        afterUserId = retirements.at(-1)!.userId;
        if (retirements.length < limit) {
          drained = true;
          break;
        }
      }

      // Leaving the loop on a full final batch is ambiguous — the elapsed set
      // may have been exactly `maxRowsPerRun` rows and is now drained. One
      // bounded probe past the last key answers it, so the warning below only
      // fires when work was genuinely left for the next run.
      if (!drained && afterUserId !== undefined) {
        const remaining = await deps.vaults.listElapsedRetirements({
          now: runAt,
          afterUserId,
          limit: 1,
        });
        drained = remaining.length === 0;
      }

      if (purged > 0 || converged > 0) {
        ctx.logger.info(
          { purged, converged, skipped, examined },
          'elapsed paranoid server-retirement copies purged',
        );
      }
      if (skipped > 0) {
        // A retirement the job refuses to touch — server media re-added and
        // left live, a staged candidate, or the account back on `normal` — is
        // rescanned every hour and would otherwise retain ciphertext silently.
        ctx.logger.info(
          { skipped, purged, converged, examined },
          'paranoid server-retirements left in place by their guards',
        );
      }
      if (!drained) {
        // `lastUserId` is the truncation point. It advancing run over run means
        // the sweep is making progress through a backlog; standing still with a
        // non-zero `skipped` means a blocked prefix is holding the ceiling.
        ctx.logger.warn(
          { examined, purged, converged, skipped, lastUserId: afterUserId },
          'paranoid server-retirement purge reached its per-run ceiling',
        );
      }
    },
    schedule: {
      id: PARANOID_RETIRED_PURGE_SCHEDULER_ID,
      pattern: PARANOID_RETIRED_PURGE_CRON,
      tz: PARANOID_RETIRED_PURGE_TZ,
    },
  };
}

export type ParanoidUserJobFilter = ((userId: string) => Promise<boolean>) & {
  readonly [PARANOID_USER_FILTER_JOB]: string;
  runAllowed(userId: string, action: () => Promise<void>): Promise<boolean>;
};

export type ParanoidJobBinding =
  | {
      readonly mode: 'portfolio';
      readonly runIfAllowed: (portfolioId: string, action: () => Promise<void>) => Promise<boolean>;
    }
  | {
      readonly mode: 'event';
      readonly runIfAllowed: (
        userIds: readonly string[],
        action: () => Promise<void>,
      ) => Promise<boolean>;
    }
  | {
      readonly mode: 'perUser';
      readonly filter: ParanoidUserJobFilter;
    }
  | { readonly mode: 'serviceFiltered' }
  /**
   * The queue survives paranoid mode, but the handler itself splits its work
   * into an unguarded global rail and account-owned rails it runs under the
   * owning account's transition lock. Nothing is wrapped here: the binding is
   * the executable declaration that the filtering exists, and
   * {@link assertParanoidJobBindings} refuses a registry entry claiming
   * `internallyFiltered` whose definition never carries it.
   */
  | { readonly mode: 'internallyFiltered' };

export function createParanoidUserJobFilter(
  jobName: string,
  guard: Pick<ParanoidModeGuard, 'isParanoid' | 'runAllowed'>,
): ParanoidUserJobFilter {
  const policy = paranoidJobPolicy(jobName);
  if (policy.mode !== 'perUser' || !policy.capability) {
    throw new Error(`paranoid job ${jobName} is not a killed perUser job`);
  }
  const filter = ((userId: string) => guard.isParanoid(userId)) as ParanoidUserJobFilter;
  filter.runAllowed = async (userId, action) => {
    try {
      await guard.runAllowed(userId, policy.capability!, action);
      return true;
    } catch (error) {
      if (error instanceof ParanoidModeError) return false;
      throw error;
    }
  };
  Object.defineProperty(filter, PARANOID_USER_FILTER_JOB, { value: jobName });
  return filter;
}

/**
 * Bind one killed job definition to its registry policy. Portfolio/event modes
 * are wrapped here; per-user/service modes carry an executable branded binding
 * that the job's own per-row scan consumes.
 */
export function bindParanoidJob<N extends QueueName>(
  definition: JobDefinition<N>,
  binding: ParanoidJobBinding,
): JobDefinition<N> {
  const policy = paranoidJobPolicy(definition.name);
  if (!policy.capability && policy.mode !== 'internallyFiltered') {
    throw new Error(`cannot bind kept paranoid job ${definition.name}`);
  }
  if (policy.mode !== binding.mode) {
    throw new Error(
      `paranoid job ${definition.name} binding ${binding.mode} does not match ${policy.mode}`,
    );
  }
  if (binding.mode === 'perUser' && binding.filter[PARANOID_USER_FILTER_JOB] !== definition.name) {
    throw new Error(`paranoid per-user filter is not bound to ${definition.name}`);
  }

  let bound = definition;
  if (binding.mode === 'portfolio') {
    const handler = definition.handler.bind(definition);
    bound = {
      ...definition,
      async handler(job, ctx) {
        const portfolioId = (job.data as { portfolioId?: unknown }).portfolioId;
        if (typeof portfolioId !== 'string') {
          throw new Error(`${definition.name} paranoid binding requires portfolioId`);
        }
        const ran = await binding.runIfAllowed(portfolioId, () => handler(job, ctx));
        if (!ran) {
          ctx.logger.info({ portfolioId }, `${definition.name} skipped by paranoid registry`);
        }
      },
    };
  } else if (binding.mode === 'event') {
    const handler = definition.handler.bind(definition);
    bound = {
      ...definition,
      async handler(job, ctx) {
        const event = (job.data as { event?: DomainEvent }).event;
        if (event && isParanoidKilledWebhookEvent(event)) {
          const userIds = paranoidWebhookSubjectIds(event);
          if (userIds.length > 0) {
            const ran = await binding.runIfAllowed(userIds, () => handler(job, ctx));
            if (!ran) {
              ctx.logger.info(
                { userIds, type: event.type },
                `${definition.name} skipped by paranoid registry`,
              );
            }
            return;
          }
        }
        await handler(job, ctx);
      },
    };
  }

  Object.defineProperty(bound, PARANOID_JOB_BOUND, { value: true });
  return bound;
}

/**
 * Startup/test completeness gate: every queue is classified and every killed
 * OR internally filtered job has exactly one concrete definition carrying a
 * registry binding. `internallyFiltered` is deliberately not exempt: without
 * this, a capability-null `internallyFiltered` entry would be indistinguishable
 * from `kept` and could claim filtering it never performs.
 */
export function assertParanoidJobBindings(
  definitions: readonly JobDefinition[],
  allQueueNames: readonly string[],
): void {
  const classified = paranoidJobPolicyNames().sort();
  const queues = [...allQueueNames].sort();
  if (
    classified.length !== queues.length ||
    classified.some((name, index) => name !== queues[index])
  ) {
    throw new Error(
      `paranoid job registry drift: classified [${classified.join(', ')}] vs queues [${queues.join(', ')}]`,
    );
  }

  const byName = new Map<string, JobDefinition[]>();
  for (const definition of definitions) {
    const rows = byName.get(definition.name) ?? [];
    rows.push(definition);
    byName.set(definition.name, rows);
  }
  for (const name of classified) {
    const policy = paranoidJobPolicy(name);
    const matches = byName.get(name) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `paranoid job registry expected one ${name} definition, found ${matches.length}`,
      );
    }
    const isBound = Boolean(
      (matches[0] as JobDefinition & { [PARANOID_JOB_BOUND]?: boolean })[PARANOID_JOB_BOUND],
    );
    const mustBind = Boolean(policy.capability) || policy.mode === 'internallyFiltered';
    if (mustBind && !isBound) {
      throw new Error(`paranoid job registry has unbound ${policy.mode} job ${name}`);
    }
    if (!mustBind && isBound) {
      throw new Error(`paranoid job registry bound kept job ${name}`);
    }
  }
  for (const name of byName.keys()) {
    if (!hasParanoidJobPolicy(name)) {
      throw new Error(`paranoid job registry has unclassified definition ${name}`);
    }
  }
}
