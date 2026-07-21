import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from '../circuitBreaker';

import { createDeferred } from './fakeProvider';

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

describe('CircuitBreaker — capture hook, reset & single half-open probe (§13.5 V5-P2)', () => {
  it('fires onOpen exactly once when it trips, with the failure and providerId (admin Problems capture)', async () => {
    const opens: Array<{ err: unknown; providerId?: string }> = [];
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 2,
      onOpen: (err, meta) => opens.push({ err, providerId: meta.providerId }),
    });
    const boom = new Error('upstream down');

    await expect(breaker.execute(() => Promise.reject(boom))).rejects.toThrow(); // 1 — not yet
    expect(opens).toHaveLength(0);
    await expect(breaker.execute(() => Promise.reject(boom))).rejects.toThrow(); // 2 → trips
    expect(opens).toEqual([{ err: boom, providerId: 'yahoo' }]);

    // A fast-fail while already open must NOT re-fire the capture hook.
    await expect(breaker.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(opens).toHaveLength(1);
  });

  it('trips immediately (and captures) on a 429 without exhausting the failure count', async () => {
    const opens: unknown[] = [];
    const rateLimited = Object.assign(new Error('HTTP 429'), { code: 429 });
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 5,
      tripImmediately: (err) => (err as { code?: unknown }).code === 429,
      onOpen: (err) => opens.push(err),
    });

    await expect(breaker.execute(() => Promise.reject(rateLimited))).rejects.toThrow('HTTP 429');
    expect(breaker.getState()).toBe('open');
    expect(opens).toEqual([rateLimited]);
  });

  it('fires onOpen again when a half-open probe fails (a re-open is a fresh capture)', async () => {
    const clock = fakeClock();
    const opens: unknown[] = [];
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now,
      onOpen: (err) => opens.push(err),
    });

    await expect(breaker.execute(fail)).rejects.toThrow(); // opens (capture 1)
    clock.advance(1_000); // cooldown elapsed → next call is the probe
    await expect(breaker.execute(fail)).rejects.toThrow(); // probe fails → re-open (capture 2)
    expect(opens).toHaveLength(2);
  });

  it('reset() forces an open breaker back to closed and lets calls through again', async () => {
    const breaker = new CircuitBreaker('p', { failureThreshold: 1 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.getState()).toBe('open');

    breaker.reset();
    expect(breaker.getState()).toBe('closed');
    await expect(breaker.execute(ok)).resolves.toBe('ok');
  });

  it('admits exactly ONE half-open probe: a concurrent call fails fast without touching upstream', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('yahoo', {
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now,
    });

    await expect(breaker.execute(fail)).rejects.toThrow(); // opens
    clock.advance(1_000); // half-open window

    // Start the single probe but keep it in flight so `probing` stays true.
    const probe = createDeferred<string>();
    let probeCalls = 0;
    const probing = breaker.execute(() => {
      probeCalls += 1;
      return probe.promise;
    });

    // A concurrent call while the one probe is unresolved: fails fast, fn unused.
    let secondCalled = false;
    await expect(
      breaker.execute(() => {
        secondCalled = true;
        return ok();
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(secondCalled).toBe(false);
    expect(probeCalls).toBe(1);

    // The probe finally succeeds → the breaker closes.
    probe.resolve('recovered');
    await expect(probing).resolves.toBe('recovered');
    expect(breaker.getState()).toBe('closed');
  });
});
