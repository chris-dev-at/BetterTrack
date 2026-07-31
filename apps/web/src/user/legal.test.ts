import { afterEach, describe, expect, it } from 'vitest';

import { legalUrl, type LegalPage } from './legal';

const LEGAL_PAGES: LegalPage[] = ['terms', 'privacy', 'impressum', 'cookies'];

afterEach(() => {
  delete window.__BT__;
});

describe('legalUrl', () => {
  it.each([
    [undefined, 'en', 'https://bettertrack.at', ''],
    [undefined, 'de', 'https://bettertrack.at', 'de/'],
    ['', 'en', 'https://bettertrack.at', ''],
    ['', 'de', 'https://bettertrack.at', 'de/'],
    ['https://money.example.test/', 'en', 'https://money.example.test', ''],
    ['https://money.example.test/', 'de', 'https://money.example.test', 'de/'],
  ] as const)(
    'uses the deployed product origin %j for the %s legal set',
    (productOrigin, locale, expectedOrigin, localePath) => {
      window.__BT__ = productOrigin === undefined ? undefined : { productOrigin };

      for (const page of LEGAL_PAGES) {
        expect(legalUrl(page, locale)).toBe(`${expectedOrigin}/${page}/${localePath}`);
      }
    },
  );
});
