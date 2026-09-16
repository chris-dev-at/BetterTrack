import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createUsageCaptureMiddleware } from '../usageCapture';
import type { UsageAnalyticsRepository } from '../../../data/repositories/usageAnalyticsRepository';
import {
  createUsageAnalyticsService,
  type UsageSignal,
} from '../../../services/analytics/usageAnalyticsService';

/**
 * The REQUEST-TIME fence of the usage-capture middleware (#1952, follow-up to
 * the #1905 review; PROJECTPLAN.md §13.5 V5-P13 / §10).
 *
 * Two independent suppressions decide whether an authenticated request is
 * buffered at all, and until this file they were ordered the wrong way round:
 *
 *  - the CUSTODY-SEGMENT fence — the request names an id under `/assets` or
 *    `/custom-assets`, which carries no portfolio attribution that could be
 *    checked, so for an account owning ANY vault the whole signal is dropped;
 *  - the TARGET fence — the request attributes itself to one portfolio, which
 *    is dropped only when that portfolio is itself vaulted.
 *
 * `vaultedPortfolioTargetForRequest` reads the RAW query, so a caller could
 * attach `?portfolioId=<a plain portfolio of their own>` to a custody route and
 * reach the target branch first. It answered "that portfolio is not vaulted" →
 * not suppressed, and the request was buffered IN MEMORY carrying the private
 * custom-asset uuid, relying on `usageAnalyticsRepository.upsertEvents` to drop
 * it at the write boundary. No row ever reached `usage_events` — but the
 * guarantee rested on one unpinned line at the LAST fence instead of the first.
 *
 * The custody check now runs first (fail closed at the first fence), and the
 * table below pins the whole decision space so the order cannot drift back.
 */

const PLAIN_PORTFOLIO = '018f0000-0000-7000-8000-0000000019a1';
const VAULTED_PORTFOLIO = '018f0000-0000-7000-8000-0000000019a2';
const CATALOG_ASSET = '018f0000-0000-7000-8000-0000000019a3';
const PRIVATE_CUSTOM_ASSET = '018f0000-0000-7000-8000-0000000019a4';

/** What one request is expected to fold into the buffer (`null` = nothing). */
interface Recorded {
  readonly feature: string;
  readonly assetId: string | null;
  readonly targetPortfolioId: string | null;
  readonly suppressIfAnyVault: boolean;
}

interface Shape {
  readonly method: 'GET' | 'DELETE';
  readonly path: string;
  /** The recorded signal for an account that owns NO vault. */
  readonly plain: Recorded | null;
  /** The recorded signal for an account that owns a vault. */
  readonly vaultOwner: Recorded | null;
  /**
   * Set where this fix changed the vault owner's outcome. Every such cell was
   * BUFFERED with the private id before the reorder and is suppressed now; the
   * end-to-end result is unchanged (the repository already dropped them), the
   * fence that produces it is not.
   */
  readonly movedByTheFence?: true;
}

const portfolioSignal = (targetPortfolioId: string | null): Recorded => ({
  feature: 'portfolio',
  assetId: null,
  targetPortfolioId,
  suppressIfAnyVault: false,
});

const assetSignal = (assetId: string | null, targetPortfolioId: string | null): Recorded => ({
  feature: 'assets',
  assetId,
  targetPortfolioId,
  suppressIfAnyVault: true,
});

/**
 * The 16-shape battery of the #1905 review: eight request shapes spanning both
 * fences and the surfaces neither covers, each issued twice — bare, and with
 * `?portfolioId=<plain portfolio>` attached. The `plain` column is the
 * behaviour of `main` BEFORE this change, captured by running this same battery
 * against the unreordered middleware; it must not move, because a non-vaulted
 * account answers `false` at both fences whichever runs first.
 */
