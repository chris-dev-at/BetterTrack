import { describe, expect, it } from 'vitest';

import { REDACTED, REDACTED_EMAIL, REDACTED_TOKEN, redactString, scrubEvent } from './scrubber';

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

  it('stays linear on a long unbroken run — the scrub cannot stall the capture', () => {
    // A capture is scrubbed BEFORE it is capped, so `redactString` sees the raw
    // message at full length, and again inside the captured stack whose first
    // line repeats it. The email pattern used to rescan from every offset in one
    // unbroken run of email characters, making that O(n²): a 200k-char blob —
    // well inside what an upstream HTML error page or a rejected upload yields —
    // took ~24s, blowing the capture path's budget on a single problem.
    //
    // 200k is deliberately 4x the 50k that already cost ~1.5s: quadratic doubles
    // four-fold per doubling, so a regression here misses this bound by orders
    // of magnitude rather than flaking against it.
    const blob = `blob rejected: ${'A'.repeat(200_000)}`;
    const started = performance.now();
    const out = redactString(blob);
    const elapsed = performance.now() - started;

    expect(out).toBe(blob); // nothing email-shaped in it — no redaction, just the scan
    expect(elapsed).toBeLessThan(1_000);
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
