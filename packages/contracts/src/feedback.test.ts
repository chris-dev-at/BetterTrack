import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_CONTEXT_MAX_BYTES,
  FEEDBACK_CONTEXT_MAX_KEYS,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_SUBJECT_MAX_LENGTH,
  createFeedbackRequestSchema,
} from './feedback';

describe('feedback contracts', () => {
  it('accepts the locked categories, a 5000-character message, and extensible diagnostics', () => {
    const result = createFeedbackRequestSchema.safeParse({
      category: 'feature',
      message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH),
      subject: 's'.repeat(FEEDBACK_SUBJECT_MAX_LENGTH),
      context: {
        platform: 'android',
        appVersion: '5.0.0',
        screen: '/portfolio',
        futureDiagnostic: { nested: true },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty/over-length message, unknown category, and over-length subject', () => {
    expect(createFeedbackRequestSchema.safeParse({ category: 'bug', message: '' }).success).toBe(
      false,
    );
    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'bug',
        message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      createFeedbackRequestSchema.safeParse({ category: 'question', message: 'Hello' }).success,
    ).toBe(false);
    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'other',
        message: 'Hello',
        subject: 'x'.repeat(FEEDBACK_SUBJECT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('normalizes a supplied subject and rejects an empty one', () => {
    const normalized = createFeedbackRequestSchema.parse({
      category: 'feature',
      message: 'A useful request',
      subject: '  Better import preview  ',
    });

    expect(normalized.subject).toBe('Better import preview');
    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'feature',
        message: 'A useful request',
        subject: '   ',
      }).success,
    ).toBe(false);
  });

  it('bounds diagnostics by key count and serialized UTF-8 size without locking their names', () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: FEEDBACK_CONTEXT_MAX_KEYS + 1 }, (_, index) => [`key${index}`, index]),
    );
    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'other',
        message: 'Context keys',
        context: tooManyKeys,
      }).success,
    ).toBe(false);

    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'other',
        message: 'Context bytes',
        context: { diagnostic: 'x'.repeat(FEEDBACK_CONTEXT_MAX_BYTES) },
      }).success,
    ).toBe(false);
  });
});
