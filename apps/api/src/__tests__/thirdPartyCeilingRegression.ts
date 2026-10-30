import { eq } from 'drizzle-orm';
import { vi } from 'vitest';

import type { ApiKeyScope } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import type { OAuthService } from '../services/oauth/oauthService';
import type { TestHarness } from '../testing/createTestApp';

/**
 * OpSec R-05 test seam. A THIRD-party OAuth app can no longer register for, be
 * granted or use the first-party-only scopes (`account:security`,
 * `vault:sync`): registration refuses them and the service clamps them out of
 * every third-party ceiling. The route rails BEHIND that ceiling still have to
 * stand on their own, so a test that pins one needs a third-party principal
 * that holds such a scope anyway — a state only a regression could produce.
 * These two helpers build it explicitly, never implicitly.
 */

/**
 * Rewrite an existing third-party app, its grant and the grant's access tokens
 * to `scopes`, exactly as code from before the rule would have stored them.
 * On its own this changes nothing a request can observe: the ceiling still
 * clamps the first-party-only entries out.
 */
export async function storeAsPreRuleThirdPartyApp(
  harness: TestHarness,
  input: { clientId: string; grantId: string; scopes: readonly ApiKeyScope[] },
): Promise<void> {
  const scopes = [...input.scopes];
  await harness.db
    .update(schema.oauthClients)
    .set({ scopes })
    .where(eq(schema.oauthClients.clientId, input.clientId));
  await harness.db
    .update(schema.oauthGrants)
    .set({ scopes })
    .where(eq(schema.oauthGrants.id, input.grantId));
  await harness.db
    .update(schema.oauthAccessTokens)
    .set({ scopes })
    .where(eq(schema.oauthAccessTokens.grantId, input.grantId));
}

/**
 * Pinned literally rather than imported from the contract, so this seam keeps
 * simulating the regression even if the contract's set were ever emptied.
 */
const FIRST_PARTY_ONLY: ReadonlySet<string> = new Set(['account:security', 'vault:sync']);

const forcedByService = new WeakMap<OAuthService, Map<string, ApiKeyScope[]>>();

/**
 * Simulate a regression of the third-party ceiling for ONE grant: its resolved
 * bearer principal carries `scopes`' first-party-only entries again. Every
 * other token resolves untouched. Installed once per harness service, so
 * several grants can be forced in one test without stacking spies.
 */
export function simulateThirdPartyCeilingRegression(
  harness: TestHarness,
  input: { grantId: string; scopes: readonly ApiKeyScope[] },
): void {
  const service = harness.ctx.oauth;
  let forced = forcedByService.get(service);
  if (!forced) {
    const registry = new Map<string, ApiKeyScope[]>();
    forced = registry;
    forcedByService.set(service, registry);
    const original = service.authenticateToken.bind(service);
    vi.spyOn(service, 'authenticateToken').mockImplementation(async (token) => {
      const principal = await original(token);
      const extra = principal ? registry.get(principal.grantId) : undefined;
      if (!principal || principal.firstParty || !extra) return principal;
      return { ...principal, scopes: [...new Set([...principal.scopes, ...extra])] };
    });
  }
  forced.set(
    input.grantId,
    input.scopes.filter((scope) => FIRST_PARTY_ONLY.has(scope)),
  );
}
