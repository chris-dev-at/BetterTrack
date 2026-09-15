import type { AssetRef } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  cachedIntel,
  createStubMarketData,
  sampleEarningsEvents,
} from '../../../testing/marketDataStubs';
import type { DispatchableEvent } from '../../../services/notifications/notificationDispatcher';
import { runEarningsReminderScan } from '../../../services/marketIntel/earningsReminder';
import { createMarketIntelRepository } from '../marketIntelRepository';

/**
 * The earnings-reminder scan's FIRST pass reads watchlist rows directly
 * (`listAllWatchAssets`) instead of discovering recipients through
 * `listNormalUserIds`, so it never applied that method's recipient predicate.
 * An admin disabling an account kills its sessions and bearer credentials
 * instantly (§6.12) — and every morning the scan still read its watchlist and
 * mailed or pushed it a reminder, indefinitely: nothing downstream re-checks
 * account status (`notificationCenter.emit` only enqueues).
 */

// Deterministic TEST VECTOR identities — public fixtures, not credentials.
const VECTOR = {
  activeId: '019c8700-0000-7000-8000-000000000001',
  disabledId: '019c8700-0000-7000-8000-000000000002',
  paranoidId: '019c8700-0000-7000-8000-000000000003',
  adminId: '019c8700-0000-7000-8000-000000000004',
  assetId: '019c8700-0000-7000-8000-000000000010',
} as const;

/** A clock the fixture's report date sits just ahead of. */
const NOW = Date.parse('2026-07-18T09:00:00.000Z');
const REPORT_DATE = new Date(NOW + 86_400_000).toISOString();

let h: TestHarness;
let redis: Redis;

async function watch(userId: string, name: string) {
  const [watchlist] = await h.db
    .insert(schema.watchlists)
    .values({ userId, name, isDefault: true })
    .returning({ id: schema.watchlists.id });
  await h.db.insert(schema.workboardItems).values({
    userId,
    watchlistId: watchlist!.id,
    assetId: VECTOR.assetId,
    sortOrder: 0,
  });
}

beforeEach(async () => {
  h = await createTestApp();
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();

  await h.db.insert(schema.users).values([
    {
      id: VECTOR.activeId,
      email: 'intel-active@bettertrack.test',
      username: 'intel_active',
      passwordHash: 'TEST VECTOR password hash',
    },
    {
      id: VECTOR.disabledId,
      email: 'intel-disabled@bettertrack.test',
      username: 'intel_disabled',
      passwordHash: 'TEST VECTOR password hash',
      status: 'disabled',
    },
    {
      id: VECTOR.paranoidId,
      email: 'intel-paranoid@bettertrack.test',
      username: 'intel_paranoid',
      passwordHash: 'TEST VECTOR password hash',
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
    },
    {
      id: VECTOR.adminId,
      email: 'intel-admin@bettertrack.test',
      username: 'intel_admin',
      passwordHash: 'TEST VECTOR password hash',
      role: 'admin',
    },
  ]);

  await h.db.insert(schema.assets).values({
    id: VECTOR.assetId,
    providerId: 'yahoo',
    providerRef: 'INTEL-GLOBAL',
    type: 'stock',
    symbol: 'GLB',
    name: 'TEST VECTOR global asset',
    currency: 'EUR',
  });

  await watch(VECTOR.activeId, 'Active list');
  await watch(VECTOR.disabledId, 'Disabled list');
  await watch(VECTOR.paranoidId, 'Paranoid list');
  await watch(VECTOR.adminId, 'Admin list');
});

afterEach(async () => {
  await h.dispose();
});

describe('earnings-reminder recipients: the watchlist pass filters on account status', () => {
  it('yields only the active, non-paranoid, role=user account', async () => {
    const repo = createMarketIntelRepository(h.db);

    const rows = await repo.listAllWatchAssets();

    expect(rows.map((row) => row.userId)).toEqual([VECTOR.activeId]);
    // The predicate is exactly the one the rest of the lane already applies.
    expect(await repo.listNormalUserIds()).toEqual([VECTOR.activeId]);
  });

  it('sends no reminder to a disabled account holding a watchlist row', async () => {
    const repo = createMarketIntelRepository(h.db);
    const emits: DispatchableEvent[] = [];

    const result = await runEarningsReminderScan({
      intelRepo: repo,
      marketData: createStubMarketData({
        earnings: (_ref: AssetRef) =>
          cachedIntel(
            sampleEarningsEvents({
              next: {
                date: REPORT_DATE,
                periodEnd: null,
                epsEstimate: 1.4,
                epsActual: null,
                estimated: true,
              },
            }),
          ),
      }),
      redis,
      notify: {
        emit: async (event) => {
          emits.push(event);
          return true;
        },
      },
      isEnabled: async () => true,
      enabled: true,
      runIfAllowed: async (_userId, action) => {
        await action();
        return true;
      },
      now: () => NOW,
    });

    expect(result.reminded).toBe(1);
    expect(emits.map((event) => event.userId)).toEqual([VECTOR.activeId]);
  });
});
