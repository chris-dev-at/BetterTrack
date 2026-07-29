import { describe, expect, it, vi } from 'vitest';

import {
  checkWorkerHeartbeat,
  isWorkerHeartbeatFresh,
  WORKER_HEARTBEAT_MAX_AGE_MS,
} from '../workerHealth';

describe('worker heartbeat health probe', () => {
  it('accepts only a fresh, parseable heartbeat', () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');

    expect(
      isWorkerHeartbeatFresh(new Date(now - WORKER_HEARTBEAT_MAX_AGE_MS).toISOString(), now),
    ).toBe(true);
    expect(
      isWorkerHeartbeatFresh(new Date(now - WORKER_HEARTBEAT_MAX_AGE_MS - 1).toISOString(), now),
    ).toBe(false);
    expect(isWorkerHeartbeatFresh(null, now)).toBe(false);
    expect(isWorkerHeartbeatFresh('not-a-date', now)).toBe(false);
  });

  it('reads the canonical worker heartbeat key', async () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    const get = vi.fn(async () => new Date(now - 1_000).toISOString());

    await expect(checkWorkerHeartbeat({ get } as never, { now })).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith('system:heartbeat:last');
  });

  it('fails closed when Redis errors or exceeds the probe timeout', async () => {
    const rejects = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const hangs = vi.fn(() => new Promise<string | null>(() => undefined));

    await expect(checkWorkerHeartbeat({ get: rejects } as never)).resolves.toBe(false);
    await expect(checkWorkerHeartbeat({ get: hangs } as never, { timeoutMs: 5 })).resolves.toBe(
      false,
    );
  });
});
