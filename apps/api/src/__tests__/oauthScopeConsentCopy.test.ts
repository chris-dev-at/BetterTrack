import { describe, expect, test } from 'vitest';

import { OAUTH_SCOPE_CAPABILITY_CLAIMS, OAUTH_SCOPE_LABELS } from '@bettertrack/contracts';

import {
  MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST,
  OAUTH_GRANT_FIRST_PARTY_BEARER_ROUTE_ALLOWLIST,
  PASSKEY_MANAGEMENT_BEARER_ROUTE_ALLOWLIST,
  resolveBearerPolicyClassification,
  SETTINGS_SUBPATH_POLICY_CENSUS,
  TAX_YEAR_DOCUMENTATION_BEARER_ROUTE_ALLOWLIST,
  VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST,
  VAULT_SYNC_BEARER_ROUTE_ALLOWLIST,
} from '../http/middleware/bearerAuth';

/**
 * #1860 — the consent screen is the only place a user is told what they are
 * authorizing, and three scopes had drifted from what they really grant: an
 * owner-approved widening grew a bearer allowlist and the copy stayed behind.
 * Nothing caught it because the only copy test compared the English label to
 * the English bundle — a label↔label tautology.
 *
 * This file closes the loop on the ENFORCEMENT side: it walks the real bearer
 * allowlists plus the `/settings` policy census and requires every write-shaped
 * route they open to be either
 *   - named by an {@link OAUTH_SCOPE_CAPABILITY_CLAIMS} entry, whose phrase must
 *     then appear in that scope's consent copy, or
 *   - acknowledged below as routine — an effect the module's plain copy already
 *     covers, with the reason stated.
 *
 * So adding a destructive route to an allowlist fails here until its scope's
 * copy names it. Nothing in this file changes enforcement; the middleware's
 * allowlists remain the only thing that decides access.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Any live id — the allowlist matchers accept a UUID for an unqualified param. */
const UUID = '11111111-1111-1111-1111-111111111111';
/** One non-safe probe per `/settings` census row: the census pins ALL of them alike. */
const CENSUS_PROBE_METHOD = 'PATCH';

interface AuditedRoute {
  readonly method: string;
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
}

const AUDITED_ALLOWLISTS: readonly {
  readonly name: string;
  readonly routes: readonly AuditedRoute[];
}[] = [
  { name: 'MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST', routes: MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST },
  { name: 'VAULT_SYNC_BEARER_ROUTE_ALLOWLIST', routes: VAULT_SYNC_BEARER_ROUTE_ALLOWLIST },
  {
    name: 'VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST',
    routes: VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST,
  },
  {
    name: 'PASSKEY_MANAGEMENT_BEARER_ROUTE_ALLOWLIST',
    routes: PASSKEY_MANAGEMENT_BEARER_ROUTE_ALLOWLIST,
  },
  {
    name: 'OAUTH_GRANT_FIRST_PARTY_BEARER_ROUTE_ALLOWLIST',
    routes: OAUTH_GRANT_FIRST_PARTY_BEARER_ROUTE_ALLOWLIST,
  },
  {
    name: 'TAX_YEAR_DOCUMENTATION_BEARER_ROUTE_ALLOWLIST',
    routes: TAX_YEAR_DOCUMENTATION_BEARER_ROUTE_ALLOWLIST,
  },
];

/**
 * Non-safe bearer routes whose effect the module's own plain-language copy
 * already covers, so no extra consent sentence is owed. Each line is a decision
 * with its reason — the same shape as the policy censuses in `bearerAuth.ts`.
 */
const ROUTINE_BEARER_WRITES: Readonly<Record<string, string>> = {
  'POST /mirrorchain/invites/{inviteId}/accept':
    'Participation — the join half of the group-portfolio copy.',
  'POST /mirrorchain/invites/{inviteId}/decline': 'Participation — declining an invitation.',
  'POST /mirrorchain/chains/{chainId}/leave':
    'Participation — the leave half of the group-portfolio copy.',
  'POST /mirrorchain/chains': 'Administration — covered by "create and rename a group".',
  'POST /mirrorchain/chains/convert':
    'Administration — creating a chain from an existing portfolio.',
  'PATCH /mirrorchain/chains/{chainId}': 'Administration — covered by "create and rename a group".',
  'POST /mirrorchain/invites/{inviteId}/revoke':
    'Administration — withdrawing an invitation the same scope issued.',
  'PUT /vault': 'Opaque ciphertext sync — the legacy account-singleton blob (vault:sync).',
  'PUT /vaults/{vaultId}/docs/{docId}': 'Opaque ciphertext sync — one encrypted doc (vault:sync).',
  'PATCH /auth/passkeys/{id}': 'Renaming a passkey is ordinary "passkeys" management.',
  'PATCH /settings/notifications': 'Covered by "change your notification settings".',
  'PATCH /settings/telegram': 'Notification egress — the notifications module surface (#1730).',
  'PATCH /settings/discord': 'Notification egress — the notifications module surface (#1730).',
  'PATCH /settings/account': 'Profile/visibility preferences — the social module copy.',
  'PATCH /settings/home': 'Home layout — a per-account UI preference under the social module.',
  'PATCH /settings/widget-layout': 'Widget placement — a per-account UI preference.',
};

