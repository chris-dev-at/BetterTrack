import { describe, expect, it } from 'vitest';

import { scrubOpsError } from '../ops/opsText';

import {
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_ID,
  REDACTED_TOKEN,
  SCRUB_INPUT_MAX_CHARS,
  boundScrubInput,
  redactIdentifiers,
  redactString,
  scrubEvent,
} from './scrubber';

describe('redactString', () => {
  it('redacts email addresses anywhere in the string', () => {
    expect(redactString('contact alice@example.com now')).toBe(`contact ${REDACTED_EMAIL} now`);
    expect(redactString('a.b+tag@sub.domain.co.uk')).toBe(REDACTED_EMAIL);
  });

  it('redacts BetterTrack API-key and OAuth token shapes', () => {
    expect(redactString('key btk_AbC123._-xyz done')).toBe(`key ${REDACTED_TOKEN} done`);
    expect(redactString('bto_access and btr_refresh and bts_secret and btc_client')).toBe(
      `${REDACTED_TOKEN} and ${REDACTED_TOKEN} and ${REDACTED_TOKEN} and ${REDACTED_TOKEN}`,
    );
  });

  it('redacts a webhook signing secret exactly like an API key', () => {
    // §6.13 V5-P10: `whsec_…` is the one credential shape the scrubber did not
    // know, so it reached problem titles and the per-key request log verbatim.
    expect(redactString('signed with whsec_AbC123._-xyz')).toBe(`signed with ${REDACTED_TOKEN}`);
    expect(redactString('rotate whsec_oldsecret to whsec_newsecret')).toBe(
      `rotate ${REDACTED_TOKEN} to ${REDACTED_TOKEN}`,
    );
    // Redacted the same way a `btk_` key is — same replacement, same fold key.
    expect(redactString('whsec_abc')).toBe(redactString('btk_abc'));
  });

  it('redacts inline Bearer/Basic credentials but keeps the scheme', () => {
    expect(redactString('Authorization is Bearer eyJhbGciOi.J9.sig')).toBe(
      `Authorization is Bearer ${REDACTED_TOKEN}`,
    );
    expect(redactString('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED_TOKEN}`);
  });

  /**
   * The provider-failure path stores a thrown fetch/axios message verbatim, and
   * such a message carries the whole request URL. Neither rule above sees it:
   * an `apikey=` value is not `bt*_`-shaped, and `%40` is not an `@`.
   */
  it('redacts query-string credentials and percent-encoded emails in a provider URL', () => {
    expect(
      redactString(
        'Request failed: https://api.provider.com/v8/finance?apikey=AB12CD34EF&user=alice%40example.com',
      ),
    ).toBe(
      `Request failed: https://api.provider.com/v8/finance?apikey=${REDACTED_TOKEN}&user=${REDACTED_EMAIL}`,
    );
  });

  it('redacts the other credential-bearing parameter names, value only', () => {
    expect(redactString('GET /x?access_token=abc123&page=2')).toBe(
      `GET /x?access_token=${REDACTED_TOKEN}&page=2`,
    );
    expect(redactString('?client_secret=s3cr3t')).toBe(`?client_secret=${REDACTED_TOKEN}`);
    expect(redactString('?password=hunter2&signature=deadbeef')).toBe(
      `?password=${REDACTED_TOKEN}&signature=${REDACTED_TOKEN}`,
    );
  });

  it('leaves clean text untouched', () => {
    expect(redactString('just a normal error message')).toBe('just a normal error message');
    // A non-credential parameter keeps its value — the page still has to be
    // readable, so over-redaction stops at names that mean "secret".
    expect(redactString('GET /assets?symbol=AAPL&range=1y')).toBe(
      'GET /assets?symbol=AAPL&range=1y',
    );
  });

  it('redacts a credential parameter that follows a non-credential one, value only', () => {
    // The rule decides on the parameter NAME, so `?foo=…` must not swallow the
    // parameter after it — including one that only a second URL inside the same
    // message introduces (`?foo=1?apikey=…`), which is where a two-step matcher
    // could silently under-redact.
    expect(redactString('?foo=1&apikey=SECRET')).toBe(`?foo=1&apikey=${REDACTED_TOKEN}`);
    expect(redactString('?foo=1?apikey=SECRET')).toBe(`?foo=1?apikey=${REDACTED_TOKEN}`);
    expect(redactString('?a=1?b=2?token=SECRET')).toBe(`?a=1?b=2?token=${REDACTED_TOKEN}`);
  });

  it('takes a credential value whole even where the walk stops a non-secret one', () => {
    // The matcher stops a NON-secret value at the next `?` so it cannot rescan
    // it (see `QUERY_PARAM_RE`). A secret value must not inherit that stop: a
    // `?` inside it is part of the credential, and keeping the tail would be an
    // under-redaction the cheaper walk paid for.
    expect(redactString('?apikey=abc?def')).toBe(`?apikey=${REDACTED_TOKEN}`);
    expect(redactString('?apikey=abc?def&next=1')).toBe(`?apikey=${REDACTED_TOKEN}&next=1`);
    expect(redactString('?apikey=a=b&c=d')).toBe(`?apikey=${REDACTED_TOKEN}&c=d`);
  });

  it('still redacts an email that follows a long run of email characters', () => {
    // The guard that makes the scan linear anchors matching to a run boundary.
    // An address sitting at the end of a long run must still go — under-redaction
    // would be a PII leak, which is the one failure this scrubber cannot have.
    expect(redactString(`${'A'.repeat(100_000)}alice@example.com`)).toBe(REDACTED_EMAIL);
    expect(redactString(`${'A'.repeat(50_000)} bob@example.com`)).toBe(
      `${'A'.repeat(50_000)} ${REDACTED_EMAIL}`,
    );
    // …and one reached only by backtracking over a long local part.
    expect(redactString(`x${'a.b-c'.repeat(20_000)}@example.com`)).toBe(REDACTED_EMAIL);
  });
});

/**
 * The identifier pass the OPERATIONAL surfaces share (#1847). It used to live
 * only in `scrubOpsError`, so the dead-letter panel and the Problems row
 * written from the very same failure disagreed about the same string.
 */
describe('redactIdentifiers', () => {
  it('redacts a canonical UUID anywhere in the string, on top of every other rule', () => {
    expect(redactIdentifiers('no recipient for user 550e8400-e29b-41d4-a716-446655440000')).toBe(
      `no recipient for user ${REDACTED_ID}`,
    );
    // Upper case, the nil UUID, and more than one of them.
    expect(
      redactIdentifiers(
        'copy 00000000-0000-0000-0000-000000000000 → 018F0000-0000-7000-8000-000000001345',
      ),
    ).toBe(`copy ${REDACTED_ID} → ${REDACTED_ID}`);
    // Everything `redactString` catches still goes.
    expect(
      redactIdentifiers('mail alice@example.com about 550e8400-e29b-41d4-a716-446655440000'),
    ).toBe(`mail ${REDACTED_EMAIL} about ${REDACTED_ID}`);
  });

  it('leaves non-UUID handles alone — a job id is ours, not a user’s object', () => {
    expect(redactIdentifiers('alerts.evaluate job 41 failed')).toBe(
      'alerts.evaluate job 41 failed',
    );
    expect(redactIdentifiers('deadbeef-cafe')).toBe('deadbeef-cafe');
  });

  it('is what `scrubOpsError` applies, so the two surfaces cannot drift apart', () => {
    const failure = 'portfolio 550e8400-e29b-41d4-a716-446655440000 not found';
    expect(scrubOpsError(failure)).toBe(redactIdentifiers(failure));
  });
});

/**
 * The linearity guard, as a TABLE of named regression cases (#1853).
 *
 * It used to be a single input — `'A'.repeat(200_000)` — and that input is
 * FALSE ASSURANCE for every rule but the email one: with no `?`, no `&` and no
 * credential word in it, the query rule never entered the path that made it
 * catastrophic, so the assertion passed at ~0 ms while, on the same machine, a
 * 96 KB run of its own keyword took 1.5 s and a quarter-MB JSON-ish blob 2.9 s.
 *
 * The last row is the shape that a REWRITE reintroduced the blowup on, and it
 * is here because the first three did not catch it: a plain run of
 * `?`-separated parameters whose values nothing terminates. Against a matcher
 * that lets a value span the next `?`, the value is scanned once by its own
 * match and again by every match after it — 300 KB of it cost ~7.5 s, while the
 * single pattern this file's other rows were written for was linear on exactly
 * that input. Cheap parameters, no keyword, no separator: nothing but a cost
 * assertion sees it.
 *
 * The budget is one number for every input on purpose: the linear scan costs a
 * few milliseconds at most for all four, and every shape it replaced cost
 * seconds, so a regression misses this by more than an order of magnitude
 * rather than by a hair.
 *
 * That number was 100 ms, and at 100 ms it reds `verify` (#1856). The scan is
 * not what changed: the 300 KB row costs ~5 ms warm and ~8 ms cold on a dev
 * box, but on a CI runner — which runs the API and web suites concurrently,
 * four forked workers apiece — this whole file took 121 ms on the last GREEN
 * run, and that one row measured 103 ms on the red one. A ~20x spread on a
 * regex-execution-bound scan belongs to the RUNNER, and pricing the guard for
 * an idle dev box left it no room for the machine it actually runs on. 500 ms
 * buys the room back and gives up nothing that matters: the second-scale costs
 * above were measured the same way the ~5 ms was, so on the runner that
 * produced the 103 ms the cheapest of them is tens of seconds, not 1.5 s.
 */
const SCRUB_TIME_BUDGET_MS = 500;

/** How many times a row may re-time its scan before it believes the clock. */
const SCRUB_TIME_SAMPLES = 5;

/**
 * Time `scan` and return the CHEAPEST of up to {@link SCRUB_TIME_SAMPLES} runs.
 *
 * The budget above sets the scale the runner works at; this covers the tail
 * inside it. The assertion is about COMPLEXITY, but a single wall-clock sample
 * also prices in whatever else the machine was doing during it, and against a
 * scan this short one preemption is worth more than the scan itself: measured
 * under 4x CPU oversubscription, single samples of the 300 KB row ranged over
 * 12-72 ms while the cheapest of five stayed at 30 ms.
 *
 * A stall lands on a sample, not on every sample, while a quadratic scan cannot
 * get under the budget on any of them, so the MINIMUM is the statistic that
 * tells the two apart. Sampling stops at the first run inside the budget, so
 * the normal case still pays for exactly one scan, and it stops just as early
 * on a run so far past the budget that only a complexity regression explains
 * it — a reintroduced ~7.5 s blowup fails after one scan, not five.
 */
function fastestScrubMs(scan: () => void): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < SCRUB_TIME_SAMPLES; sample += 1) {
    const started = performance.now();
    scan();
    fastest = Math.min(fastest, performance.now() - started);
    if (fastest < SCRUB_TIME_BUDGET_MS || fastest > SCRUB_TIME_BUDGET_MS * 10) break;
  }
  return fastest;
}

