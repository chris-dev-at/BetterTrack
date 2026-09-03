import { eq, inArray } from 'drizzle-orm';
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
 * deleted asset on screen. Monotonicity alone does not fix that: a stamp that
 * is already ahead (because some newer asset — anyone's — was deleted first)
 * would absorb the next deletion silently, and the false 304 comes back
 * verbatim. So these tests pin the stronger property the trigger implements:
 * every deleting statement STEPS the watermark forward, by a whole HTTP-date
 * second, whichever row it removed.
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

/**
 * The comparison the conditional middleware actually performs: `Last-Modified`
 * and `If-Modified-Since` are second-granular, so a strictly larger millisecond
 * value proves nothing — only a LATER SECOND makes the client that echoes the
 * previous date back get a 200 instead of a 304.
 */
function expectLaterSecond(after: Date | null, before: Date | null) {
  expect(after).not.toBeNull();
  expect(before).not.toBeNull();
  expect(Math.floor(after!.getTime() / 1000)).toBeGreaterThan(Math.floor(before!.getTime() / 1000));
}

describe('assetRepository.catalogWatermark — steps forward on deletion', () => {
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
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    expectLaterSecond(after, before);
  });

  it('steps forward again for a deletion that lands below an already-advanced stamp', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'wm2@s.test', username: 'wm2' });

    await seedAsset(h, 'GLOBAL2');
    const older = await seedAsset(h, 'MYHOUSE', user.id);
    const newer = await seedAsset(h, 'MYBOAT', user.id);

    // Deletion 1 puts the stamp ahead of everything that is left…
    await h.db.delete(schema.assets).where(eq(schema.assets.id, newer));
    const afterFirst = await repo.catalogWatermark(user.id);

    // …so deletion 2 removes the newest row the caller can still see while its
    // OWN instant is BELOW the stamp. A `greatest(stamp, deleted row)` write is
    // a no-op here — the watermark would stand still and the client's
    // `If-Modified-Since` from step 1 would still be satisfied, with MYHOUSE
    // rendered and gone. It has to step.
    await h.db.delete(schema.assets).where(eq(schema.assets.id, older));
    const afterSecond = await repo.catalogWatermark(user.id);

    expectLaterSecond(afterSecond, afterFirst);
  });

  it('steps forward for a deletion that does not touch the newest visible row', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'wm3@s.test', username: 'wm3' });

    const older = await seedAsset(h, 'MYHOUSE', user.id);
    await seedAsset(h, 'MYBOAT', user.id);

    const before = await repo.catalogWatermark(user.id);
    // `max(newest visible)` is unchanged by removing anything below it, so the
    // response shrinks by one row while the naive watermark stands still.
    await h.db.delete(schema.assets).where(eq(schema.assets.id, older));

    expectLaterSecond(await repo.catalogWatermark(user.id), before);
  });

  it('is not silenced by another account having deleted a newer asset first (§10)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const mine = await h.seedUser({ email: 'wm4@s.test', username: 'wm4' });
    const theirs = await h.seedUser({ email: 'wm5@s.test', username: 'wm5' });

    const myCustom = await seedAsset(h, 'MYHOUSE', mine.id);
    const mineOnly = await repo.catalogWatermark(mine.id);
    // Newer than everything of mine, and invisible to me — so creating it
    // cannot move my watermark (§10: the read is visibility-scoped).
    const theirCustom = await seedAsset(h, 'THEIRHOUSE', theirs.id);
    expect((await repo.catalogWatermark(mine.id))!.getTime()).toBe(mineOnly!.getTime());

    // The stamp is instance-wide, so THEIR deletion is what puts it ahead of my
    // rows — the state any second user finds the instance in.
    await h.db.delete(schema.assets).where(eq(schema.assets.id, theirCustom));
    const afterTheirs = await repo.catalogWatermark(mine.id);

    await h.db.delete(schema.assets).where(eq(schema.assets.id, myCustom));
    expectLaterSecond(await repo.catalogWatermark(mine.id), afterTheirs);
  });

  it('never rewinds when a much older row is deleted last', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'wm6@s.test', username: 'wm6' });

    const first = await seedAsset(h, 'MYBOAT', user.id);
    await h.db.delete(schema.assets).where(eq(schema.assets.id, first));
    const afterDelete = await repo.catalogWatermark(user.id);

    // This id was minted (UUIDv7 timestamp bits) long before every other row in
    // the fixture; deleting it may only push the watermark forward.
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

    expectLaterSecond(await repo.catalogWatermark(user.id), afterDelete);
  });

  it('stamps a multi-row delete once, and a matchless delete not at all', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'wm7@s.test', username: 'wm7' });

    const ids = [
      await seedAsset(h, 'MYHOUSE', user.id),
      await seedAsset(h, 'MYBOAT', user.id),
      await seedAsset(h, 'MYCAR', user.id),
    ];
    const before = await repo.catalogWatermark(user.id);

    // One statement, three rows — an account cascade or a paranoid purge. The
    // trigger is statement-level, so this costs ONE second of watermark (and
    // one lock on the shared row), not one per row.
    await h.db.delete(schema.assets).where(inArray(schema.assets.id, ids));
    const afterBulk = await repo.catalogWatermark(user.id);
    expectLaterSecond(afterBulk, before);
    expect(afterBulk!.getTime() - Math.floor(before!.getTime() / 1000) * 1000).toBeLessThanOrEqual(
      1000,
    );

    // A DELETE that matched nothing still fires the statement trigger; it must
    // not invalidate every client's cached catalog.
    await h.db.delete(schema.assets).where(eq(schema.assets.id, ids[0]!));
    expect((await repo.catalogWatermark(user.id))!.getTime()).toBe(afterBulk!.getTime());
  });

  it('stamps the account-deletion cascade, which never issues its own DELETE on assets', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const watcher = await h.seedUser({ email: 'wm8@s.test', username: 'wm8' });
    const leaving = await h.seedUser({ email: 'wm9@s.test', username: 'wm9' });

    await seedAsset(h, 'GLOBAL3');
    await seedAsset(h, 'THEIRHOUSE', leaving.id);
    const before = await repo.catalogWatermark(watcher.id);

    // `assets.owner_id` is ON DELETE CASCADE, so the custom asset disappears
    // without any repository issuing a DELETE on `assets` — the trigger is the
    // only thing that can see it.
    await h.db.delete(schema.users).where(eq(schema.users.id, leaving.id));

    expectLaterSecond(await repo.catalogWatermark(watcher.id), before);
  });
});