function routeKey(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/** Substitute a live id for each `{param}` so the real resolver can be asked. */
function concretePath(route: AuditedRoute): string {
  return route.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const kind = route.params?.[name] ?? route.params?.[name.toLowerCase()];
    return kind === 'positive-integer' ? '1' : UUID;
  });
}

/** Every non-safe route the audited allowlists and the `/settings` census open. */
function auditedWriteRoutes(): { source: string; route: AuditedRoute }[] {
  const collected = AUDITED_ALLOWLISTS.flatMap(({ name, routes }) =>
    routes
      .filter((route) => !SAFE_METHODS.has(route.method.toUpperCase()))
      .map((route) => ({
        source: name,
        route: route as AuditedRoute,
      })),
  );
  for (const row of SETTINGS_SUBPATH_POLICY_CENSUS) {
    if (row.unsafe.kind !== 'scope') continue;
    collected.push({
      source: 'SETTINGS_SUBPATH_POLICY_CENSUS',
      route: { method: CENSUS_PROBE_METHOD, path: row.subPath },
    });
  }
  return collected;
}

const CLAIM_BY_ROUTE = new Map(
  OAUTH_SCOPE_CAPABILITY_CLAIMS.flatMap((claim) =>
    claim.routes.map((route) => [routeKey(route), claim] as const),
  ),
);

describe('#1860 consent copy is bound to the routes each scope really opens', () => {
  test('every write-shaped bearer route is claimed in the consent copy or acknowledged as routine', () => {
    const unaccounted: string[] = [];
    for (const { source, route } of auditedWriteRoutes()) {
      const key = routeKey(route);
      if (CLAIM_BY_ROUTE.has(key) || key in ROUTINE_BEARER_WRITES) continue;
      unaccounted.push(`${key} (${source})`);
    }
    // A new destructive route lands here until its scope's consent copy names
    // it (a capability claim) or the decision is recorded as routine above.
    expect(unaccounted).toEqual([]);
  });

  test('each claimed route still resolves to the scope whose copy names it', () => {
    for (const claim of OAUTH_SCOPE_CAPABILITY_CLAIMS) {
      for (const route of claim.routes) {
        const classification = resolveBearerPolicyClassification(concretePath(route), route.method);
        // A claim that no longer describes live enforcement is worse than no
        // claim: the copy would promise a capability the token cannot use, or
        // hide one that moved to another scope.
        expect(classification, routeKey(route)).toMatchObject({
          kind: 'scope',
          write: claim.scope,
        });
      }
    }
  });

  test('every claim phrase appears verbatim in its scope English consent copy', () => {
    for (const claim of OAUTH_SCOPE_CAPABILITY_CLAIMS) {
      expect(OAUTH_SCOPE_LABELS[claim.scope].toLowerCase(), claim.id).toContain(
        claim.enPhrase.toLowerCase(),
      );
    }
  });

  test('no routine acknowledgment outlives the route it excuses', () => {
    const live = new Set(auditedWriteRoutes().map(({ route }) => routeKey(route)));
    for (const key of Object.keys(ROUTINE_BEARER_WRITES)) {
      expect(live, key).toContain(key);
    }
  });

  test('the three #1860 scopes carry at least one named capability', () => {
    // Pins the fix itself: the mirrorchain widening (§16 2026-08-07), the vault
    // control plane on account:security and the tax regime on portfolio:write
    // must each stay represented in the copy, not just in the allowlists.
    for (const scope of ['mirrorchain:write', 'account:security', 'portfolio:write'] as const) {
      expect(
        OAUTH_SCOPE_CAPABILITY_CLAIMS.filter((claim) => claim.scope === scope).length,
        scope,
      ).toBeGreaterThan(0);
    }
  });
});
