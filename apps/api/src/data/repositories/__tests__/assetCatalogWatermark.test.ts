import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../assetRepository';
import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';

/**
 * The conditional catalog read's freshness watermark (§6.2, §6.13, #1709).
 *
 * It is derived from the newest visible asset's UUIDv7 creation time, which on
 * its own moves BACKWARDS when that row is deleted — and a watermark that
 * decreases turns the next `If-Modified-Since` into a false `304`, leaving a
 * deleted asset on screen. These tests pin the monotonicity, and the one-second
 * step that HTTP-date resolution requires for it to actually matter.
 */

async function seedAsset(h: TestHarness, symbol: string, ownerId: string | null = null) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: ownerId ? 'manual' : 'yahoo',
      providerRef: symbol,
      ownerId,
      type: ownerId ? 'custom' : 'stock',
      symbol,
      name: `${symbol} Corp`,
      currency: 'EUR',
    })
    .returning();
  return row!.id;
}

describe('assetRepository.catalogWatermark — monotonic under deletion', () => {
  it('moves forward, not backward, when the newest visible asset is deleted', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'wm@s.test', username: 'wm' });

    await seedAsset(h, 'GLOBAL1');
    const customId = await seedAsset(h, 'MYHOUSE', user.id);

    const before = await repo.catalogWatermark(user.id);
    expect(before).not.toBeNull();

    await h.db.delete(schema.assets).where(eq(schema.assets.id, customId));

    const after = await repo.catalogWatermark(user.id);
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    // `Last-Modified` / `If-Modified-Since` are second-granular, so a strictly
    // larger millisecond value is not enough: the floored comparison the
    // middleware performs must see a LATER SECOND, or the client that echoes
    // the pre-deletion date back still gets a 304.
    expect(Math.floor(after!.getTime() / 1000)).toBeGreaterThan(
      Math.floor(before!.getTime() / 1000),
    );
  });

  it('keeps the deletion stamp after the row that produced it is gone, and never rewinds it', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'wm2@s.test', username: 'wm2' });

    const first = await seedAsset(h, 'MYBOAT', user.id);
    await h.db.delete(schema.assets).where(eq(schema.assets.id, first));
    const afterDelete = await repo.catalogWatermark(user.id);

    // A LATER deletion of an OLDER row must not pull the watermark back down:
    // the stamp only ever moves forward. This id was minted (UUIDv7 timestamp
    // bits) long before every other row in the fixture.
    const ancient = '018f6f00-0000-7000-8000-0000000000ff';
    await h.db.insert(schema.assets).values({
      id: ancient,
      providerId: 'manual',
      providerRef: 'MYCAR',
      ownerId: user.id,
      type: 'custom',
      symbol: 'MYCAR',
      name: 'MYCAR Corp',
      currency: 'EUR',
    });
    await h.db.delete(schema.assets).where(eq(schema.assets.id, ancient));

    const afterOlderDelete = await repo.catalogWatermark(user.id);
    expect(afterOlderDelete!.getTime()).toBe(afterDelete!.getTime());
  });

  it('is unaffected by another user’s custom asset, deleted or not (§10)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const mine = await h.seedUser({ email: 'wm3@s.test', username: 'wm3' });
    const theirs = await h.seedUser({ email: 'wm4@s.test', username: 'wm4' });

    await seedAsset(h, 'GLOBAL2');
    const mineWatermark = await repo.catalogWatermark(mine.id);

    // Invisible to me, so creating it cannot move my watermark…
    const hidden = await seedAsset(h, 'THEIRHOUSE', theirs.id);
    expect((await repo.catalogWatermark(mine.id))!.getTime()).toBe(mineWatermark!.getTime());

    // …while deleting it may only push it forward (over-invalidation, the safe
    // direction), never backwards.
    await h.db.delete(schema.assets).where(eq(schema.assets.id, hidden));
    expect((await repo.catalogWatermark(mine.id))!.getTime()).toBeGreaterThanOrEqual(
      mineWatermark!.getTime(),
    );
  });
});
