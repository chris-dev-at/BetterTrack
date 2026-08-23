import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../data/db';
import type { AuditRepository } from '../../../data/repositories/auditRepository';
import { auditLog } from '../../../data/schema';
import { AuditAction, createAuditService } from '../auditService';

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
