import { describe, expect, test } from 'vitest';

import {
  OAUTH_FIRST_PARTY_ONLY_SCOPES,
  OAUTH_SCOPE_CAPABILITY_CLAIMS,
  OAUTH_SCOPE_LABELS,
} from '@bettertrack/contracts';

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
import { buildRouteTable } from '../scripts/checkOpenapiCoverage';

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
 *
 * The two first-party-only scopes ({@link OAUTH_FIRST_PARTY_ONLY_SCOPES}) get a
 * wider walk: account deletion and the full data export reach
 * `account:security` through the `/account` MODULE-PREFIX row, which no
 * allowlist lists. For those two scopes the walk covers every mounted route
 * whose live policy resolves to them, however the policy table gets there.
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
  // The account-security prefixes under `/auth`, reached through
  // prefix rules rather than an allowlist. Each is one of the management areas
  // the account:security copy lists by name.
  'DELETE /auth/sessions/{id}': 'Covered by "sign-in sessions".',
  'POST /auth/sessions/revoke-others': 'Covered by "sign-in sessions".',
  'DELETE /auth/remembered-devices/{handle}': 'Remembered sign-in devices — "sign-in sessions".',
  'DELETE /auth/remembered-devices': 'Remembered sign-in devices — "sign-in sessions".',
  'POST /auth/change-password': 'Covered by "password change".',
  'POST /auth/pin/verify': 'Covered by "app PIN".',
  'PUT /auth/pin': 'Covered by "app PIN".',
  'DELETE /auth/pin': 'Covered by "app PIN".',
  'PUT /auth/pin/idle-timeout': 'Covered by "app PIN".',
  'POST /auth/pin/quick-auth': 'Covered by "app PIN".',
  'POST /auth/2fa/enroll': 'Covered by "two-factor".',
  'DELETE /auth/2fa/enroll': 'Covered by "two-factor".',
  'POST /auth/2fa/confirm': 'Covered by "two-factor".',
  'POST /auth/2fa/disable': 'Covered by "two-factor".',
  'POST /auth/2fa/email/enroll': 'Covered by "two-factor".',
  'POST /auth/2fa/email/confirm': 'Covered by "two-factor".',
  'POST /auth/2fa/email/disable': 'Covered by "two-factor".',
  'POST /auth/2fa/recovery-codes': 'Covered by "two-factor".',
  'POST /auth/google/link/start': 'Google sign-in link — sign-in management under the same copy.',
  'POST /auth/google/unlink': 'Google sign-in unlink — sign-in management under the same copy.',
  'POST /auth/first-run/complete': "A set-once onboarding flag on the caller's own account.",
  'POST /auth/fresh-start-notice/acknowledge':
    "A set-once notice receipt on the caller's own account (§16 2026-10-29).",
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
  collected.push(...mountedFirstPartyOnlyScopeWrites());
  return collected;
}

/**
 * Every mounted non-safe route whose LIVE bearer policy resolves to a
 * first-party-only scope — module-prefix rows and `/auth` prefix
 * rules included, not just the allowlists. An `all-methods` route is probed as
 * a write and keeps its synthetic method, so it can never be acknowledged and
 * fails closed.
 */
function mountedFirstPartyOnlyScopeWrites(): { source: string; route: AuditedRoute }[] {
  const firstPartyOnly = new Set<string>(OAUTH_FIRST_PARTY_ONLY_SCOPES);
  return buildRouteTable().flatMap((surface) => {
    if (surface.kind === 'opaque-mount' || !surface.path.startsWith('/api/v1/')) return [];
    const method = surface.kind === 'route' ? surface.method.toUpperCase() : '<all-methods>';
    if (SAFE_METHODS.has(method)) return [];
    const route = { method, path: surface.path.slice('/api/v1'.length) };
    const probeMethod = surface.kind === 'route' ? method : 'POST';
    const policy = resolveBearerPolicyClassification(concretePath(route), probeMethod);
    if (policy.kind !== 'scope' || !firstPartyOnly.has(policy.write)) return [];
    return [{ source: 'mounted routes (first-party-only scopes)', route }];
  });
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

  test('the mounted walk reaches the /account module-prefix row', () => {
    // The walk must be live, not vacuous: an empty first-party-only set or a
    // broken route table would otherwise pass the unaccounted check above.
    const walked = new Set(mountedFirstPartyOnlyScopeWrites().map(({ route }) => routeKey(route)));
    for (const key of [
      'DELETE /account',
      'POST /account/export',
      'POST /account/export/download',
      'POST /auth/2fa/recovery-codes',
      'PUT /vaults/{vaultId}/docs/{docId}',
    ]) {
      expect(walked, key).toContain(key);
    }
    // ...and stays inside the two scopes: an ordinary module write is not walked.
    expect(walked).not.toContain('POST /portfolios');
  });

  test('the account:security copy names the full data export and account deletion', () => {
    // Pinned literally: these are the two capabilities the module-prefix row
    // hid from the consent copy.
    const label = OAUTH_SCOPE_LABELS['account:security'].toLowerCase();
    expect(label).toContain('export');
    expect(label).toContain('all your data');
    expect(label).toContain('deleting your account');
    for (const [method, path] of [
      ['DELETE', '/account'],
      ['POST', '/account/export'],
      ['POST', '/account/export/download'],
    ] as const) {
      expect(CLAIM_BY_ROUTE.get(`${method} ${path}`)?.scope, `${method} ${path}`).toBe(
        'account:security',
      );
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
