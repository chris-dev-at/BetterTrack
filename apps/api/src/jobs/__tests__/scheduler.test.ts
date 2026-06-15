import { describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_SCHEDULER_ID } from '../definitions';
import type { QueueRegistry } from '../queues';
import {
  registerSchedule,
  registerSchedules,
  toRepeatOptions,
  type SchedulableQueue,
} from '../scheduler';
import type { JobDefinition, RepeatSpec } from '../types';

describe('toRepeatOptions', () => {
  it('maps an interval spec to { every }', () => {
    expect(toRepeatOptions({ id: 'x', every: 60_000 })).toEqual({ every: 60_000 });
  });

  it('maps a cron spec to { pattern } and includes tz when set', () => {
    expect(toRepeatOptions({ id: 'x', pattern: '0 3 * * *' })).toEqual({ pattern: '0 3 * * *' });
    expect(toRepeatOptions({ id: 'x', pattern: '0 3 * * *', tz: 'Europe/Vienna' })).toEqual({
      pattern: '0 3 * * *',
      tz: 'Europe/Vienna',
    });
  });

  it('throws when neither every nor pattern is given', () => {
    expect(() => toRepeatOptions({ id: 'bad' } as RepeatSpec)).toThrow(/every.*pattern/);
  });
});

function fakeQueue(): SchedulableQueue & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    upsertJobScheduler: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return undefined;
    }),
  };
}

describe('registerSchedule', () => {
  it('upserts an idempotent scheduler with the right id, repeat opts and template', async () => {
    const queue = fakeQueue();
    await registerSchedule(queue, { id: 'system.heartbeat', every: 60_000 });
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.calls[0]).toEqual([
      'system.heartbeat',
      { every: 60_000 },
      { name: 'system.heartbeat', data: {} },
    ]);
  });
});

describe('registerSchedules', () => {
  it('registers scheduled jobs and skips on-demand ones', async () => {
    const queues = new Map<string, ReturnType<typeof fakeQueue>>();
    const registry = {
      get: (name: string) => {
        let q = queues.get(name);
        if (!q) {
          q = fakeQueue();
          queues.set(name, q);
        }
        return q;
      },
    } as unknown as QueueRegistry;

    const scheduled: JobDefinition = {
      name: 'system.heartbeat',
      handler: async () => {},
      schedule: { id: HEARTBEAT_SCHEDULER_ID, every: HEARTBEAT_INTERVAL_MS },
    };
    const onDemand: JobDefinition = {
      name: 'prices.backfill',
      handler: async () => {},
    };

    const ids = await registerSchedules(registry, [scheduled, onDemand]);

    expect(ids).toEqual([HEARTBEAT_SCHEDULER_ID]);
    expect(queues.get('system.heartbeat')?.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queues.has('prices.backfill')).toBe(false);
  });
});
