import YahooFinance from 'yahoo-finance2';
import { describe, expect, it, vi } from 'vitest';

import { isNotFoundError, isRateLimitError } from '../errors';
import { isRetryableUpstreamError } from '../requestQueue';

/**
 * `HTTPError` is not exported by yahoo-finance2 v4's public package paths.
 * Exercise its real fetch/error path instead: the library constructs the
 * returned error itself from this synthetic upstream response.
 */
async function yahooHttpError(status: 404 | 429 | 500, body = `HTTP ${status}`): Promise<unknown> {
  const yahoo = new YahooFinance({
    fetch: async () => new Response(body, { status }),
    suppressNotices: ['yahooSurvey', 'ripHistorical'],
    versionCheck: false,
  });
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    return await yahoo.search('AAPL').catch((error: unknown) => error);
  } finally {
    errorLog.mockRestore();
  }
}

async function yahooEnvelopeError(status: 404 | 429): Promise<unknown> {
  const code = status === 404 ? 'Not Found' : 'Too Many Requests';
  const description =
    status === 404 ? 'No data found, symbol may be delisted' : 'Too Many Requests';
  return yahooHttpError(
    status,
    JSON.stringify({ finance: { result: null, error: { code, description } } }),
  );
}

describe('yahoo-finance2 v4 HTTPError classification', () => {
  it('recognizes a real v4 rate-limit error by its numeric 429 code', async () => {
    const error = await yahooHttpError(429);

    expect(error).toMatchObject({ name: 'HTTPError', code: 429 });
    expect(isRateLimitError(error)).toBe(true);
    expect(isNotFoundError(error)).toBe(false);
  });

  it('recognizes a real v4 not-found error by its numeric 404 code', async () => {
    const error = await yahooHttpError(404);

    expect(error).toMatchObject({ name: 'HTTPError', code: 404 });
    expect(isNotFoundError(error)).toBe(true);
    expect(isRateLimitError(error)).toBe(false);
  });

  it('recognizes a real v4 JSON-envelope not-found error without a numeric code', async () => {
    const error = await yahooEnvelopeError(404);

    expect(error).toMatchObject({
      name: 'Error',
      message: 'No data found, symbol may be delisted',
    });
    expect(error).not.toHaveProperty('code');
    expect(isNotFoundError(error)).toBe(true);
    expect(isRateLimitError(error)).toBe(false);
  });

  it('recognizes a real v4 JSON-envelope rate-limit error without a numeric code', async () => {
    const error = await yahooEnvelopeError(429);

    expect(error).toMatchObject({ name: 'Error', message: 'Too Many Requests' });
    expect(error).not.toHaveProperty('code');
    expect(isRateLimitError(error)).toBe(true);
    expect(isNotFoundError(error)).toBe(false);
  });

  it('does not classify unrelated or non-Yahoo errors with similar messages', () => {
    const unrelated = new Error('boom');
    const nonYahooNotFound = Object.assign(new Error('No data found, symbol may be delisted'), {
      name: 'FetchError',
    });
    const nonYahooRateLimit = Object.assign(new Error('Too Many Requests'), {
      name: 'FetchError',
    });
    const similarNotFound = new Error('No data found; symbol may be delisted');
    const similarRateLimit = new Error('Request failed: Too Many Requests');

    for (const error of [
      unrelated,
      nonYahooNotFound,
      nonYahooRateLimit,
      similarNotFound,
      similarRateLimit,
    ]) {
      expect(isNotFoundError(error)).toBe(false);
      expect(isRateLimitError(error)).toBe(false);
    }
  });

  it('recognizes a real v4 500 HTTPError as retryable', async () => {
    const error = await yahooHttpError(500);

    expect(error).toMatchObject({ name: 'HTTPError', code: 500 });
    expect(isRetryableUpstreamError(error)).toBe(true);
    expect(isNotFoundError(error)).toBe(false);
    expect(isRateLimitError(error)).toBe(false);
  });
});
