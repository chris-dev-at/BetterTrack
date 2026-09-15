import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../assetRepository';
import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';

/**
 * The other half of the catalog watermark (§6.2, §6.13, #1762) — the writes that
 * are NOT deletions. `assetCatalogWatermark.test.ts` pins the deletion side.
 *
 * "Newest visible id" is blind to both of them. An UPDATE keeps the row's id, so
 * a rename — the field search returns AND ranks on — moves nothing at all. An
 * INSERT does move it, but only by milliseconds, and `Last-Modified` /
 * `If-Modified-Since` carry whole seconds: a row created later in the same
 * second as the current watermark is delivered as a `304`. Both leave a client
 * on the date-validator rail (a bare API-key/CLI caller, or an intermediary that
 * strips ETags) holding a stale catalog with nothing to repair it.
 *
 * So these tests pin the same property the deletion trigger has: every
 * content-changing statement STEPS the watermark forward by a whole HTTP-date
 * second, and a statement that changed nothing does not.
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

describe('assetRepository.catalogWatermark — steps forward on every catalog write', () => {
  it('steps forward when a custom asset is renamed', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'cw1@s.test', username: 'cw1' });

    const id = await seedAsset(h, 'MYHOUSE', user.id);
    const before = await repo.catalogWatermark(user.id);

    // The id is unchanged, so `max(newest visible id)` cannot see this — and
    // `name` is exactly what `searchCatalog` returns and ranks on.
    await h.db
      .update(schema.assets)
      .set({ name: 'Zeta Immobilien' })
      .where(eq(schema.assets.id, id));

    expectLaterSecond(await repo.catalogWatermark(user.id), before);
  });

  it('steps forward for an update of a row far below the newest visible one', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'cw2@s.test', username: 'cw2' });

    // Minted (UUIDv7 timestamp bits) long before every other row in the
    // fixture, and with a newer row seeded after it, so neither the touched
    // row's own instant nor the visible maximum moves. Only the stamp can.
    const ancient = '018f6f00-0000-7000-8000-0000000000ab';
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
    await seedAsset(h, 'MYBOAT', user.id);
    const before = await repo.catalogWatermark(user.id);

    await h.db.update(schema.assets).set({ symbol: 'MYVAN' }).where(eq(schema.assets.id, ancient));

    expectLaterSecond(await repo.catalogWatermark(user.id), before);
  });

  it('stamps a multi-row update once, and a matchless update not at all', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'cw3@s.test', username: 'cw3' });

    const ids = [
      await seedAsset(h, 'MYHOUSE', user.id),
      await seedAsset(h, 'MYBOAT', user.id),
      await seedAsset(h, 'MYCAR', user.id),
    ];
    const before = await repo.catalogWatermark(user.id);

    // One statement, three rows — the re-categorize sweep. Statement-level, so
    // it costs ONE second of watermark (and one lock on the shared row).
    await h.db
      .update(schema.assets)
      .set({ meta: sql`'{"recategorize": true}'::jsonb` })
      .where(inArray(schema.assets.id, ids));
    const afterBulk = await repo.catalogWatermark(user.id);
    expectLaterSecond(afterBulk, before);
    expect(afterBulk!.getTime() - Math.floor(before!.getTime() / 1000) * 1000).toBeLessThanOrEqual(
      1000,
    );

    // An UPDATE that matched nothing still fires the statement trigger; it must
    // not invalidate every client's cached catalog.
    await h.db
      .update(schema.assets)
      .set({ name: 'unreachable' })
      .where(eq(schema.assets.id, '018f6f00-0000-7000-8000-0000000000cc'));
    expect((await repo.catalogWatermark(user.id))!.getTime()).toBe(afterBulk!.getTime());
  });

  it('steps forward for an insert that lands inside the current watermark second', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'cw4@s.test', username: 'cw4' });

    // Two crafted UUIDv7 ids 256 ms apart INSIDE one second (the leading 48 bits
    // are the creation ms, §4.4), newer than every seeded row so they are what
    // the "newest visible id" term reads. A second-granular validator cannot
    // separate them: without the insert-side compensation the client that
    // revalidates after the first insert is told 304 and never sees the second —
    // the §6.2 "Searching providers…" refetch loop.
    const insert = (id: string, symbol: string) =>
      h.db.insert(schema.assets).values({
        id,
        providerId: 'yahoo',
        providerRef: symbol,
        ownerId: null,
        type: 'stock',
        symbol,
        name: `${symbol} Corp`,
        currency: 'EUR',
      });

    await insert('01b80000-0100-7000-8000-0000000000a1', 'SAMESECA');
    const before = await repo.catalogWatermark(user.id);
    await insert('01b80000-0200-7000-8000-0000000000a2', 'SAMESECB');

    expectLaterSecond(await repo.catalogWatermark(user.id), before);
  });
});
