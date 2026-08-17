import YahooFinance from 'yahoo-finance2';
import { describe, expect, it, vi } from 'vitest';

import { isNotFoundError, isRateLimitError } from '../errors';

/**
 * `HTTPError` is not exported by yahoo-finance2 v4's public package paths.
 * Exercise its real fetch/error path instead: the library constructs the
 * returned error itself from this synthetic upstream response.
 */
async function yahooHttpError(status: 404 | 429): Promise<unknown> {
  const yahoo = new YahooFinance({
    fetch: async () => new Response(`HTTP ${status}`, { status }),
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
});
