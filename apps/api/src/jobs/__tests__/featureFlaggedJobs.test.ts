import type { Job } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from '@bettertrack/contracts';

import type { Logger } from '../../logger';
import {
  JOB_REGISTRATION_DESCRIPTORS,
  assembleRegisteredJobDefinitions,
  type RegisteredJobDefinitions,
} from '../definitions/registration';
import {
  ALL_QUEUE_NAMES,
  QUEUE_FEATURE_FLAGS,
  featureFlagForQueue,
  flagOwningQueues,
  type JobContext,
  type JobDefinition,
  type QueueName,
} from '../types';
import { runJobDefinition } from '../worker';

/**
 * The producer half of the runtime kill switches (§6.12, §13.5 V5-P2 arc (c)).
 *
 * `requireFeature` refuses a killed feature's ROUTES per request; this suite
 * covers the seam that refuses its scheduled PRODUCERS per run, and the
 * declaration that keeps the two from drifting apart — the `alerts` switch used
 * to hide the alerts UI while `alerts.evaluate` kept firing notifications.
 */

const logger = pino({ level: 'silent' }) as unknown as Logger;

const noJob = {} as Job<Record<string, never>>;

function makeCtx(
  flags: Partial<Record<FeatureFlagKey, boolean>>,
  reads: FeatureFlagKey[] = [],
): JobContext {
  return {
    events: null as never,
    deadLetter: null as never,
    redis: null as never,
    logger,
    isFeatureEnabled: async (key) => {
      reads.push(key);
      return flags[key] ?? true;
    },
  };
}

/** The production registration set, with every queue's declared flag in place. */
function wellFormedDefinitions(): RegisteredJobDefinitions {
  const entries = JOB_REGISTRATION_DESCRIPTORS.map((registration) => {
    const flag = QUEUE_FEATURE_FLAGS[registration.name];
    const definition: JobDefinition = {
      name: registration.name,
      handler: async () => {},
      ...(flag ? { featureFlag: flag } : {}),
    };
    return [registration.key, definition];
  });
  return Object.fromEntries(entries) as RegisteredJobDefinitions;
}

describe('queue → kill-switch classification', () => {
  it('classifies every queue in the catalog — a new queue cannot ship unclassified', () => {
    expect(Object.keys(QUEUE_FEATURE_FLAGS).sort()).toEqual([...ALL_QUEUE_NAMES].sort());
  });

  it('names only flags the registry actually knows', () => {
    for (const flag of Object.values(QUEUE_FEATURE_FLAGS)) {
      if (flag !== null) expect(FEATURE_FLAG_KEYS).toContain(flag);
    }
  });

  it('enumerates the flag-owning producers: `alerts` owns alerts.evaluate, the other five own none', () => {
    const owned = Object.fromEntries(
      FEATURE_FLAG_KEYS.map((flag) => [flag, [...flagOwningQueues(flag)]]),
    );
    // The full expectation, not just the alerts row: adding a background
    // producer under an existing switch has to land here, which is the review
    // moment where its shed gets wired.
    expect(owned).toEqual({
      realtime: [],
      liveMode: [],
      chat: [],
      alerts: ['alerts.evaluate'],
      imports: [],
      ai: [],
    });
    expect(featureFlagForQueue('alerts.evaluate')).toBe('alerts');
    // The shared delivery lane stays ungated: it carries every event type, so
    // gating it on `alerts` would kill unrelated notifications. Shedding
    // happens where the fire is produced.
    expect(featureFlagForQueue('notifications.dispatch')).toBeNull();
  });
});

describe('the worker refuses to assemble a producer that escapes its switch', () => {
  it('accepts the production set as declared', () => {
    expect(() => assembleRegisteredJobDefinitions(wellFormedDefinitions())).not.toThrow();
  });

  it('rejects a flag-owning queue whose definition forgot to declare the flag', () => {
    const definitions = wellFormedDefinitions();
    const forgetful = { ...definitions.createAlertsEvaluateJob };
    delete (forgetful as { featureFlag?: FeatureFlagKey }).featureFlag;
    expect(() =>
      assembleRegisteredJobDefinitions({ ...definitions, createAlertsEvaluateJob: forgetful }),
    ).toThrow(/does not declare featureFlag 'alerts'/);
  });

  it('rejects a definition claiming a flag its queue does not own', () => {
    const definitions = wellFormedDefinitions();
    const overreaching = {
      ...definitions.createNotificationsDispatchJob,
      featureFlag: 'alerts' as const,
    };
    expect(() =>
      assembleRegisteredJobDefinitions({
        ...definitions,
        createNotificationsDispatchJob: overreaching,
      }),
    ).toThrow(/does not own notifications.dispatch/);
  });
});

describe('runJobDefinition — the one execution seam', () => {
  const gated = (onRun: () => void): JobDefinition<'alerts.evaluate'> => ({
    name: 'alerts.evaluate' as QueueName as 'alerts.evaluate',
    featureFlag: 'alerts',
    handler: async () => {
      onRun();
    },
  });

  it('runs a gated job while its switch is ON', async () => {
    let runs = 0;
    await runJobDefinition(
      gated(() => (runs += 1)),
      noJob,
      makeCtx({ alerts: true }),
    );
    expect(runs).toBe(1);
  });

  it('sheds a gated job while its switch is OFF — the handler is never entered', async () => {
    let runs = 0;
    const result = await runJobDefinition(
      gated(() => (runs += 1)),
      noJob,
      makeCtx({ alerts: false }),
    );
    expect(runs).toBe(0);
    expect(result).toBeUndefined();
  });

  it('reads the flag per run, never once at startup', async () => {
    let runs = 0;
    const definition = gated(() => (runs += 1));
    const flags: Partial<Record<FeatureFlagKey, boolean>> = { alerts: true };
    const reads: FeatureFlagKey[] = [];
    const ctx = makeCtx(flags, reads);

    await runJobDefinition(definition, noJob, ctx);
    flags.alerts = false;
    await runJobDefinition(definition, noJob, ctx);
    flags.alerts = true;
    await runJobDefinition(definition, noJob, ctx);

    expect(runs).toBe(2);
    expect(reads).toEqual(['alerts', 'alerts', 'alerts']);
  });

  it('fails the run rather than firing when the flag read itself throws', async () => {
    let runs = 0;
    const ctx: JobContext = {
      ...makeCtx({}),
      isFeatureEnabled: async () => {
        throw new Error('flag store unreachable');
      },
    };
    await expect(
      runJobDefinition(
        gated(() => (runs += 1)),
        noJob,
        ctx,
      ),
    ).rejects.toThrow('flag store unreachable');
    // BullMQ retries a failed job; what must never happen is a fire on an
    // unreadable switch.
    expect(runs).toBe(0);
  });

  it('never consults the switch for an ungated job, and passes its summary through', async () => {
    const reads: FeatureFlagKey[] = [];
    const definition: JobDefinition<'data.retentionCleanup'> = {
      name: 'data.retentionCleanup',
      handler: async () => ({ deleted: 3 }),
    };
    const summary = await runJobDefinition(definition, noJob, makeCtx({}, reads));
    expect(summary).toEqual({ deleted: 3 });
    expect(reads).toEqual([]);
  });
});
