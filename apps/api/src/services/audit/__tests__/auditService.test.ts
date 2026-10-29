import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../data/db';
import type { AuditRepository } from '../../../data/repositories/auditRepository';
import { auditLog } from '../../../data/schema';
import { AUDIT_REDACTED } from '../auditRedaction';
import {
  AuditAction,
  BEARER_SCOPE_DENIAL_REASONS,
  bearerScopeDeniedMetaSchema,
  createAuditService,
} from '../auditService';

describe('AuditService', () => {
  it('records through the supplied transaction executor instead of the primary repository', async () => {
    // Deterministic TEST VECTOR identifiers; none are credentials.
    const actorId = '019c8200-0000-7000-8000-000000000001';
    const portfolioId = '019c8200-0000-7000-8000-000000000002';
    const primaryRecord = vi.fn<AuditRepository['record']>();
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const audit = createAuditService({
      record: primaryRecord,
      list: vi.fn(),
      listForTarget: vi.fn(),
      deleteOlderThan: vi.fn(),
    } as unknown as AuditRepository);
    const transaction = { insert } as unknown as Database;

    await audit.recordInTransaction(transaction, {
      actorId,
      action: AuditAction.PortfolioVaultMovedIn,
      targetType: 'portfolio',
      targetId: portfolioId,
      ip: '192.0.2.1',
      meta: { vaultId: '019c8200-0000-7000-8000-000000000003' },
    });

    expect(primaryRecord).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(auditLog);
    expect(values).toHaveBeenCalledWith({
      actorId,
      action: AuditAction.PortfolioVaultMovedIn,
      targetType: 'portfolio',
      targetId: portfolioId,
      ip: '192.0.2.1',
      meta: { vaultId: '019c8200-0000-7000-8000-000000000003' },
    });
  });

  it('redacts scope-denial resource paths when no privacy hook is supplied', async () => {
    const record = vi.fn<AuditRepository['record']>();
    const audit = createAuditService({
      record,
      list: vi.fn(),
      listForTarget: vi.fn(),
      deleteOlderThan: vi.fn(),
    } as unknown as AuditRepository);

    await audit.record({
      actorId: '019c8200-0000-7000-8000-000000000004',
      action: AuditAction.ApiKeyScopeDenied,
      targetType: 'api_key',
      targetId: '019c8200-0000-7000-8000-000000000005',
      meta: { method: 'GET', path: '/api/v1/assets/private-asset/quote' },
    });

    expect(record).toHaveBeenCalledWith({
      actorId: '019c8200-0000-7000-8000-000000000004',
      action: AuditAction.ApiKeyScopeDenied,
      targetType: 'api_key',
      targetId: '019c8200-0000-7000-8000-000000000005',
      meta: { method: 'GET', path: '[redacted-resource-path]' },
    });
  });
});

/**
 * #1951 §1 — the denial vocabulary has to be closed at RUNTIME, not only in the
 * type system. Before this schema existed, `recordScopeDenied({ reason:
 * 'totally-made-up' as never })` persisted a row nobody could ever group or
 * filter, durable for the full audit retention.
 */
describe('bearerScopeDeniedMetaSchema', () => {
  const personal = {
    requiredScope: 'account:security',
    reason: 'insufficient-scope',
    method: 'GET',
    path: '/settings/oauth-grants',
  };

  it('is derived from the exported constant, so the two cannot drift', () => {
    expect(bearerScopeDeniedMetaSchema.shape.reason.options).toEqual(BEARER_SCOPE_DENIAL_REASONS);
    expect([...BEARER_SCOPE_DENIAL_REASONS]).toEqual(['insufficient-scope', 'first-party-only']);
  });

  it('accepts both live shapes: the personal-key row and its OAuth twin', () => {
    for (const reason of BEARER_SCOPE_DENIAL_REASONS) {
      expect(bearerScopeDeniedMetaSchema.parse({ ...personal, reason })).toEqual({
        ...personal,
        reason,
      });
      expect(bearerScopeDeniedMetaSchema.parse({ ...personal, reason, kind: 'oauth' })).toEqual({
        ...personal,
        reason,
        kind: 'oauth',
      });
    }
  });

  it('throws on a reason outside the vocabulary', () => {
    expect(() =>
      bearerScopeDeniedMetaSchema.parse({ ...personal, reason: 'totally-made-up' }),
    ).toThrow();
    // Near-misses too: casing and spacing are not aliases.
    for (const reason of ['Insufficient-Scope', 'insufficient_scope', 'first party only', '']) {
      expect(() => bearerScopeDeniedMetaSchema.parse({ ...personal, reason }), reason).toThrow();
    }
  });

  it('refuses an unexpected key in the parse object (the spreading-writer shape)', () => {
    // §10: the row identifies the credential by the audit row's own targetId —
    // never by carrying the secret. This guards a writer that SPREADS caller
    // input; today's two writers destructure a fixed list, so an extra property
    // never reaches the parse at all (pinned in `bearerDenialAudit.test.ts`).
    // TEST VECTORS, not real credentials.
    for (const extra of [
      { token: 'btk_not-a-real-token' },
      { tokenHash: 'deadbeef' },
      { authorization: 'Bearer btk_not-a-real-token' },
      { apiKey: 'btk_not-a-real-token' },
    ]) {
      expect(
        () => bearerScopeDeniedMetaSchema.parse({ ...personal, ...extra }),
        Object.keys(extra)[0],
      ).toThrow();
    }
  });

  it('leaves `reason` intact through the #1942 write-path redaction', async () => {
    const record = vi.fn<AuditRepository['record']>();
    const audit = createAuditService({
      record,
      list: vi.fn(),
      listForTarget: vi.fn(),
      deleteOlderThan: vi.fn(),
    } as unknown as AuditRepository);

    await audit.record({
      actorId: '019c8200-0000-7000-8000-000000000006',
      action: AuditAction.ApiKeyScopeDenied,
      targetType: 'api_key',
      targetId: '019c8200-0000-7000-8000-000000000007',
      // `token` cannot reach `record()` through the schema above; passed here
      // only to prove the redactor runs on this action and still keeps `reason`.
      meta: { ...personal, reason: 'first-party-only', token: 'btk_not-a-real-token' },
    });

    const meta = record.mock.calls[0]![0].meta as Record<string, unknown>;
    expect(meta.reason).toBe('first-party-only');
    expect(meta.requiredScope).toBe('account:security');
    expect(meta.token).toBe(AUDIT_REDACTED);
  });
});
