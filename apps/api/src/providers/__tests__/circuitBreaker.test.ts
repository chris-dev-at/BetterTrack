import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from '../circuitBreaker';

/** A controllable clock so cooldown transitions are deterministic. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const fail = () => Promise.reject(new Error('upstream down'));
const ok = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  it('stays closed and passes calls through while healthy', async () => {
    const breaker = new CircuitBreaker('p', { failureThreshold: 3 });
    await expect(breaker.execute(ok)).resolves.toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after the failure threshold and then fails fast without calling fn', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 2,
      openMs: 1_000,
      now: clock.now,
    });

    await expect(breaker.execute(fail)).rejects.toThrowError('upstream down'); // 1
    await expect(breaker.execute(fail)).rejects.toThrowError('upstream down'); // 2 → opens
    expect(breaker.getState()).toBe('open');

    let called = false;
    const probe = () => {
      called = true;
      return ok();
    };
    await expect(breaker.execute(probe)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false); // fn never ran while open
  });

  it('goes half-open after the cooldown and closes on a successful probe', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now,
    });

    await expect(breaker.execute(fail)).rejects.toThrowError(); // opens immediately
    expect(breaker.getState()).toBe('open');

    clock.advance(1_000); // cooldown elapsed
    expect(breaker.getState()).toBe('half-open');

    await expect(breaker.execute(ok)).resolves.toBe('ok'); // probe succeeds → close
    expect(breaker.getState()).toBe('closed');
  });

  it('re-opens when the half-open probe fails', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now,
    });

    await expect(breaker.execute(fail)).rejects.toThrowError();
    clock.advance(1_000);
    await expect(breaker.execute(fail)).rejects.toThrowError('upstream down'); // probe fails → reopen
    expect(breaker.getState()).toBe('open');

    // Still within the fresh cooldown: fails fast again.
    await expect(breaker.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('trips open immediately on a failure matching tripImmediately (§5.3, upstream 429)', async () => {
    const clock = fakeClock();
    const rateLimited = Object.assign(new Error('HTTP 429'), { code: 429 });
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 5, // far from exhausted — the 429 alone must trip it
      openMs: 1_000,
      now: clock.now,
      tripImmediately: (err) => (err as { code?: unknown }).code === 429,
    });

    await expect(breaker.execute(() => Promise.reject(rateLimited))).rejects.toThrowError(
      'HTTP 429',
    );
    expect(breaker.getState()).toBe('open');

    // Fails fast while open; recovers through the normal half-open probe.
    await expect(breaker.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    clock.advance(1_000);
    await expect(breaker.execute(ok)).resolves.toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('resets consecutive failures on a success', async () => {
    const breaker = new CircuitBreaker('p', { failureThreshold: 3 });
    await expect(breaker.execute(fail)).rejects.toThrowError();
    await expect(breaker.execute(fail)).rejects.toThrowError();
    await expect(breaker.execute(ok)).resolves.toBe('ok'); // resets the counter
    await expect(breaker.execute(fail)).rejects.toThrowError();
    await expect(breaker.execute(fail)).rejects.toThrowError();
    expect(breaker.getState()).toBe('closed'); // only 2 in a row since reset
  });
});
