import { describe, expect, it } from 'vitest';

import {
  PARANOID_KILL_REGISTRY,
  paranoidCapabilityForRoute,
  paranoidClassificationsForRoute,
} from '../../../services/account/paranoidEnforcement';
import { resolveBearerPolicyClassification } from '../bearerAuth';

/**
 * #1828 — the four §6.3 portfolio-level market-intelligence roll-ups are mounted
 * under `/api/v1/assets`, but they read the CALLER's holdings + watchlists (the
 * projection down to per-holding `quantity`). They must resolve on the portfolio
 * scope pair, not on the coarse `/assets` → `market:read` module row.
 */
const ROLLUPS = [
  '/assets/portfolio/dividend-projection',
  '/assets/portfolio/dividend-calendar',
  '/assets/portfolio/news-digest',
  '/assets/intel/earnings-calendar',
] as const;

const PORTFOLIO_POLICY = {
  kind: 'scope',
  read: 'portfolio:read',
  write: 'portfolio:write',
} as const;

const MARKET_POLICY = { kind: 'scope', read: 'market:read', write: 'market:write' } as const;

describe('bearer policy — portfolio market-intel roll-ups (#1828)', () => {
  it('resolves every roll-up on the portfolio scope pair', () => {
    for (const path of ROLLUPS) {
      expect(resolveBearerPolicyClassification(path, 'GET'), path).toEqual(PORTFOLIO_POLICY);
    }
  });

  it('matches the trailing-slash spelling Express routes to the same handler', () => {
    for (const path of ROLLUPS) {
      expect(resolveBearerPolicyClassification(`${path}/`, 'GET'), path).toEqual(PORTFOLIO_POLICY);
    }
  });

  it('matches case-insensitively, like Express itself', () => {
    expect(
      resolveBearerPolicyClassification('/assets/Portfolio/Dividend-Projection', 'GET'),
    ).toEqual(PORTFOLIO_POLICY);
  });

  it('leaves the per-asset intel feeds and the rest of /assets on market:read', () => {
    const assetId = '11111111-1111-4111-8111-111111111111';
    for (const suffix of [
      '',
      '/intel',
      '/intel/dividends',
      '/intel/earnings',
      '/intel/news',
      '/intel/splits',
      '/intel/fundamentals',
      '/quote',
      '/history',
    ]) {
      const path = `/assets/${assetId}${suffix}`;
      expect(resolveBearerPolicyClassification(path, 'GET'), path).toEqual(MARKET_POLICY);
    }
  });

  it('does not widen a neighbouring /assets/portfolio* path by accident', () => {
    // Only the four documented roll-ups are carved out; anything else under the
    // module keeps resolving through the `/assets` row.
    for (const path of [
      '/assets/portfolio',
      '/assets/portfolio/dividend-projection-extra',
      '/assets/portfolio/news-digest/details',
      '/assets/intel',
      '/assets/intel/earnings-calendar/details',
    ]) {
      expect(resolveBearerPolicyClassification(path, 'GET'), path).toEqual(MARKET_POLICY);
    }
  });

  it('agrees with the paranoid portfolioServer kill-list on the same route set', () => {
    // The privacy layer already calls these paths portfolio surfaces. Derive the
    // list from the registry rather than restating it, so the two layers cannot
    // drift apart again: any `/assets/…` route the kill-list moves into (or out
    // of) `portfolioServer` has to be re-classified here in the same change.
    const portfolioServer = PARANOID_KILL_REGISTRY.find(
      (entry) => entry.capability === 'portfolioServer',
    );
    expect(portfolioServer).toBeDefined();
    const killedAssetPaths = (portfolioServer?.routes ?? []).flatMap((rule) =>
      rule.exact?.startsWith('/assets/') ? [rule.exact] : [],
    );
    expect(killedAssetPaths.length).toBeGreaterThan(0);
    for (const path of killedAssetPaths) {
      expect(paranoidCapabilityForRoute('GET', path), path).toBe('portfolioServer');
      expect(resolveBearerPolicyClassification(path, 'GET'), path).toEqual(PORTFOLIO_POLICY);
    }
    // The three `/assets/portfolio/*` roll-ups are exactly the `/assets` paths
    // the kill-list owns; the earnings calendar is deliberately NOT killed (a
    // paranoid account has no server-side holdings, so it degrades to the
    // client-held watchlist and stays available). That is not a disagreement:
    // on an ordinary account its row set is still held + watched, which is why
    // the bearer layer classifies it with its three siblings.
    expect(killedAssetPaths.slice().sort()).toEqual(
      ROLLUPS.filter((path) => path.startsWith('/assets/portfolio/'))
        .slice()
        .sort(),
    );
    expect(paranoidClassificationsForRoute('GET', '/assets/intel/earnings-calendar')).toEqual([
      'kept',
    ]);
  });
});
