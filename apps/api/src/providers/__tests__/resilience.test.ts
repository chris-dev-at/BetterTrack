import { describe, expect, it, vi } from 'vitest';

import { retryOnce, TimeoutError, withTimeout } from '../resilience';

import { createDeferred } from './fakeProvider';

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
