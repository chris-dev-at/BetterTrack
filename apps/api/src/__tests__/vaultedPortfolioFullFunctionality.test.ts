import type { Application } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiKeyResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { buildRouteTable } from '../scripts/checkOpenapiCoverage';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const IMPORT_TEST_VECTOR =
  'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung\n' +
  '2024-01-02;Steuerkorrektur;;;;;;1,00;EUR';

async function login(app: Application, email: string, password: string) {
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: email, password })
    .expect(200);
  return agent;
}

async function attachLockedStub(h: TestHarness, userId: string) {
  // TEST VECTOR: identity/config-only UUIDs and deliberately non-secret proof
  // labels. No portfolio plaintext or credential-shaped fixture is stored.
  const vaultId = '018f0000-0000-7000-8000-000000000510';
  const portfolioId = '018f0000-0000-7000-8000-000000000511';
  await h.db.insert(schema.vaults).values({
    id: vaultId,
    userId,
    name: 'Locked test vault',
    headerDocId: '018f0000-0000-7000-8000-000000000512',
    commonDocId: '018f0000-0000-7000-8000-000000000513',
    media: ['server'],
    driveConnectionId: null,
    retirementProofPublicKey: 'deterministic-test-vector-public-proof',
    keyFingerprint: 'deterministic-test-vector-fingerprint',
  });
  await h.db.insert(schema.portfolios).values({
    id: portfolioId,
    userId,
    name: 'Locked stub',
    // TEST VECTOR: the locked sibling must not steal the existing portfolio's
    // derived default slot, which is ordered by sortOrder and then UUID.
    sortOrder: 1,
    vaultId,
    vaultAlias: 'Locked test alias',
  });
  return { vaultId, portfolioId };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

async function atCashWriteTestVector<T>(operation: () => Promise<T>): Promise<T> {
  // TEST VECTOR: cash-budget PATCH stamps `new Date()` into its response. Pin
  // Date alone so equal writes on either side of vault attachment are literal
  // byte peers without replacing Supertest's scheduling timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'));
  try {
    return await operation();
  } finally {
    vi.useRealTimers();
  }
}

describe('vaulted portfolio full-functionality boundary', () => {
  it('keeps a same-account plain portfolio byte-identical to its no-vault baseline', async () => {
    const h = await createTestApp();
    const user = await h.seedUser({
      email: 'full-functionality@bettertrack.test',
      username: 'full_functionality',
    });
    const agent = await login(h.app, user.email, user.password);
    const plainId = await h.ctx.portfolio.getDefaultPortfolioId(user.id);

    // Establish all read baselines while this is literally a no-vault account.
    const sharingBefore = bytes(
      await h.ctx.portfolio.updatePortfolioWithVisibility(user.id, plainId, {
        visibility: 'friends',
        confirmWiden: true,
      }),
    );
    const statsBefore = bytes((await agent.get(`/api/v1/portfolios/${plainId}`)).body);
    const cashBefore = bytes((await agent.get(`/api/v1/portfolios/${plainId}/cash/sources`)).body);
    // These are the complete read set used by the expense pages. Pinning a
    // month avoids a wall-clock boundary changing otherwise identical bytes.
    const expensePagePaths = [
      '/api/v1/expenses/categories',
      '/api/v1/expenses/transactions',
      '/api/v1/expenses/rules',
      '/api/v1/expenses/summary?month=2026-08',
      '/api/v1/expenses/trends?months=6',
      '/api/v1/expenses/budgets?month=2026-08',
    ] as const;
    const expensePagesBefore = new Map<string, Buffer>();
    for (const path of expensePagePaths) {
      const response = await agent.get(path);
      expect(response.status, path).toBe(200);
      expensePagesBefore.set(path, bytes(response.body));
    }
    const imported = await h.ctx.imports.createBatch(user.id, {
      portfolioId: plainId,
      filename: 'test-vector.csv',
      content: IMPORT_TEST_VECTOR,
      brokerId: 'trade_republic',
    });
    const importBefore = bytes(await h.ctx.imports.getBatch(user.id, imported.batch.id));
    await agent
      .post('/api/v1/mirrorchain/chains')
      .set(...XRW)
      .send({ name: 'Plain membership' })
      .expect(201);
    const mirrorBefore = bytes((await agent.get('/api/v1/mirrorchain/chains')).body);

    const minted = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'plain cash writer', scopes: ['cash:read', 'cash:write'] })
      .expect(201);
    const token = createApiKeyResponseSchema.parse(minted.body).token;
    const bearerTag = await request(h.app)
      .post('/api/v1/cash/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bearer budget tag', color: '#4477aa' });
    expect(bearerTag.status).toBe(201);
    const tagId = (bearerTag.body as { tag: { id: string } }).tag.id;
    const baselineBudget = await request(h.app)
      .post('/api/v1/cash/budgets')
      .set('Authorization', `Bearer ${token}`)
      .send({ portfolioId: plainId, tagId, amount: 100 });
    expect(baselineBudget.status).toBe(201);
    const budgetId = (baselineBudget.body as { budget: { id: string } }).budget.id;
    const baselineCashWrite = await atCashWriteTestVector(() =>
      request(h.app)
        .patch(`/api/v1/cash/budgets/${budgetId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100 }),
    );
    expect(baselineCashWrite.status).toBe(200);
    const cashWriteBefore = bytes(baselineCashWrite.body);

    const locked = await attachLockedStub(h, user.id);

    const portfolioWire = await agent.get('/api/v1/portfolios');
    expect(portfolioWire.status).toBe(200);
    const wireRows = portfolioWire.body.portfolios as Array<Record<string, unknown>>;
    expect(wireRows.find((row) => row.id === locked.portfolioId)).toMatchObject({
      vaultId: locked.vaultId,
      vaultAlias: 'Locked test alias',
    });
    expect(wireRows.find((row) => row.id === plainId)).toMatchObject({
      vaultId: null,
      vaultAlias: null,
    });

    // The complete retained surface is unchanged for the sibling plain
    // portfolio. Comparing the same resources before/after makes this a literal
    // byte proof: ids and timestamps are identical, not normalized away.
    expect(bytes((await agent.get(`/api/v1/portfolios/${plainId}`)).body).equals(statsBefore)).toBe(
      true,
    );
    expect(
      bytes((await agent.get(`/api/v1/portfolios/${plainId}/cash/sources`)).body).equals(
        cashBefore,
      ),
    ).toBe(true);
    for (const path of expensePagePaths) {
      const response = await agent.get(path);
      expect(response.status, path).toBe(200);
      expect(bytes(response.body).equals(expensePagesBefore.get(path)!)).toBe(true);
    }
    expect(
      bytes(await h.ctx.imports.getBatch(user.id, imported.batch.id)).equals(importBefore),
    ).toBe(true);
    expect(bytes((await agent.get('/api/v1/mirrorchain/chains')).body).equals(mirrorBefore)).toBe(
      true,
    );

    // Retained writes are exercised after vault ownership exists, not merely
    // created in the no-vault baseline and re-read. The import remains keyed to
    // the plain sibling; a new mirror chain creates another plain portfolio and
    // active membership for this same vault-owning account.
    const afterVaultImport = await h.ctx.imports.createBatch(user.id, {
      portfolioId: plainId,
      filename: 'after-vault-test-vector.csv',
      content: IMPORT_TEST_VECTOR,
      brokerId: 'trade_republic',
    });
    expect(afterVaultImport.batch.portfolioId).toBe(plainId);
    const afterVaultMirror = await agent
      .post('/api/v1/mirrorchain/chains')
      .set(...XRW)
      .send({ name: 'Plain membership after vault ownership' });
    expect(afterVaultMirror.status).toBe(201);
    const mirrorPortfolioId = (afterVaultMirror.body as { portfolioId: string }).portfolioId;
    expect(
      await h.ctx.vaultedPortfolioGuard.isOwnedPortfolioVaulted(user.id, mirrorPortfolioId),
    ).toBe(false);

    // The same real sharing mutation returns the same wire bytes before and
    // after the account gains a vault; no IDs or timestamps are normalized.
    expect(
      bytes(
        await h.ctx.portfolio.updatePortfolioWithVisibility(user.id, plainId, {
          visibility: 'friends',
          confirmWiden: true,
        }),
      ).equals(sharingBefore),
    ).toBe(true);

    // A previously account-killed bearer scope remains valid. The same token is
    // refused only when its request targets the locked stub.
    const plainCashWrite = await atCashWriteTestVector(() =>
      request(h.app)
        .patch(`/api/v1/cash/budgets/${budgetId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100 }),
    );
    expect(plainCashWrite.status).toBe(200);
    expect(bytes(plainCashWrite.body).equals(cashWriteBefore)).toBe(true);
    const vaultedCashWrite = await request(h.app)
      .post('/api/v1/cash/budgets')
      .set('Authorization', `Bearer ${token}`)
      .send({ portfolioId: locked.portfolioId, tagId, amount: 100 });
    expect(vaultedCashWrite.status).toBe(403);
    expect(vaultedCashWrite.body.error.code).toBe('VAULTED_PORTFOLIO');
    expect(JSON.stringify(vaultedCashWrite.body)).not.toContain('PARANOID_MODE');

    // Direct below-HTTP boundaries carry the same stable refusal.
    await expect(h.ctx.portfolio.getPortfolio(user.id, locked.portfolioId)).rejects.toMatchObject({
      code: 'VAULTED_PORTFOLIO',
    });
    await expect(
      h.ctx.imports.createBatch(user.id, {
        portfolioId: locked.portfolioId,
        filename: 'locked.csv',
        content: IMPORT_TEST_VECTOR,
        brokerId: 'trade_republic',
      }),
    ).rejects.toMatchObject({ code: 'VAULTED_PORTFOLIO' });
    await expect(h.ctx.mirror.convertChain(user.id, locked.portfolioId)).rejects.toMatchObject({
      code: 'VAULTED_PORTFOLIO',
    });

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.privacyMode).toBe('normal');
  });

  it('has no admin route that can read/restore a vault doc or reset client secrets', () => {
    const forbiddenAdminCapabilities = buildRouteTable()
      .filter((surface) => surface.path.startsWith('/api/v1/admin'))
      .filter((surface) => {
        const path = surface.path;
        return (
          /phrase|device[^/]*password|password[^/]*device/i.test(path) ||
          /vault.*(?:doc|blob|content|cleartext|plaintext|recover|restore)|(?:doc|blob|content|cleartext|plaintext|recover|restore).*vault/i.test(
            path,
          ) ||
          /wip(?:e|ed).*(?:recover|restore)|(?:recover|restore).*wip(?:e|ed)/i.test(path)
        );
      });
    expect(forbiddenAdminCapabilities).toEqual([]);
  });

  it('guards an implicit custom-asset purchase before creating anything and uses a plain sibling', async () => {
    const h = await createTestApp();
    const user = await h.seedUser({
      email: 'custom-boundary@bettertrack.test',
      username: 'custom_boundary',
    });
    const agent = await login(h.app, user.email, user.password);
    const lockedId = await h.ctx.portfolio.getDefaultPortfolioId(user.id);

    // TEST VECTOR: identity/config-only vault metadata. Attaching the historical
    // default recreates the implicit-target edge that previously wrote through
    // customAssets.create without ever classifying a portfolio.
    const vaultId = '018f0000-0000-7000-8000-000000000520';
    await h.db.insert(schema.vaults).values({
      id: vaultId,
      userId: user.id,
      name: 'Implicit target boundary',
      headerDocId: '018f0000-0000-7000-8000-000000000521',
      commonDocId: '018f0000-0000-7000-8000-000000000522',
      media: ['server'],
      driveConnectionId: null,
      retirementProofPublicKey: 'deterministic-implicit-public-proof',
      keyFingerprint: 'deterministic-implicit-fingerprint',
    });
    await h.db.update(schema.portfolios).set({ vaultId }).where(eq(schema.portfolios.id, lockedId));

    const refused = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'Must not half-create',
        category: 'other',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 100, executedAt: '2026-08-20T00:00:00.000Z' },
      });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('VAULTED_PORTFOLIO');
    expect(
      await h.db.select().from(schema.assets).where(eq(schema.assets.ownerId, user.id)),
    ).toEqual([]);

    const sibling = await h.ctx.portfolio.createPortfolio(user.id, { name: 'Plain target' });
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'Plain sibling asset',
        category: 'other',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 100, executedAt: '2026-08-20T00:00:00.000Z' },
      });
    expect(created.status).toBe(201);
    expect(created.body.transactionId).not.toBeNull();
    const transactions = await h.ctx.portfolio.listTransactions(user.id, sibling.id, {
      limit: 20,
    });
    expect(transactions.items.map((item) => item.assetId)).toEqual([created.body.asset.id]);
  });
});
