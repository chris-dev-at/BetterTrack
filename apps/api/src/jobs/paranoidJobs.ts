import type { DomainEvent } from '../events';
import {
  isPortfolioContentWebhookEvent,
  paranoidJobPolicy,
  PARANOID_JOB_POLICIES,
  type ParanoidModeGuard,
} from '../services/account/paranoidEnforcement';

import type { JobDefinition, QueueName } from './types';

const PARANOID_JOB_BOUND = Symbol('paranoid-job-bound');
const PARANOID_USER_FILTER_JOB = Symbol('paranoid-user-filter-job');

export type ParanoidUserJobFilter = ((userId: string) => Promise<boolean>) & {
  readonly [PARANOID_USER_FILTER_JOB]: string;
};

export type ParanoidJobBinding =
  | {
      readonly mode: 'portfolio';
      readonly isBlockedPortfolio: (portfolioId: string) => Promise<boolean>;
    }
  | {
      readonly mode: 'event';
      readonly isParanoid: (userId: string) => Promise<boolean>;
    }
  | {
      readonly mode: 'perUser';
      readonly filter: ParanoidUserJobFilter;
    }
  | { readonly mode: 'serviceFiltered' }
  | { readonly mode: 'transitionPrecondition' };

export function createParanoidUserJobFilter(
  jobName: string,
  guard: Pick<ParanoidModeGuard, 'isParanoid'>,
): ParanoidUserJobFilter {
  const policy = paranoidJobPolicy(jobName);
  if (policy.mode !== 'perUser') {
    throw new Error(`paranoid job ${jobName} is ${policy.mode}, not perUser`);
  }
  const filter = ((userId: string) => guard.isParanoid(userId)) as ParanoidUserJobFilter;
  Object.defineProperty(filter, PARANOID_USER_FILTER_JOB, { value: jobName });
  return filter;
}

function eventUserId(event: DomainEvent): string | null {
  return 'userId' in event && typeof event.userId === 'string' ? event.userId : null;
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
  if (!policy.capability) {
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
        if (await binding.isBlockedPortfolio(portfolioId)) {
          ctx.logger.info({ portfolioId }, `${definition.name} skipped by paranoid registry`);
          return;
        }
        await handler(job, ctx);
      },
    };
  } else if (binding.mode === 'event') {
    const handler = definition.handler.bind(definition);
    bound = {
      ...definition,
      async handler(job, ctx) {
        const event = (job.data as { event?: DomainEvent }).event;
        if (event && isPortfolioContentWebhookEvent(event)) {
          const userId = eventUserId(event);
          if (userId && (await binding.isParanoid(userId))) {
            ctx.logger.info(
              { userId, type: event.type },
              `${definition.name} skipped by paranoid registry`,
            );
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
 * job has exactly one concrete definition carrying a registry binding.
 */
export function assertParanoidJobBindings(
  definitions: readonly JobDefinition[],
  allQueueNames: readonly string[],
): void {
  const classified = Object.keys(PARANOID_JOB_POLICIES).sort();
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
  for (const [name, policy] of Object.entries(PARANOID_JOB_POLICIES)) {
    const matches = byName.get(name) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `paranoid job registry expected one ${name} definition, found ${matches.length}`,
      );
    }
    const isBound = Boolean(
      (matches[0] as JobDefinition & { [PARANOID_JOB_BOUND]?: boolean })[PARANOID_JOB_BOUND],
    );
    if (policy.capability && !isBound) {
      throw new Error(`paranoid job registry has unbound killed job ${name}`);
    }
    if (!policy.capability && isBound) {
      throw new Error(`paranoid job registry bound kept job ${name}`);
    }
  }
  for (const name of byName.keys()) {
    if (!(name in PARANOID_JOB_POLICIES)) {
      throw new Error(`paranoid job registry has unclassified definition ${name}`);
    }
  }
}
