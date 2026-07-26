import { describe, expect, it } from 'vitest';

import { NOTIFICATION_EMAIL_COPY, resolveEmailLocale } from '../emailI18n';

const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

function placeholderNames(copy: string): string[] {
  return [...new Set([...copy.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!))].sort();
}

function assertPlaceholderParity(english: unknown, german: unknown, path: string): void {
  if (typeof english === 'string' && typeof german === 'string') {
    const englishPlaceholders = placeholderNames(english);
    const germanPlaceholders = placeholderNames(german);

    if (JSON.stringify(englishPlaceholders) !== JSON.stringify(germanPlaceholders)) {
      throw new Error(
        `Placeholder mismatch at ${path}: en has [${englishPlaceholders.join(', ')}]; de has [${germanPlaceholders.join(', ')}].`,
      );
    }
    return;
  }

  if (!isCopyObject(english) || !isCopyObject(german)) {
    throw new Error(`Copy structure mismatch at ${path}.`);
  }

  const keys = new Set([...Object.keys(english), ...Object.keys(german)]);
  for (const key of keys) {
    assertPlaceholderParity(english[key], german[key], `${path}.${key}`);
  }
}

function isCopyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('notification email localization copy', () => {
  it('keeps EN and DE interpolation placeholders aligned at every nested copy key', () => {
    assertPlaceholderParity(
      NOTIFICATION_EMAIL_COPY.en,
      NOTIFICATION_EMAIL_COPY.de,
      'NOTIFICATION_EMAIL_COPY',
    );
  });

  it('treats repeated valid placeholders as one placeholder name', () => {
    expect(() =>
      assertPlaceholderParity(
        { body: '{actor} sent an update.' },
        { body: '{actor} hat ein Update von {actor} gesendet.' },
        'notification.body',
      ),
    ).not.toThrow();
  });

  it.each([
    ['a missing placeholder', '{actor} and {symbol}', '{actor}'],
    ['an extra placeholder', '{actor}', '{actor} and {symbol}'],
    ['a misspelled placeholder', '{actor}', '{actro}'],
  ])('reports the nested copy key for %s', (_case, english, german) => {
    expect(() =>
      assertPlaceholderParity({ body: english }, { body: german }, 'notification'),
    ).toThrow('notification.body');
  });
});

describe('resolveEmailLocale', () => {
  it.each([
    ['en', 'en'],
    ['de', 'de'],
    ['DE-at', 'de'],
    [null, 'en'],
    [undefined, 'en'],
    ['fr', 'en'],
  ] as const)('resolves %p to %s', (code, locale) => {
    expect(resolveEmailLocale(code)).toBe(locale);
  });
});