describe('scrub cost', () => {
  it.each([
    ['an unbroken run with nothing rule-shaped in it', `blob rejected: ${'A'.repeat(200_000)}`],
    ['a 96 KB run of the query rule’s own keyword', `?${'key'.repeat(32_000)}`],
    [
      'a quarter-MB JSON-ish blob repeating two credential words',
      `?${'{"apikey":"a","signature":"b"},'.repeat(8_000)}`,
    ],
    ['a 300 KB run of unterminated non-credential parameters', '?a='.repeat(100_000)],
  ])('stays linear on %s', (_label, input) => {
    let out = '';
    const elapsed = fastestScrubMs(() => {
      out = redactIdentifiers(input);
    });

    // None of the four is actually redactable — the scan is all that is timed.
    expect(out).toBe(input);
    expect(elapsed).toBeLessThan(SCRUB_TIME_BUDGET_MS);
  });
});

/**
 * The input bound the two paths that scrub OUTSIDE text apply before scrubbing
 * (#1853). Its whole job is to be cheap without costing redaction strength, so
 * every case here pairs "what was dropped" with "what is still redacted".
 */
describe('boundScrubInput', () => {
  it('leaves a string inside the bound exactly as it was', () => {
    const message = `ECONNREFUSED smtp.example.test:587 ${'x'.repeat(1_000)}`;
    expect(boundScrubInput(message)).toBe(message);
    expect(boundScrubInput('')).toBe('');
  });

  it('cuts at a separator, so a straddling credential goes whole rather than in half', () => {
    const straddling = `${'x'.repeat(SCRUB_INPUT_MAX_CHARS - 10)} ?apikey=SECRETVALUE`;
    const out = redactIdentifiers(boundScrubInput(straddling));

    expect(out).not.toContain('SECRET');
    // The cut fell inside `?apikey=SECRETVALUE`; backing up to the `=` takes the
    // value with it and leaves the readable half of nothing behind.
    expect(out.endsWith('?apikey')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(SCRUB_INPUT_MAX_CHARS);
  });

  it('drops an address the cut landed inside rather than keeping its local part', () => {
    const straddling = `${'x'.repeat(SCRUB_INPUT_MAX_CHARS - 5)} alice@example.com`;
    const out = redactIdentifiers(boundScrubInput(straddling));

    expect(out).not.toContain('alice');
    expect(out).not.toContain('@');
  });

  it('still redacts everything that sits inside the bound', () => {
    const early = `GET /v8?apikey=EARLYSECRET as alice@example.com ${'x'.repeat(SCRUB_INPUT_MAX_CHARS)}`;
    const out = redactIdentifiers(boundScrubInput(early));

    expect(out).toContain(`?apikey=${REDACTED_TOKEN}`);
    expect(out).toContain(REDACTED_EMAIL);
    expect(out).not.toContain('EARLYSECRET');
    expect(out).not.toContain('alice@');
  });

  it('redacts what it kept even when one run is longer than the backoff window', () => {
    // No separator anywhere near the cut, so the cut lands mid-value. The rule
    // matches the value from its `name=` — which is retained — so the kept
    // prefix of the secret still falls.
    const out = redactIdentifiers(boundScrubInput(`?apikey=${'S'.repeat(20_000)}`));

    expect(out).toBe(`?apikey=${REDACTED_TOKEN}`);
  });

  it('bounds the work the rules do — a 1 MB hostile string is read once, briefly', () => {
    const hostile = `?${'{"apikey":"a","signature":"b"},'.repeat(34_000)}`;
    expect(hostile.length).toBeGreaterThan(1_000_000);

    let out = '';
    const elapsed = fastestScrubMs(() => {
      out = redactIdentifiers(boundScrubInput(hostile));
    });

    expect(out.length).toBeLessThanOrEqual(SCRUB_INPUT_MAX_CHARS);
    expect(elapsed).toBeLessThan(SCRUB_TIME_BUDGET_MS);
  });
});

describe('scrubEvent', () => {
  it('returns null for a nullish event (composes as beforeSend)', () => {
    expect(scrubEvent(null)).toBeNull();
    expect(scrubEvent(undefined)).toBeNull();
  });

  it('wholesale-redacts sensitive keys regardless of the folding of their name', () => {
    const event = {
      request: {
        headers: {
          Authorization: 'Bearer btk_secrettoken',
          Cookie: 'bt_session=abc123; other=1',
          'X-Api-Key': 'btk_anotherkey',
          'user-agent': 'Mozilla/5.0',
        },
        cookies: { bt_session: 'abc123' },
      },
    };
    const scrubbed = scrubEvent(event)!;
    const headers = scrubbed.request.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe(REDACTED);
    expect(headers.Cookie).toBe(REDACTED);
    expect(headers['X-Api-Key']).toBe(REDACTED);
    // Non-sensitive keys survive.
    expect(headers['user-agent']).toBe('Mozilla/5.0');
    expect(scrubbed.request.cookies).toBe(REDACTED);
  });

  it('redacts emails and tokens buried inside exception messages and breadcrumbs', () => {
    const event = {
      exception: {
        values: [
          { type: 'Error', value: 'login failed for user@example.com with token btk_abc.def' },
        ],
      },
      breadcrumbs: [{ message: 'GET /x as admin@bettertrack.at' }],
      extra: { note: 'oauth bto_livetoken issued' },
    };
    const serialized = JSON.stringify(scrubEvent(event));
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('admin@bettertrack.at');
    expect(serialized).not.toContain('btk_abc.def');
    expect(serialized).not.toContain('bto_livetoken');
    expect(serialized).toContain(REDACTED_EMAIL);
    expect(serialized).toContain(REDACTED_TOKEN);
  });

  it('strips the email off event.user', () => {
    const event = { user: { id: 'u1', email: 'person@example.com', username: 'person' } };
    const scrubbed = scrubEvent(event)!;
    expect(JSON.stringify(scrubbed)).not.toContain('person@example.com');
    // Redacted-email placeholder replaces the value; id is not sensitive.
    expect((scrubbed.user as Record<string, unknown>).id).toBe('u1');
    expect((scrubbed.user as Record<string, unknown>).email).toBe(REDACTED_EMAIL);
  });

  it('does not mutate the input event', () => {
    const event = { request: { headers: { Authorization: 'Bearer btk_x' } } };
    scrubEvent(event);
    expect(event.request.headers.Authorization).toBe('Bearer btk_x');
  });
});
