import { describe, expect, it } from 'vitest';

import { describeUserAgent, UNKNOWN_DEVICE } from '../deviceLabel';

/** Coarse UA → label parsing for the session manager (V3-P11a). */
describe('describeUserAgent', () => {
  it('labels common desktop browsers as "<Browser> on <OS>"', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      ),
    ).toBe('Firefox on Windows');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('Safari on macOS');
  });

  it('distinguishes Edge from Chrome (both carry a chrome token)', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      ),
    ).toBe('Edge on Windows');
  });

  it('labels mobile platforms', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
  });

  it('falls back to "Unknown device" for missing or opaque agents', () => {
    expect(describeUserAgent(null)).toBe(UNKNOWN_DEVICE);
    expect(describeUserAgent(undefined)).toBe(UNKNOWN_DEVICE);
    expect(describeUserAgent('')).toBe(UNKNOWN_DEVICE);
    expect(describeUserAgent('   ')).toBe(UNKNOWN_DEVICE);
    expect(describeUserAgent('curl/8.4.0')).toBe(UNKNOWN_DEVICE);
  });

  it('degrades to whichever half it can recognise', () => {
    // OS but no recognisable browser token.
    expect(describeUserAgent('SomeBot (Windows NT 10.0)')).toBe('Windows');
  });
});
