import { describe, expect, it } from 'vitest';

import { PARANOID_CLIENT_ROUTE_DECISIONS } from '@bettertrack/contracts';

import { isParanoidKilledPath, safeDestination, surfaceAllowed } from './ParanoidSurfaceGate';

const KILLED_CLIENT_ROUTE_RULES = PARANOID_CLIENT_ROUTE_DECISIONS.flatMap(
  (decision) => decision.clientRoutes,
);

const KILLED_ROUTE_CASES = KILLED_CLIENT_ROUTE_RULES.flatMap(
  (rule): [path: string, destination: string][] => [
    [rule.path, rule.destination],
    ...(rule.match === 'prefix'
      ? [[`${rule.path}/representative-child`, rule.destination] as [string, string]]
      : []),
  ],
);

const NORMALIZATION_RULE =
  KILLED_CLIENT_ROUTE_RULES.find((rule) => rule.match === 'exact') ?? KILLED_CLIENT_ROUTE_RULES[0]!;

describe('paranoid route and surface matrix', () => {
  it.each(KILLED_ROUTE_CASES)('removes killed path %s and redirects to %s', (path, destination) => {
    expect(isParanoidKilledPath(path)).toBe(true);
    expect(safeDestination(path)).toBe(destination);
  });

  it.each([
    `${NORMALIZATION_RULE.path}/`,
    NORMALIZATION_RULE.path.toUpperCase(),
    `${NORMALIZATION_RULE.path.toUpperCase()}///`,
  ])('normalizes router-equivalent killed path %s', (path) => {
    expect(isParanoidKilledPath(path)).toBe(true);
    expect(safeDestination(path)).toBe(NORMALIZATION_RULE.destination);
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

  it('keeps normal-mode compatibility while allowing only kept paranoid surfaces', () => {
    expect(surfaceAllowed('normal', 'killed')).toBe(true);
    expect(surfaceAllowed('normal', 'kept')).toBe(true);
    expect(surfaceAllowed('paranoid', 'kept')).toBe(true);
    expect(surfaceAllowed('paranoid', 'killed')).toBe(false);
  });
});
