import { describe, expect, it } from 'vitest';

import { isParanoidKilledPath, safeDestination, surfaceAllowed } from './ParanoidSurfaceGate';

describe('paranoid route and surface matrix', () => {
  it.each([
    '/s/public-token',
    '/u/jane',
    '/people/shared',
    '/people/shared/portfolio-id',
    '/people/profile',
    '/people/following',
    '/control/profile',
    '/portfolio/import',
    '/portfolio/cash-flow',
    '/portfolio/cash-flow/transactions',
    '/portfolio/cash-flow/budgets',
    '/portfolio/cash-flow/categories',
    '/portfolio/cash-flow/rules',
    '/portfolio/cash-flow/import',
    // The renamed canonical area (V5 cash fusion phase 2) — same decision,
    // both vocabularies.
    '/portfolio/cash',
    '/portfolio/cash/movements',
    '/portfolio/cash/transactions',
    '/portfolio/cash/budgets',
    '/portfolio/cash/labels',
    '/portfolio/cash/tags',
    '/portfolio/cash/rules',
    '/portfolio/cash/categories',
    '/portfolio/cash/import',
    '/portfolio/people',
    '/portfolio/tax/print',
    '/assets/news',
    '/social/my-shared',
    '/social/shared-with-me/portfolio-id',
    '/social/profile',
  ])('removes killed path %s', (path) => {
    expect(isParanoidKilledPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/portfolio',
    '/portfolio/activity',
    '/portfolio/cash-flow/accounts',
    '/portfolio/cash/accounts',
    '/portfolio/analysis',
    '/portfolio/tax',
    '/portfolio/settings',
    '/people',
    '/people/chat',
    '/workbench/forecasts',
    '/workbench/backtests',
    '/workbench/calculators',
    '/workbench/alerts',
    '/assets/search',
    '/assets/watchlists',
    '/assets/asset-id',
    '/control/notifications',
    '/control/account',
  ])('keeps explicit private/auth/client surface %s', (path) => {
    expect(isParanoidKilledPath(path)).toBe(false);
  });

  it.each([
    // The Control Center is an overlay: a killed panel must land on a sibling
    // panel, not on /portfolio, which would close the popup outright.
    ['/control/profile', '/control/account'],
    ['/people/profile', '/people'],
    ['/people/following', '/people'],
    ['/social/my-shared', '/people'],
    ['/assets/news', '/assets'],
    ['/portfolio/cash-flow/budgets', '/portfolio/cash/accounts'],
    ['/portfolio/cash/budgets', '/portfolio/cash/accounts'],
    ['/portfolio/cash', '/portfolio/cash/accounts'],
    ['/portfolio/tax/print', '/portfolio/tax'],
    ['/portfolio/import', '/portfolio'],
  ])('redirects killed %s to %s', (from, to) => {
    expect(safeDestination(from)).toBe(to);
  });

  it('keeps normal-mode compatibility while allowing only kept paranoid surfaces', () => {
    expect(surfaceAllowed('normal', 'killed')).toBe(true);
    expect(surfaceAllowed('normal', 'kept')).toBe(true);
    expect(surfaceAllowed('paranoid', 'kept')).toBe(true);
    expect(surfaceAllowed('paranoid', 'killed')).toBe(false);
  });
});
