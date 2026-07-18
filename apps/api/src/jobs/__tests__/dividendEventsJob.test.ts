import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AssetRef, DividendEvents } from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import type { HeldAssetHolderRow } from '../../data/repositories/marketIntelRepository';
import { createNotificationRepository } from '../../data/repositories/notificationRepository';
import { notifications } from '../../data/schema';
import { createNotificationCenter } from '../../services/notifications/notificationCenter';
import { createStubMarketData, cachedIntel } from '../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { dividendNotifyGate, runDividendEventsScan } from '../definitions/dividendEventsJob';

const NOW = Date.parse('2026-07-18T00:00:00.000Z');

let harness: TestHarness;
let db: Database;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
});

afterEach(async () => {
  await harness.ctx.events.close();
});

function dividends(upcoming: DividendEvents['upcoming']): DividendEvents {
  return {
    currency: 'USD',
    history: [],
    upcoming,
    forwardYield: null,
    trailingAmount: null,
  };
}

/** A market-data stub serving one asset's upcoming dividends. */
function marketDataWith(upcoming: DividendEvents['upcoming']) {
  return createStubMarketData({ dividends: (_ref: AssetRef) => cachedIntel(dividends(upcoming)) });
}

function holder(userId: string, overrides: Partial<HeldAssetHolderRow> = {}): HeldAssetHolderRow {
  return {
    userId,
    assetId: 'asset-a',
    providerId: 'yahoo',
    providerRef: 'AAA',
    symbol: 'AAA',
    name: 'Asset A',
    currency: 'USD',
    ...overrides,
  };
}

/** Turn the opt-in `dividend.event` type ON in-app for a user. */
async function optIn(userId: string) {
  await createNotificationRepository(db).upsertChannelConfig(userId, 'inapp', {
    'dividend.event': true,
  });
}

async function dividendRows(userId: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => r.type === 'dividend.event' && !r.hidden);
}

/** Build the scan deps around the harness's real dispatcher. */
function scanDeps(opts: {
  holders: HeldAssetHolderRow[];
  upcoming: DividendEvents['upcoming'];
  enabled?: boolean;
}) {
  const repo = createNotificationRepository(db);
  return {
    repo: {
      listHeldAssetHoldersAllUsers: async () => opts.holders,
    },
    marketData: marketDataWith(opts.upcoming),
    notify: createNotificationCenter({
      enqueue: (event) => harness.ctx.notificationDispatcher.dispatch(event),
    }),
    isEnabled: dividendNotifyGate(repo),
    enabled: opts.enabled ?? true,
    now: () => NOW,
  };
}

describe('marketIntel.dividendScan (V5-P5)', () => {
  it('fires exactly once per user+asset+ex-date across repeated runs (clock-mocked idempotency)', async () => {
    const user = await harness.seedUser({ email: 'holder@bt.test', username: 'holder' });
    await optIn(user.id);
    const deps = scanDeps({
      holders: [holder(user.id)],
      // Ex-date 3 days out — inside the 7-day horizon.
      upcoming: [
        { exDate: '2026-07-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });

    const first = await runDividendEventsScan(deps);
    const second = await runDividendEventsScan(deps);

    // Both runs emit (the job does not dedupe), but the dispatcher's
    // (recipient, asset, ex-date) key collapses them to ONE visible row.
    expect(first.emitted).toBe(1);
    expect(second.emitted).toBe(1);
    const rows = await dividendRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('AAA');
  });

  it('does not fire for a user who never opted in (default off)', async () => {
    const user = await harness.seedUser({ email: 'optout@bt.test', username: 'optout' });
    // No optIn() — the type is off on every channel.
    const deps = scanDeps({
      holders: [holder(user.id)],
      upcoming: [
        { exDate: '2026-07-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });

    const result = await runDividendEventsScan(deps);
    expect(result.emitted).toBe(0);
    expect(await dividendRows(user.id)).toHaveLength(0);
  });

  it('does not fire for an ex-date beyond the horizon', async () => {
    const user = await harness.seedUser({ email: 'far@bt.test', username: 'far' });
    await optIn(user.id);
    const deps = scanDeps({
      holders: [holder(user.id)],
      // 30 days out — beyond the 7-day horizon.
      upcoming: [
        { exDate: '2026-08-17T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });

    const result = await runDividendEventsScan(deps);
    expect(result.emitted).toBe(0);
    expect(await dividendRows(user.id)).toHaveLength(0);
  });

  it('is a no-op when MARKET_INTEL is disabled', async () => {
    const user = await harness.seedUser({ email: 'gated@bt.test', username: 'gated' });
    await optIn(user.id);
    const deps = scanDeps({
      holders: [holder(user.id)],
      upcoming: [
        { exDate: '2026-07-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
      enabled: false,
    });

    const result = await runDividendEventsScan(deps);
    expect(result).toEqual({ assetsScanned: 0, emitted: 0 });
    expect(await dividendRows(user.id)).toHaveLength(0);
  });
});