const BATTERY: readonly Shape[] = [
  // 1. Collection root — no id, no attribution. Neither fence applies.
  {
    method: 'GET',
    path: '/api/v1/portfolios',
    plain: portfolioSignal(null),
    vaultOwner: portfolioSignal(null),
  },
  {
    method: 'GET',
    path: `/api/v1/portfolios?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: portfolioSignal(PLAIN_PORTFOLIO),
    vaultOwner: portfolioSignal(PLAIN_PORTFOLIO),
  },
  // 2. A plain portfolio by path — the target fence says "not vaulted".
  {
    method: 'GET',
    path: `/api/v1/portfolios/${PLAIN_PORTFOLIO}`,
    plain: portfolioSignal(PLAIN_PORTFOLIO),
    vaultOwner: portfolioSignal(PLAIN_PORTFOLIO),
  },
  {
    method: 'GET',
    path: `/api/v1/portfolios/${PLAIN_PORTFOLIO}?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: portfolioSignal(PLAIN_PORTFOLIO),
    vaultOwner: portfolioSignal(PLAIN_PORTFOLIO),
  },
  // 3. A VAULTED portfolio by path — the target fence is the only one that can
  //    suppress this, and it still does. The query cannot talk it out of it:
  //    the path branch resolves before any query candidate.
  {
    method: 'GET',
    path: `/api/v1/portfolios/${VAULTED_PORTFOLIO}`,
    plain: portfolioSignal(VAULTED_PORTFOLIO),
    vaultOwner: null,
  },
  {
    method: 'GET',
    path: `/api/v1/portfolios/${VAULTED_PORTFOLIO}?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: portfolioSignal(VAULTED_PORTFOLIO),
    vaultOwner: null,
  },
  // 4. A catalog quote — a custody route. The unattributed shape was already
  //    suppressed; the attributed one is the bypass.
  {
    method: 'GET',
    path: `/api/v1/assets/${CATALOG_ASSET}/quote`,
    plain: assetSignal(CATALOG_ASSET, null),
    vaultOwner: null,
  },
  {
    method: 'GET',
    path: `/api/v1/assets/${CATALOG_ASSET}/quote?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: assetSignal(CATALOG_ASSET, PLAIN_PORTFOLIO),
    vaultOwner: null,
    movedByTheFence: true,
  },
  // 5. The batch read — custody route with no `:id` param of its own, so the
  //    ids travel in the query string and are never recorded either way.
  {
    method: 'GET',
    path: '/api/v1/assets/quotes',
    plain: assetSignal(null, null),
    vaultOwner: null,
  },
  {
    method: 'GET',
    path: `/api/v1/assets/quotes?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: assetSignal(null, PLAIN_PORTFOLIO),
    vaultOwner: null,
    movedByTheFence: true,
  },
  // 6. The custom-asset collection root — names no existing asset, so it is not
  //    a custody route and stays countable for a vault owner too.
  {
    method: 'GET',
    path: '/api/v1/custom-assets',
    plain: { feature: 'assets', assetId: null, targetPortfolioId: null, suppressIfAnyVault: false },
    vaultOwner: {
      feature: 'assets',
      assetId: null,
      targetPortfolioId: null,
      suppressIfAnyVault: false,
    },
  },
  {
    method: 'GET',
    path: `/api/v1/custom-assets?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: {
      feature: 'assets',
      assetId: null,
      targetPortfolioId: PLAIN_PORTFOLIO,
      suppressIfAnyVault: false,
    },
    vaultOwner: {
      feature: 'assets',
      assetId: null,
      targetPortfolioId: PLAIN_PORTFOLIO,
      suppressIfAnyVault: false,
    },
  },
  // 7. THE shape from the issue: a private custom-asset uuid on a custody route,
  //    attributed to a plain portfolio by query.
  {
    method: 'GET',
    path: `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}/value-points`,
    plain: assetSignal(PRIVATE_CUSTOM_ASSET, null),
    vaultOwner: null,
  },
  {
    method: 'GET',
    path: `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}/value-points?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: assetSignal(PRIVATE_CUSTOM_ASSET, PLAIN_PORTFOLIO),
    vaultOwner: null,
    movedByTheFence: true,
  },
  // 8. …and the same class on a NON-GET, since the custody predicate is
  //    method-independent (#1896).
  {
    method: 'DELETE',
    path: `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}`,
    plain: assetSignal(PRIVATE_CUSTOM_ASSET, null),
    vaultOwner: null,
  },
  {
    method: 'DELETE',
    path: `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}?portfolioId=${PLAIN_PORTFOLIO}`,
    plain: assetSignal(PRIVATE_CUSTOM_ASSET, PLAIN_PORTFOLIO),
    vaultOwner: null,
    movedByTheFence: true,
  },
];

/**
 * A throwaway app carrying the battery's routers, so `req.baseUrl` and the
 * matched `:id` param are real rather than hand-fed. The vault answers are the
 * only variable: a plain account owns no vault, a vault owner owns one holding
 * {@link VAULTED_PORTFOLIO}.
 */
function fenceApp(options: {
  readonly vaultOwner: boolean;
  readonly usage?: { capture(signal: UsageSignal): void };
}): {
  app: express.Express;
  captured: UsageSignal[];
  isOwnedPortfolioVaulted: ReturnType<typeof vi.fn>;
  userOwnsVaultedPortfolio: ReturnType<typeof vi.fn>;
} {
  const captured: UsageSignal[] = [];
  const usage = options.usage ?? { capture: (signal: UsageSignal) => captured.push(signal) };
  const isOwnedPortfolioVaulted = vi.fn(
    async (_userId: string, portfolioId: string) =>
      options.vaultOwner && portfolioId === VAULTED_PORTFOLIO,
  );
  const userOwnsVaultedPortfolio = vi.fn(async () => options.vaultOwner);

  const app = express();
  app.use((req, _res, next) => {
    req.authUser = { id: 'user-1', privacyMode: 'normal' } as never;
    next();
  });
  app.use(
    createUsageCaptureMiddleware(
      usage as never,
      {
        isOwnedPortfolioVaulted,
        userOwnsVaultedPortfolio,
      } as never,
    ),
  );

  const portfolios = express.Router();
  portfolios.get('/', (_req, res) => void res.json({ ok: true }));
  portfolios.get('/:id', (_req, res) => void res.json({ ok: true }));
  app.use('/api/v1/portfolios', portfolios);

  const assets = express.Router();
  assets.get('/quotes', (_req, res) => void res.json({ ok: true }));
  assets.get('/:id/quote', (_req, res) => void res.json({ ok: true }));
  app.use('/api/v1/assets', assets);

  const customAssets = express.Router();
  customAssets.get('/', (_req, res) => void res.json({ ok: true }));
  customAssets.get('/:id/value-points', (_req, res) => void res.json({ ok: true }));
  customAssets.delete('/:id', (_req, res) => void res.status(204).send());
  app.use('/api/v1/custom-assets', customAssets);

  return { app, captured, isOwnedPortfolioVaulted, userOwnsVaultedPortfolio };
}

/** Capture runs on `finish`, one microtask behind the response. */
async function settleCapture(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function drive(app: express.Express, shape: Shape): Promise<number> {
  const res =
    shape.method === 'GET'
      ? await request(app).get(shape.path)
      : await request(app).delete(shape.path);
  await settleCapture();
  return res.status;
}

const normalize = (signal: UsageSignal): Recorded => ({
  feature: signal.feature,
  assetId: signal.assetId ?? null,
  targetPortfolioId: signal.targetPortfolioId ?? null,
  suppressIfAnyVault: signal.suppressIfAnyVault === true,
});

describe('usage capture — the request-time vault fence (#1952)', () => {
  describe.each([
    { account: 'an account that owns no vault', vaultOwner: false, column: 'plain' },
    { account: 'an account that owns a vault', vaultOwner: true, column: 'vaultOwner' },
  ] as const)('$account', ({ vaultOwner, column }) => {
    it.each(BATTERY.map((shape, index) => ({ shape, index })))(
      `records the pinned signal for shape $index ($shape.method $shape.path)`,
      async ({ shape }) => {
        const { app, captured } = fenceApp({ vaultOwner });
        const status = await drive(app, shape);
        // Not vacuous via the `statusCode >= 400` early return: every shape in
        // the battery is a real 2xx on this app.
        expect(status).toBeLessThan(400);

        const expected = column === 'plain' ? shape.plain : shape.vaultOwner;
        expect(captured.map(normalize)).toEqual(expected ? [expected] : []);
      },
    );
  });

  it('suppresses at the middleware the shapes that only the repository used to drop', () => {
    // Guards the battery itself: if a future edit relabels the cells, this
    // fails rather than letting the four bypass shapes quietly stop being
    // tested. These are exactly the cells whose vault-owner outcome this fix
    // moved from "buffered with the private id" to "never buffered".
    expect(BATTERY.filter((shape) => shape.movedByTheFence).map((shape) => shape.path)).toEqual([
      `/api/v1/assets/${CATALOG_ASSET}/quote?portfolioId=${PLAIN_PORTFOLIO}`,
      `/api/v1/assets/quotes?portfolioId=${PLAIN_PORTFOLIO}`,
      `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}/value-points?portfolioId=${PLAIN_PORTFOLIO}`,
      `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}?portfolioId=${PLAIN_PORTFOLIO}`,
    ]);
    // Each one is suppressed for a vault owner and recorded for a plain account
    // — so neither column can pass by "record nothing".
    for (const shape of BATTERY.filter((s) => s.movedByTheFence)) {
      expect(shape.vaultOwner, shape.path).toBeNull();
      expect(shape.plain?.assetId ?? shape.plain?.targetPortfolioId, shape.path).toBeTruthy();
    }
  });

  it('decides the custody segment BEFORE it asks whether the query target is vaulted', async () => {
    // The order is the fix, not just the outcome: a fence that answers first is
    // a fence the target branch can never route around. If the target branch
    // ran first it would spend this lookup — and return `false`.
    const { app, isOwnedPortfolioVaulted, userOwnsVaultedPortfolio } = fenceApp({
      vaultOwner: true,
    });
    await drive(app, {
      method: 'GET',
      path: `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}/value-points?portfolioId=${PLAIN_PORTFOLIO}`,
      plain: null,
      vaultOwner: null,
    });
    expect(userOwnsVaultedPortfolio).toHaveBeenCalledTimes(1);
    expect(isOwnedPortfolioVaulted).not.toHaveBeenCalled();
  });

  it('keeps the private uuid out of the in-memory buffer, not merely out of the table', async () => {
    // The repository fence stays (defence in depth), but it can only drop a row
    // that the process already holds. This asserts the BUFFER: for a vault
    // owner the uuid never enters it, so a crash, a heap dump or a flush to a
    // replica that skipped the re-check has nothing to leak.
    const upserts: unknown[][] = [];
    const repo = {
      upsertEvents: async (rows: unknown[]) => void upserts.push(rows),
    } as unknown as UsageAnalyticsRepository;

    const usage = createUsageAnalyticsService({ repo });
    const { app } = fenceApp({ vaultOwner: true, usage });
    const bypass: Shape = {
      method: 'GET',
      path: `/api/v1/custom-assets/${PRIVATE_CUSTOM_ASSET}/value-points?portfolioId=${PLAIN_PORTFOLIO}`,
      plain: null,
      vaultOwner: null,
    };
    expect(await drive(app, bypass)).toBe(200);

    expect(usage.bufferedRows()).toBe(0);
    await usage.flush();
    expect(upserts).toEqual([]);

    // Control — the same request from an account with no vault DOES buffer the
    // id, so the assertion above cannot pass by buffering nothing at all.
    const plainUsage = createUsageAnalyticsService({ repo });
    const plain = fenceApp({ vaultOwner: false, usage: plainUsage });
    expect(await drive(plain.app, bypass)).toBe(200);
    expect(plainUsage.bufferedRows()).toBe(1);
    await plainUsage.flush();
    expect(JSON.stringify(upserts)).toContain(PRIVATE_CUSTOM_ASSET);
  });
});
