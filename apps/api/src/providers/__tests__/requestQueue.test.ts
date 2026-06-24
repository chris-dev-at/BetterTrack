import { describe, expect, it } from 'vitest';

import { createRequestQueue, isRetryableUpstreamError } from '../requestQueue';

/** A fake HTTPError shaped like `yahoo-finance2`'s: an Error with a numeric `code`. */
function httpError(code: number): Error & { code: number } {
  const err = new Error(`HTTP ${code}`) as Error & { code: number };
  err.code = code;
  return err;
}

describe('isRetryableUpstreamError (§5.2)', () => {
  it('retries 429 and 5xx, not 4xx or code-less errors', () => {
    expect(isRetryableUpstreamError(httpError(429))).toBe(true);
    expect(isRetryableUpstreamError(httpError(500))).toBe(true);
    expect(isRetryableUpstreamError(httpError(503))).toBe(true);
    expect(isRetryableUpstreamError(httpError(404))).toBe(false);
    expect(isRetryableUpstreamError(httpError(400))).toBe(false);
    expect(isRetryableUpstreamError(new Error('network'))).toBe(false);
    expect(isRetryableUpstreamError(null)).toBe(false);
  });
});

describe('createRequestQueue concurrency cap (§5.2)', () => {
  it('never runs more than `concurrency` tasks at once', async () => {
    const N = 12;
    const queue = createRequestQueue({ concurrency: 4 });
    let active = 0;
    let peak = 0;
    let started = 0;
    const gates: Array<() => void> = [];

    // Each task records the live concurrency, then parks until we open its gate.
    const tasks = Array.from({ length: N }, () =>
      queue.run(async () => {
        active += 1;
        started += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
      }),
    );

    // Drive the queue one wave at a time: open every currently-parked task, then
    // let the freed slots admit the next wave. Guard bounds against a stall.
    let guard = 0;
    while (started < N && guard < 1000) {
      guard += 1;
      await Promise.resolve();
      while (gates.length > 0) gates.shift()!();
    }
    // Release any final wave still parked.
    while (gates.length > 0) gates.shift()!();
    await Promise.all(tasks);

    expect(started).toBe(N);
    expect(peak).toBe(4);
  });
});

describe('createRequestQueue backoff (§5.2)', () => {
  it('backs off and retries on 429, then succeeds, with exponential delays', async () => {
    const delays: number[] = [];
    const queue = createRequestQueue({
      baseDelayMs: 100,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    let attempts = 0;
    const result = await queue.run(async () => {
      attempts += 1;
      if (attempts <= 2) throw httpError(429);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]); // 100 * 2^0, 100 * 2^1
  });

  it('does not retry a non-retryable (4xx) error', async () => {
    const delays: number[] = [];
    const queue = createRequestQueue({ sleep: (ms) => (delays.push(ms), Promise.resolve()) });

    let attempts = 0;
    await expect(
      queue.run(async () => {
        attempts += 1;
        throw httpError(404);
      }),
    ).rejects.toMatchObject({ code: 404 });

    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const queue = createRequestQueue({
      maxRetries: 3,
      sleep: () => Promise.resolve(),
    });

    let attempts = 0;
    await expect(
      queue.run(async () => {
        attempts += 1;
        throw httpError(503);
      }),
    ).rejects.toMatchObject({ code: 503 });

    expect(attempts).toBe(4); // 1 initial + 3 retries
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const queue = createRequestQueue({
      baseDelayMs: 1000,
      maxDelayMs: 2500,
      maxRetries: 4,
      sleep: (ms) => (delays.push(ms), Promise.resolve()),
    });

    await expect(queue.run(() => Promise.reject(httpError(500)))).rejects.toBeDefined();

    // 1000, 2000, then capped at 2500, 2500.
    expect(delays).toEqual([1000, 2000, 2500, 2500]);
  });
});
