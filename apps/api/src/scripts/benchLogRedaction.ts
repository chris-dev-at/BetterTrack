/**
 * The measurement behind the §10 log-redaction policy (#1926).
 *
 * `pnpm --filter @bettertrack/api bench:log-redaction`
 *
 * #1926 asked for the cost of widening the redaction policy to be measured
 * before it was adopted, on a ~1 KB and a ~300 KB payload. This is that
 * harness, committed rather than thrown away for two reasons: the decision it
 * drove (a single walk instead of a wildcard path ladder — see `logger.ts`)
 * rests entirely on its numbers, and the issue asks for the comparison to be
 * re-run when the Docker base reaches Node ≥ 25 and pino's `JSON.stringify`
 * fast path activates.
 *
 * It compares four wirings of the SAME key policy:
 *
 *   A  the 9-path backstop alone — what main ships, and the baseline
 *   B  the whole key list as a depth-1..3 wildcard ladder (the rejected fix)
 *   C  what ships here: backstop + `formatters.log` walk + `err` serializer
 *   D  the walk alone, with pino's `redact` removed entirely
 *
 * Reports µs/op (best of 5 runs, after a warm-up) into a discarding
 * destination, so the numbers are redaction plus serialization and nothing
 * else — no disk, no terminal.
 */
import { Writable } from 'node:stream';

import { pino, stdSerializers, type LoggerOptions } from 'pino';

import { redactForLog, SECRET_KEYS } from '../logger';

/** The policy exactly as main ships it, and the backstop this branch keeps. */
const BACKSTOP_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.tempPassword',
  '*.passwordHash',
  '*.tokenHash',
];
const BACKSTOP = Object.freeze({ paths: BACKSTOP_PATHS, remove: true });

/**
 * The rejected alternative: every key at depths 1–3 as `@pinojs/redact` paths.
 * `*` matches an array index as readily as an object key, so the depth-3 form
 * also covers `{ items: [{ password }] }`.
 */
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LADDER_PATHS = SECRET_KEYS.flatMap((key) => {
  const plain = PLAIN_KEY.test(key);
  const head = plain ? key : `["${key}"]`;
  const tail = plain ? `.${key}` : `["${key}"]`;
  return [head, `*${tail}`, `*.*${tail}`];
});
const LADDER = Object.freeze({ paths: LADDER_PATHS, remove: true });

const sink = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

interface Variant {
  redact?: LoggerOptions['redact'];
  walk?: boolean;
  errSerializer?: boolean;
}

function makeLogger({ redact, walk, errSerializer }: Variant) {
  const options: LoggerOptions = { level: 'info' };
  if (redact) options.redact = redact;
  if (walk) options.formatters = { log: redactForLog };
  if (errSerializer) {
    options.serializers = { err: (e: unknown) => redactForLog(stdSerializers.err(e as Error)) };
  }
  return pino(options, sink());
}

/** A ~1 KB request-shaped line: the hot path, one per request or job run. */
function payloadSmall() {
  return {
    req: {
      id: 'req-01JB8Q2',
      method: 'POST',
      url: '/api/v1/portfolios/8f2c/transactions',
      headers: {
        cookie: 'bt_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorization: 'Bearer btk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'accept-language': 'de-AT,de;q=0.9,en;q=0.8',
        'x-request-id': 'c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      },
    },
    body: {
      portfolioId: 'c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      side: 'buy',
      quantity: '12.5',
      price: '183.4400',
      currency: 'EUR',
      note: 'monthly savings plan execution, tranche 4 of 12, broker confirmation attached',
    },
    user: { id: 'a0b1c2d3-e4f5-4061-8273-849506a7b8c9', kind: 'user' },
    durationMs: 41,
  };
}

/** A ~300 KB line: an import batch, the realistic way an object that big logs. */
function payloadLarge() {
  const rows = Array.from({ length: 900 }, (_, i) => ({
    idx: i,
    id: `c1b2a3d4-e5f6-4a7b-8c9d-${String(i).padStart(12, '0')}`,
    symbol: `SYM${i % 500}.DE`,
    name: `Instrument number ${i} with a reasonably long human readable name`,
    quantity: `${i}.000000`,
    price: `${(i % 500) + 0.44}`,
    currency: 'EUR',
    bookedAt: '2026-09-15T08:12:33.123Z',
    note: 'imported from broker CSV, column mapping v3, deduplicated on (symbol, bookedAt)',
    meta: { source: 'csv', row: i, warnings: [] as string[] },
  }));
  return { job: 'imports.apply', importId: 'c1b2a3d4', body: { rows } };
}

function bench(logger: ReturnType<typeof makeLogger>, obj: object, iterations: number): number {
  for (let i = 0; i < Math.min(iterations, 2_000); i += 1) logger.info(obj, 'probe');
  let best = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) logger.info(obj, 'probe');
    best = Math.min(best, Number(process.hrtime.bigint() - start) / iterations);
  }
  return best;
}

const VARIANTS: [string, Variant][] = [
  ['no redaction at all', {}],
  ['A backstop only (main today)', { redact: BACKSTOP }],
  ['B full depth-1..3 wildcard ladder', { redact: LADDER }],
  ['C shipped: backstop + walk + err', { redact: BACKSTOP, walk: true, errSerializer: true }],
  ['D walk only, no pino redact', { walk: true, errSerializer: true }],
];

function main(): void {
  const small = payloadSmall();
  const large = payloadLarge();

  console.log(`node ${process.version}`);
  console.log(
    `payloads: ${JSON.stringify(small).length} B / ${JSON.stringify(large).length} B; ` +
      `paths: backstop ${BACKSTOP_PATHS.length}, ladder ${LADDER_PATHS.length}; ` +
      `walked keys ${SECRET_KEYS.length}`,
  );

  const smallResults = VARIANTS.map(([, variant]) => bench(makeLogger(variant), small, 20_000));
  const largeResults = VARIANTS.map(([, variant]) => bench(makeLogger(variant), large, 200));
  const smallBase = smallResults[1]!;
  const largeBase = largeResults[1]!;

  console.log(`\n${'variant'.padEnd(36)}${'1 KB'.padStart(20)}${'300 KB'.padStart(20)}`);
  VARIANTS.forEach(([label], i) => {
    const s = `${(smallResults[i]! / 1_000).toFixed(2)} µs (${(smallResults[i]! / smallBase).toFixed(2)}×)`;
    const l = `${(largeResults[i]! / 1_000).toFixed(2)} µs (${(largeResults[i]! / largeBase).toFixed(2)}×)`;
    console.log(label.padEnd(36) + s.padStart(20) + l.padStart(20));
  });

  // The error path separately: it is the one the `err` serializer taxes.
  const decorated = Object.assign(new Error('upstream refused'), {
    body: { email: 'user@example.com', password: 'nope' },
    cause: { request: { headers: { authorization: 'Bearer x' } } },
  });
  const errBase = bench(makeLogger({ redact: BACKSTOP }), { err: decorated }, 20_000);
  const errShipped = bench(
    makeLogger({ redact: BACKSTOP, walk: true, errSerializer: true }),
    { err: decorated },
    20_000,
  );
  console.log(
    `\ndecorated Error: A ${(errBase / 1_000).toFixed(2)} µs, ` +
      `C ${(errShipped / 1_000).toFixed(2)} µs (${(errShipped / errBase).toFixed(2)}×)`,
  );
}

main();
