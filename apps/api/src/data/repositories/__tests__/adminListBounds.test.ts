import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import type { Database } from '../../db';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createApiKeyRepository } from '../apiKeyRepository';
import { createInviteRepository } from '../inviteRepository';
import { createRegistrationRequestRepository } from '../registrationRequestRepository';
import { createRegistrationTokenRepository } from '../registrationTokenRepository';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/**
 * A `Database` that records the SQL every `select()` chain finally issues.
 *
 * The point of #1814's bound is that the DATABASE returns one page — a
 * repository that fetched every row and sliced the array afterwards would pass
 * a row-count assertion while still reading the whole table. So the assertion
 * is on the emitted statement: the drizzle builder is thenable, and by the time
 * it is awaited its `toSQL()` is the query that will run.
 */
function recordingDb(db: Database): { db: Database; statements: string[] } {
  const statements: string[] = [];

  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === 'then') {
          const toSQL = Reflect.get(target, 'toSQL');
          if (typeof toSQL === 'function') {
            statements.push((toSQL.call(target) as { sql: string }).sql);
          }
        }
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result !== null && typeof result === 'object' && !(result instanceof Promise)
            ? wrap(result)
            : result;
        };
      },
    });

  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === 'select' && typeof value === 'function') {
        return (...args: unknown[]) =>
          wrap((value as (...a: unknown[]) => object).apply(target, args));
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });

  return { db: proxy as Database, statements };
}

/** The row-returning statement of a paged read (the sibling one is the COUNT). */
const rowStatement = (statements: string[]): string =>
  statements.find((sql) => !/count\(/i.test(sql)) ?? '';

describe('bounded admin lists (§6.12, V5-P2 — #1814)', () => {
  it('reads invites through a SQL limit/offset, not an array slice', async () => {
    const admin = await harness.seedAdmin();
    await harness.db.insert(schema.invites).values(
      Array.from({ length: 5 }, (_, i) => ({
        email: `invitee-${i}@example.com`,
        tokenHash: `invite-hash-${i}`,
        createdBy: admin.id,
        expiresAt: new Date(Date.UTC(2026, 8, 10 + i)),
        createdAt: new Date(Date.UTC(2026, 8, 1 + i)),
      })),
    );
    const { db, statements } = recordingDb(harness.db);
    const repo = createInviteRepository(db);

    const first = await repo.listPage({ limit: 2, offset: 0 });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(5);
    // Newest first: rows 4 and 3.
    expect(first.rows.map((row) => row.email)).toEqual([
      'invitee-4@example.com',
      'invitee-3@example.com',
    ]);
    // Drizzle omits a zero offset, so page 1 proves the LIMIT and page 2 the
    // OFFSET — together, that the window is the database's and not a slice.
    expect(rowStatement(statements)).toMatch(/limit \$\d+$/i);

    statements.length = 0;
    const second = await repo.listPage({ limit: 2, offset: 2 });
    expect(rowStatement(statements)).toMatch(/limit \$\d+ offset \$\d+$/i);
    expect(second.rows.map((row) => row.email)).toEqual([
      'invitee-2@example.com',
      'invitee-1@example.com',
    ]);
  });

  it('reads registration tokens through a SQL limit/offset', async () => {
    const admin = await harness.seedAdmin();
    await harness.db.insert(schema.registrationTokens).values(
      Array.from({ length: 4 }, (_, i) => ({
        tokenHash: `token-hash-${i}`,
        label: `wave ${i}`,
        maxUses: 1,
        createdBy: admin.id,
        createdAt: new Date(Date.UTC(2026, 8, 1 + i)),
      })),
    );
    const { db, statements } = recordingDb(harness.db);
    const repo = createRegistrationTokenRepository(db);

    const page = await repo.listPage({ limit: 1, offset: 1 });
    expect(page.rows.map((row) => row.label)).toEqual(['wave 2']);
    expect(page.total).toBe(4);
    expect(rowStatement(statements)).toMatch(/limit \$\d+ offset \$\d+$/i);
  });

  it('reads registration applications through a SQL limit/offset', async () => {
    await harness.db.insert(schema.registrationRequests).values(
      Array.from({ length: 4 }, (_, i) => ({
        email: `applicant-${i}@example.com`,
        username: `applicant${i}`,
        passwordHash: 'hash',
        createdAt: new Date(Date.UTC(2026, 8, 1 + i)),
      })),
    );
    const { db, statements } = recordingDb(harness.db);
    const repo = createRegistrationRequestRepository(db);

    const page = await repo.listPage({ limit: 2, offset: 0 });
    expect(page.rows.map((row) => row.username)).toEqual(['applicant3', 'applicant2']);
    expect(page.total).toBe(4);
    expect(rowStatement(statements)).toMatch(/limit \$\d+$/i);
  });

  it('reads API keys through a SQL limit/offset and leaves revoked keys out by default', async () => {
    const user = await harness.seedUser();
    await harness.db.insert(schema.apiKeys).values([
      { userId: user.id, name: 'live-a', tokenHash: 'h-a', scopes: ['portfolio:read'] },
      { userId: user.id, name: 'live-b', tokenHash: 'h-b', scopes: ['portfolio:read'] },
      {
        userId: user.id,
        name: 'retired',
        tokenHash: 'h-c',
        scopes: ['portfolio:read'],
        revokedAt: new Date(),
      },
    ]);
    const { db, statements } = recordingDb(harness.db);
    const repo = createApiKeyRepository(db);

    const live = await repo.listPageForAdmin({ limit: 10, offset: 0, includeRevoked: false });
    expect(live.rows.map((row) => row.name).sort()).toEqual(['live-a', 'live-b']);
    // The total counts the same filtered set — an operator paging a list of two
    // must not be told there are three.
    expect(live.total).toBe(2);
    expect(rowStatement(statements)).toMatch(/limit \$\d+$/i);

    const all = await repo.listPageForAdmin({ limit: 10, offset: 0, includeRevoked: true });
    expect(all.rows).toHaveLength(3);
    expect(all.total).toBe(3);

    const firstPage = await repo.listPageForAdmin({ limit: 1, offset: 0, includeRevoked: true });
    expect(firstPage.rows).toHaveLength(1);
  });
});
