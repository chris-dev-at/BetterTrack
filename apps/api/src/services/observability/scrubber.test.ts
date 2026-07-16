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

  it('redacts inline Bearer/Basic credentials but keeps the scheme', () => {
    expect(redactString('Authorization is Bearer eyJhbGciOi.J9.sig')).toBe(
      `Authorization is Bearer ${REDACTED_TOKEN}`,
    );
    expect(redactString('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED_TOKEN}`);
  });

  it('leaves clean text untouched', () => {
    expect(redactString('just a normal error message')).toBe('just a normal error message');
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
