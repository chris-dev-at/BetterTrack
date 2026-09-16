import type { Socket as ClientSocket } from 'socket.io-client';

/**
 * Bounded waits for a *completion*, shared by the suites that used to sleep
 * (issue #1622).
 *
 * PROJECTPLAN.md §12 wants unit/service tests "milliseconds-fast" and gating
 * every commit. `await new Promise((r) => setTimeout(r, 30))` fails that on both
 * counts: it costs its 30 ms whether or not the thing arrived in 1 ms, and on a
 * loaded machine the thing it was approximating takes longer than 30 ms and the
 * test goes red with no assertion failure — the recorded incident where mass
 * timeouts faked a regression for hours.
 *
 * Every helper here takes a *deadline*, not a delay: it settles the instant the
 * event lands, and only fails after `ms` with a message that names what never
 * arrived. The `setTimeout` inside each one is that deadline — it is never on
 * the success path, so these are not sleeps and the `tests/no-sleep` lint gate
 * (which only matches a single-parameter `new Promise` executor whose whole job
 * is a timer) does not — and should not — fire on them.
 *
 * NOTE ON LOCATION: the API's other test doubles live in `src/testing/`. That
 * directory is owned by an in-flight lane while this one lands, so these two
 * helpers get their own module; folding `src/test/` into `src/testing/` is a
 * pure move once that lane merges.
 */

/** Vitest's default `testTimeout` is 20 s; stay well inside it. */
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Resolve with the value a callback-registering `register` hands back, or reject
 * after `ms` naming `what`.
 *
 * Use it for an emitter the test can only observe through a callback:
 *
 * ```ts
 * const event = await waitForEvent<DomainEvent>(
 *   'quote.updated on the bus',
 *   (deliver) => bus.subscribe('quote.updated', deliver),
 * );
 * ```
 *
 * `register` may return a promise (a subscription that must itself be awaited);
 * if it rejects, this rejects with that error rather than timing out on it.
 */
export function waitForEvent<T>(
  what: string,
  register: (deliver: (value: T) => void) => void | Promise<unknown>,
  ms: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)),
      ms,
    );
    const settle = (value: T): void => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const registered = register(settle);
      if (registered && typeof (registered as Promise<unknown>).catch === 'function') {
        void (registered as Promise<unknown>).catch((err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Resolve with the next `event` payload on `socket`, or reject after `ms`. */
export function waitForSocketEvent<T>(
  socket: ClientSocket,
  event: string,
  ms: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return waitForEvent<T>(
    `socket event \`${event}\``,
    (deliver) => {
      socket.once(event, (payload: T) => deliver(payload));
    },
    ms,
  );
}

/** Emit `event` with `payload` and resolve with the server's ack, or reject after `ms`. */
export function waitForSocketAck<T>(
  socket: ClientSocket,
  event: string,
  payload: unknown,
  ms: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return waitForEvent<T>(
    `ack for \`${event}\``,
    (deliver) => {
      socket.emit(event, payload, (ack: T) => deliver(ack));
    },
    ms,
  );
}

/** Resolve once `socket` is disconnected (immediately if it already is). */
export function waitForSocketDisconnect(
  socket: ClientSocket,
  ms: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!socket.connected) return Promise.resolve();
  return waitForEvent<void>(
    'the socket to disconnect',
    (deliver) => {
      socket.once('disconnect', () => deliver(undefined));
    },
    ms,
  );
}

/**
 * Assert `event` does NOT arrive on `socket` — *without* a quiet window.
 *
 * A bare "wait 300 ms and hope" proves nothing on a slow machine and costs
 * 300 ms on a fast one. Socket.IO delivers packets to one connection in order,
 * so a round-trip that the server acks *after* the fan-out under test is a
 * barrier: once the ack is back, a leaked `event` would already have arrived.
 * Pass the round-trip as `barrier` — typically the room-join ack the suite
 * already has a helper for.
 */
export async function expectSocketSilence(
  socket: ClientSocket,
  event: string,
  barrier: () => Promise<unknown>,
): Promise<void> {
  let leaked: unknown;
  let sawEvent = false;
  const record = (payload: unknown): void => {
    sawEvent = true;
    leaked = payload;
  };
  socket.on(event, record);
  try {
    await barrier();
  } finally {
    socket.off(event, record);
  }
  if (sawEvent) {
    throw new Error(`unexpected \`${event}\` received: ${JSON.stringify(leaked)}`);
  }
}

/**
 * Yield ONE turn of the event loop — a macrotask boundary, not a delay.
 *
 * The honest tool for the assertion "this promise has NOT settled": awaiting
 * `Promise.resolve()` only drains microtasks, so a continuation scheduled behind
 * any I/O would be missed and the assertion would pass vacuously. `setImmediate`
 * runs on the next check phase, after pending microtasks and I/O callbacks, and
 * carries no timeout — so unlike `setTimeout(resolve, 0)` there is no window for
 * a loaded machine to invalidate, and nothing to tune.
 *
 * It is still weaker than awaiting a real completion, because "has not settled
 * yet" is not "cannot settle". Reach for it only where the thing under test is
 * *blocked* on something the test itself holds open (a database lock, a gate
 * promise) and the release is asserted straight after.
 */
export function flushMacrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
