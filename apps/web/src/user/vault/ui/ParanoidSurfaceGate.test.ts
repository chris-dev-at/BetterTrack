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

const NORMALIZED_KILLED_ROUTE_CASES = KILLED_CLIENT_ROUTE_RULES.flatMap(
  (rule): [path: string, destination: string][] => [
    [`${rule.path}/`, rule.destination],
    [rule.path.toUpperCase(), rule.destination],
    [`${rule.path.toUpperCase()}///`, rule.destination],
  ],
);

describe('paranoid route and surface matrix', () => {
  it('pins the complete client kill-rule set', () => {
    expect(KILLED_CLIENT_ROUTE_RULES).toHaveLength(29);
  });

  it.each(KILLED_ROUTE_CASES)('removes killed path %s and redirects to %s', (path, destination) => {
    expect(isParanoidKilledPath(path)).toBe(true);
    expect(safeDestination(path)).toBe(destination);
  });

  it.each(NORMALIZED_KILLED_ROUTE_CASES)(
    'normalizes router-equivalent killed path %s',
    (path, destination) => {
      expect(isParanoidKilledPath(path)).toBe(true);
      expect(safeDestination(path)).toBe(destination);
    },
  );

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
