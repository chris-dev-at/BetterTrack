import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  createAssetRepository,
  REFRESHABLE_ASSET_FIELDS,
  type GlobalAssetUpsert,
} from '../assetRepository';
import * as schema from '../../schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';

/**
 * `assetRepository.upsertGlobalMany` — the batched sibling of `upsertGlobal`
 * that the boot catalog seed rides (§6.2(c)). The batch collapses two
 * statements per entry into one multi-row `INSERT ... ON CONFLICT DO UPDATE`
 * per chunk, and every guarantee the single-row path states must survive the
 * collapse: exact created/refreshed accounting off `RETURNING (xmax = 0)`,
 * in-place correction (same id), the `IS DISTINCT FROM` no-write guard for
 * unchanged rows, and the §10 boundary that a global refresh can never reach a
 * user's custom asset. `catalogSeedData.test.ts` covers the shipped list
 * end-to-end (including the watermark staying put on a no-op re-seed); this
 * file pins the repository method's own edges — mixed batches, the chunk
 * boundary, NULL columns through EXCLUDED, and the up-front input guards.
 */

const entry = (providerRef: string, over: Partial<GlobalAssetUpsert> = {}): GlobalAssetUpsert => ({
  providerId: 'yahoo',
  providerRef,
  type: 'stock',
  symbol: providerRef,
  name: `${providerRef} Corp`,
  exchange: null,
  currency: 'EUR',
  ...over,
});

const refresh = { refresh: REFRESHABLE_ASSET_FIELDS };

describe('assetRepository.upsertGlobalMany', () => {
  it('creates, corrects and skips in one statement, correcting in place', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);

    const first = await repo.upsertGlobalMany(
      [entry('BAT-A'), entry('BAT-B', { exchange: 'XETRA' }), entry('BAT-C')],
      refresh,
    );
    expect(first).toEqual({ created: 3, refreshed: 0 });
    const idBefore = (await repo.findGlobal('yahoo', 'BAT-B'))!.id;

    // One statement, all three outcomes: BAT-A unchanged (must not be written,
    // so it is not even returned), BAT-B stale on two columns including the
    // NULL-valued `exchange` (IS DISTINCT FROM must see NULL vs 'XETRA' as a
    // change — `!=` would not), BAT-D new. `xmax = 0` separates the insert from
    // the correction inside the same statement.
    const second = await repo.upsertGlobalMany(
      [entry('BAT-A'), entry('BAT-B', { name: 'Batch B AG', exchange: null }), entry('BAT-D')],
      refresh,
    );
    expect(second).toEqual({ created: 1, refreshed: 1 });

    // The correction is an in-place edit, never a re-identify: transactions,
    // holdings and watchlists point at `id`.
    const corrected = await repo.findGlobal('yahoo', 'BAT-B');
    expect(corrected).toMatchObject({ id: idBefore, name: 'Batch B AG', exchange: null });
    const untouched = await repo.findGlobal('yahoo', 'BAT-A');
    expect(untouched).toMatchObject({ name: 'BAT-A Corp' });
  });

  it('keeps exact accounting across the 200-row chunk boundary', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);

    // 210 entries span two statements (200 + 10). The drifted row sits at index
    // 205 — in the SECOND chunk — so the tally provably survives chunking and
    // is not an artifact of everything fitting into one statement.
    const entries = Array.from({ length: 210 }, (_, i) =>
      entry(`CHUNK-${String(i).padStart(3, '0')}`),
    );
    expect(await repo.upsertGlobalMany(entries, refresh)).toEqual({ created: 210, refreshed: 0 });

    await h.db
      .update(schema.assets)
      .set({ name: 'Drifted Corp', exchange: 'DRIFT' })
      .where(eq(schema.assets.providerRef, 'CHUNK-205'));

    expect(await repo.upsertGlobalMany(entries, refresh)).toEqual({ created: 0, refreshed: 1 });
    expect(await repo.findGlobal('yahoo', 'CHUNK-205')).toMatchObject({
      name: 'CHUNK-205 Corp',
      exchange: null, // NULL written back through EXCLUDED, not just detected
    });
    const rows = await h.db.select({ id: schema.assets.id }).from(schema.assets);
    expect(rows).toHaveLength(210);
  });

  it('never reaches a custom asset that shares the provider ref (§10)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'bat1@s.test', username: 'bat1' });

    // Same (provider_id, provider_ref) as the incoming global entry, but owned.
    // The conflict arbiter is the partial index over `owner_id IS NULL`, so
    // this row can neither block the global insert nor be its update target.
    await h.db.insert(schema.assets).values({
      providerId: 'yahoo',
      providerRef: 'BAT-OWNED',
      ownerId: user.id,
      type: 'custom',
      symbol: 'BAT-OWNED',
      name: 'My Private Tracker',
      currency: 'EUR',
    });

    expect(await repo.upsertGlobalMany([entry('BAT-OWNED')], refresh)).toEqual({
      created: 1,
      refreshed: 0,
    });
    expect(
      await repo.upsertGlobalMany([entry('BAT-OWNED', { name: 'Corrected Corp' })], refresh),
    ).toEqual({ created: 0, refreshed: 1 });

    // The correction landed on the global row alone.
    const owned = await h.db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.providerRef, 'BAT-OWNED'), eq(schema.assets.ownerId, user.id)));
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ name: 'My Private Tracker', type: 'custom' });
    const global = await h.db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.providerRef, 'BAT-OWNED'), isNull(schema.assets.ownerId)));
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ name: 'Corrected Corp' });
  });

  it('refuses bad input up front, before any write', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);

    // A duplicate ref inside one statement is a hard Postgres error ("cannot
    // affect row a second time") and one straddling a chunk boundary would
    // silently double-count instead — so the guard rejects the whole input,
    // with nothing written.
    await expect(
      repo.upsertGlobalMany([entry('BAT-DUP'), entry('BAT-X'), entry('BAT-DUP')], refresh),
    ).rejects.toThrow(/\(yahoo, BAT-DUP\) twice/);

    // An empty refresh set would be `DO UPDATE SET` with no columns — refused,
    // not degraded: the one caller is the curated seed, which refreshes all.
    await expect(repo.upsertGlobalMany([entry('BAT-X')], { refresh: [] })).rejects.toThrow(
      /non-empty refresh/,
    );

    expect(await h.db.select({ id: schema.assets.id }).from(schema.assets)).toHaveLength(0);

    // And the degenerate-but-legal input: no entries, no statements, no counts.
    expect(await repo.upsertGlobalMany([], refresh)).toEqual({ created: 0, refreshed: 0 });
  });
});
