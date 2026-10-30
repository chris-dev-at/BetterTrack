import { describe, expect, it } from 'vitest';

import {
  announcementReceiptRowSchema,
  announcementReceiptsQuerySchema,
  announcementSchema,
  announcementStatsResponseSchema,
  ANNOUNCEMENT_RECEIPTS_CSV_COLUMNS,
} from './admin';
import { meResponseSchema } from './auth';
import {
  ANNOUNCEMENT_ERROR_CODES,
  acknowledgeAnnouncementRequestSchema,
  acknowledgementRequiredDetailsSchema,
  activeAnnouncementListResponseSchema,
  activeAnnouncementSchema,
} from './notifications';

const legacyItem = {
  id: '01975600-0000-7000-8000-00000000a001',
  severity: 'info',
  title: 'Maintenance',
  body: 'Tonight.',
  publishedAt: null,
};

describe('announcement user wire (contract §3.3, §4) — additive decoding', () => {
  it('an older server payload with only the five KEPT fields still decodes', () => {
    expect(activeAnnouncementListResponseSchema.parse({ announcements: [legacyItem] })).toEqual({
      announcements: [legacyItem],
    });
  });

  it('an unknown extra field on an item or the envelope is tolerated (CEO addendum 2026-10-30)', () => {
    const parsed = activeAnnouncementListResponseSchema.safeParse({
      announcements: [{ ...legacyItem, kind: 'notice', someFutureField: { nested: true } }],
      nextCursor: 'later',
    });
    expect(parsed.success).toBe(true);
  });

  it('a current item decodes with every NEW field', () => {
    const current = {
      ...legacyItem,
      kind: 'ack_required',
      bodyFormat: 'markdown',
      bodyDoc: { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'Tonight.' }] }] },
      contentLocale: 'de',
      availableLocales: ['en', 'de'],
      contentSha256: 'a'.repeat(64),
      startsAt: null,
      endsAt: '2026-11-30T00:00:00.000Z',
      dismissible: false,
      status: 'active',
      receipt: {
        seenAt: null,
        dismissedAt: null,
        acknowledgedAt: null,
        lapsedAt: null,
        lapseReason: null,
      },
    };
    expect(activeAnnouncementSchema.parse(current)).toEqual(current);
  });

  it('the acknowledge body is strict and demands the literal confirm: true', () => {
    const ok = { confirm: true, locale: 'en', contentSha256: 'b'.repeat(64) };
    const accepts = (body: unknown) => acknowledgeAnnouncementRequestSchema.safeParse(body).success;
    expect(accepts(ok)).toBe(true);
    expect(accepts({ ...ok, confirm: 'true' })).toBe(false);
    expect(accepts({ ...ok, confirm: false })).toBe(false);
    expect(accepts({ ...ok, extra: 1 })).toBe(false);
    expect(accepts({ ...ok, contentSha256: 'B'.repeat(64) })).toBe(false);
    expect(accepts({ ...ok, locale: 'fr' })).toBe(false);
  });

  it('the gate refusal details are never empty', () => {
    const accepts = (body: unknown) => acknowledgementRequiredDetailsSchema.safeParse(body).success;
    expect(accepts({ pendingAcknowledgements: [] })).toBe(false);
    expect(
      accepts({
        pendingAcknowledgements: [
          { id: legacyItem.id, severity: 'critical', title: 'Terms', startsAt: null, endsAt: null },
        ],
      }),
    ).toBe(true);
    expect(ANNOUNCEMENT_ERROR_CODES.acknowledgementRequired).toBe('ACKNOWLEDGEMENT_REQUIRED');
  });

  it('MeResponse carries pendingAcknowledgements optionally — absence still decodes', () => {
    const me = {
      id: legacyItem.id,
      email: 'a@example.test',
      username: 'alice',
      role: 'user',
      status: 'active',
      mustChangePassword: false,
      pinEnabled: false,
      pinLockIdleMinutes: null,
      baseCurrency: 'EUR',
      locale: 'en',
      lastLoginAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    expect(meResponseSchema.safeParse(me).success).toBe(true);
    const owed = meResponseSchema.parse({
      ...me,
      pendingAcknowledgements: [
        { id: legacyItem.id, severity: 'warning', title: 'Terms', startsAt: null, endsAt: null },
      ],
    });
    expect(owed.pendingAcknowledgements).toHaveLength(1);
  });
});

describe('announcement admin wire (contract §7)', () => {
  it('a deleted account reads as a pseudonymised receipt row (§7.5)', () => {
    const row = {
      userId: null,
      subjectToken: 'c'.repeat(64),
      username: null,
      accountCreatedAt: null,
      accountStatus: 'deleted',
      state: 'acknowledged',
      seenAt: null,
      dismissedAt: null,
      acknowledgedAt: '2026-10-30T10:00:00.000Z',
      acknowledgedVia: null,
      acknowledgedLocale: null,
      contentSha256: 'd'.repeat(64),
      lapsedAt: null,
      lapseReason: null,
    };
    expect(announcementReceiptRowSchema.parse(row)).toEqual(row);
    // The CSV header is the row's columns, in order, snake_case.
    expect(ANNOUNCEMENT_RECEIPTS_CSV_COLUMNS).toEqual(
      Object.keys(row).map((key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)),
    );
  });

  it('a receipt row never carries an e-mail or IP column', () => {
    const keys = Object.keys(announcementReceiptRowSchema.shape);
    expect(keys.filter((key) => /email|ip/i.test(key))).toEqual([]);
  });

  it('stats count deleted-account acknowledgements on their own', () => {
    const stats = {
      announcementId: legacyItem.id,
      kind: 'ack_required',
      audience: 3,
      seen: 2,
      dismissed: 0,
      acknowledged: 1,
      acknowledgedByDeletedAccounts: 2,
      lapsed: 0,
      pending: 2,
      lapseRecorded: false,
      computedAt: '2026-10-30T10:00:00.000Z',
    };
    expect(announcementStatsResponseSchema.parse(stats)).toEqual(stats);
  });

  it('receipts paging defaults to all / 50 and caps the limit at 200', () => {
    expect(announcementReceiptsQuerySchema.parse({})).toEqual({ state: 'all', limit: 50 });
    expect(announcementReceiptsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(announcementReceiptsQuerySchema.safeParse({ state: 'everything' }).success).toBe(false);
  });

  it('notifyByEmailAfterDays is an integer 0–365', () => {
    const base = announcementSchema.shape;
    const days = base.notifyByEmailAfterDays.unwrap();
    expect(days.safeParse(0).success).toBe(true);
    expect(days.safeParse(365).success).toBe(true);
    expect(days.safeParse(366).success).toBe(false);
    expect(days.safeParse(-1).success).toBe(false);
    expect(days.safeParse(1.5).success).toBe(false);
  });
});
