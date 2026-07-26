import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InviteRow, RegistrationTokenRow } from '../data/schema';

import { toAdminInvite, toRegistrationToken } from './serializers';

const now = new Date('2026-07-26T12:00:00.000Z');
const createdAt = new Date('2026-07-01T08:30:00.000Z');
const beforeNow = new Date('2026-07-26T11:59:59.999Z');
const afterNow = new Date('2026-07-26T12:00:00.001Z');
const usedAt = new Date('2026-07-10T09:45:00.000Z');
const revokedAt = new Date('2026-07-11T10:15:00.000Z');

function inviteRow(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    email: 'invitee@example.com',
    tokenHash: 'invite-token-hash',
    createdBy: null,
    expiresAt: afterNow,
    usedAt: null,
    revokedAt: null,
    createdAt,
    ...overrides,
  };
}

function registrationTokenRow(overrides: Partial<RegistrationTokenRow> = {}): RegistrationTokenRow {
  return {
    id: '00000000-0000-7000-8000-000000000002',
    tokenHash: 'registration-token-hash',
    label: null,
    maxUses: 2,
    useCount: 0,
    createdBy: null,
    expiresAt: null,
    revokedAt: null,
    createdAt,
    ...overrides,
  };
}

describe('admin token serializers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes invite statuses with revoked, used, expired, then pending precedence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(toAdminInvite(inviteRow({ revokedAt, usedAt, expiresAt: beforeNow })).status).toBe(
      'revoked',
    );
    expect(toAdminInvite(inviteRow({ usedAt, expiresAt: beforeNow })).status).toBe('used');
    expect(toAdminInvite(inviteRow({ expiresAt: now })).status).toBe('expired');
    expect(toAdminInvite(inviteRow()).status).toBe('pending');
  });

  it('serializes invite date fields as ISO strings and nullable fields as null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(toAdminInvite(inviteRow())).toMatchObject({
      createdAt: '2026-07-01T08:30:00.000Z',
      expiresAt: '2026-07-26T12:00:00.001Z',
      usedAt: null,
      revokedAt: null,
    });
    expect(toAdminInvite(inviteRow({ usedAt, revokedAt }))).toMatchObject({
      usedAt: '2026-07-10T09:45:00.000Z',
      revokedAt: '2026-07-11T10:15:00.000Z',
    });
  });

  it('serializes registration-token statuses with revoked, expired, exhausted, then active precedence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(
      toRegistrationToken(registrationTokenRow({ revokedAt, expiresAt: beforeNow, useCount: 2 }))
        .status,
    ).toBe('revoked');
    expect(toRegistrationToken(registrationTokenRow({ expiresAt: now, useCount: 2 })).status).toBe(
      'expired',
    );
    expect(toRegistrationToken(registrationTokenRow({ useCount: 2 })).status).toBe('exhausted');
    expect(toRegistrationToken(registrationTokenRow()).status).toBe('active');
  });

  it('serializes registration-token date fields as ISO strings and nullable fields as null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(toRegistrationToken(registrationTokenRow())).toMatchObject({
      createdAt: '2026-07-01T08:30:00.000Z',
      expiresAt: null,
      revokedAt: null,
    });
    expect(
      toRegistrationToken(registrationTokenRow({ expiresAt: afterNow, revokedAt })),
    ).toMatchObject({
      expiresAt: '2026-07-26T12:00:00.001Z',
      revokedAt: '2026-07-11T10:15:00.000Z',
    });
  });
});
