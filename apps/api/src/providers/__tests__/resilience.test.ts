import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryOnce, TimeoutError, withTimeout } from '../resilience';

import { createDeferred } from './fakeProvider';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('resolves when the operation finishes within the budget', async () => {
    await expect(withTimeout(() => Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
  });

  it('rejects with TimeoutError when the operation is too slow', async () => {
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 50));
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('propagates the underlying rejection', async () => {
    await expect(withTimeout(() => Promise.reject(new Error('boom')), 1_000)).rejects.toThrowError(
      'boom',
    );
  });

  it('clears the pending timeout when the operation resolves early', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const result = withTimeout(() => deferred.promise, 1_000);

    expect(vi.getTimerCount()).toBe(1);
    deferred.resolve('ok');

    await expect(result).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the pending timeout when the operation rejects early', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const result = withTimeout(() => deferred.promise, 1_000);

    expect(vi.getTimerCount()).toBe(1);
    deferred.reject(new Error('boom'));

    await expect(result).rejects.toThrowError('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a late resolution after the timeout wins', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const result = withTimeout(() => deferred.promise, 10);
    const outcome = result.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(10);
    await expect(outcome).resolves.toMatchObject({
      status: 'rejected',
      error: expect.any(TimeoutError),
    });

    deferred.resolve('late');
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toMatchObject({
      status: 'rejected',
      error: expect.any(TimeoutError),
    });
  });

  it('consumes a late rejection after the timeout wins', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const unhandledRejection = vi.fn();
    const result = withTimeout(() => deferred.promise, 10).catch((error: unknown) => error);

    process.on('unhandledRejection', unhandledRejection);
    try {
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toBeInstanceOf(TimeoutError);

      deferred.reject(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(0);

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});

describe('retryOnce', () => {
  it('does not retry when the first attempt succeeds', async () => {
    const fn = vi.fn(() => Promise.resolve('ok'));
    await expect(retryOnce(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once and succeeds on the second attempt', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    await expect(retryOnce(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates the second failure after exactly two attempts', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('still down')));
    await expect(retryOnce(fn)).rejects.toThrowError('still down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when shouldRetry rejects the error (definitive failures)', async () => {
    const definitive = Object.assign(new Error('HTTP 429'), { code: 429 });
    const fn = vi.fn(() => Promise.reject(definitive));
    await expect(
      retryOnce(fn, (err) => (err as { code?: number }).code !== 429),
    ).rejects.toThrowError('HTTP 429');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries errors shouldRetry accepts', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    await expect(retryOnce(fn, () => true)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('composes with withTimeout for timeout → retry-once', async () => {
    const deferred = createDeferred<string>();
    let attempt = 0;
    const fn = () => {
      attempt += 1;
      // First attempt never settles (times out); second resolves immediately.
      return attempt === 1 ? deferred.promise : Promise.resolve('recovered');
    };
    await expect(retryOnce(() => withTimeout(fn, 10))).resolves.toBe('recovered');
    expect(attempt).toBe(2);
  });
});
