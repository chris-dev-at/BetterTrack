import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db';
import {
  oauthAccessTokens,
  oauthAuthCodes,
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
  users,
  type OAuthAccessTokenRow,
  type OAuthAuthCodeRow,
  type OAuthClientRow,
  type OAuthGrantRow,
  type OAuthRefreshTokenRow,
  type UserRow,
} from '../schema';

/**
 * OAuth 2.0 provider persistence (PROJECTPLAN.md §6.13, §14, V2-P12). Only
 * token/secret *hashes* are stored. Single-use codes and rotating refresh tokens
 * are consumed with an atomic `UPDATE … WHERE consumed_at IS NULL RETURNING`, so
 * a concurrent double-exchange can only ever win once. Every token lookup joins
 * through the owning grant and rejects a revoked one — that is what makes a grant
 * revocation cut off access and refresh tokens instantly.
 */
export interface CreateOAuthClientInput {
  /** Null for an admin-managed first-party app (owned by the system, not a user). */
  userId: string | null;
  clientId: string;
  name: string;
  clientSecretHash: string | null;
  redirectUris: string[];
  scopes: string[];
  isPublic: boolean;
  isFirstParty?: boolean;
  logoUrl?: string | null;
}

export interface CreateOAuthAuthCodeInput {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  expiresAt: Date;
}

export function createOAuthRepository(db: Database) {
  return {
    // ── Clients ──────────────────────────────────────────────────────────────
    async createClient(input: CreateOAuthClientInput): Promise<OAuthClientRow> {
      const [row] = await db
        .insert(oauthClients)
        .values({
          userId: input.userId,
          clientId: input.clientId,
          name: input.name,
          clientSecretHash: input.clientSecretHash,
          redirectUris: input.redirectUris,
          scopes: input.scopes,
          isPublic: input.isPublic,
          isFirstParty: input.isFirstParty ?? false,
          logoUrl: input.logoUrl ?? null,
        })
        .returning();
      if (!row) throw new Error('Failed to insert OAuth client');
      return row;
    },

    async listClientsForUser(userId: string): Promise<OAuthClientRow[]> {
      return db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.userId, userId))
        .orderBy(desc(oauthClients.createdAt));
    },

    // ── First-party (admin-managed) clients ─────────────────────────────────
    /** Every admin-registered first-party app (owned by the system, not a user). */
    async listFirstPartyClients(): Promise<OAuthClientRow[]> {
      return db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.isFirstParty, true))
        .orderBy(desc(oauthClients.createdAt));
    },

    /**
     * Delete a first-party client by id (admin panel; cascades grants/tokens).
     * Scoped to `is_first_party` so this path can never touch a user-owned app.
     */
    async deleteFirstPartyClient(id: string): Promise<OAuthClientRow | undefined> {
      const [row] = await db
        .delete(oauthClients)
        .where(and(eq(oauthClients.id, id), eq(oauthClients.isFirstParty, true)))
        .returning();
      return row;
    },

    /** Resolve a first-party client by internal id (admin edit: before-state + 404). */
    async findFirstPartyClientById(id: string): Promise<OAuthClientRow | undefined> {
      const [row] = await db
        .select()
        .from(oauthClients)
        .where(and(eq(oauthClients.id, id), eq(oauthClients.isFirstParty, true)))
        .limit(1);
      return row;
    },

    /**
     * Edit a first-party client's mutable fields (name, redirect URIs, allowed
     * scopes, logo) by internal id (admin panel). Scoped to `is_first_party` so
     * this path can never touch a user-owned app. The `client_id`, the client
     * secret and the public/confidential flag are immutable and deliberately not
     * settable here — issued tokens reference the `client_id`, and flipping the
     * client type would force a secret rotation (a separate concern).
     *
     * Consent-safety: this only rewrites the CLIENT's allowed-scope ceiling; it
     * never rewrites any grant/token scopes. Because the effective scope of a
     * live token is the intersection of its consented scopes and this ceiling
     * (see the client join in {@link findAccessTokenByHash}), widening cannot
     * grant an existing token a new scope (it never consented to it) while
     * narrowing drops the removed scope immediately. Returns the updated row, or
     * undefined when the id isn't a first-party app.
     */
    async updateFirstPartyClient(
      id: string,
      input: { name: string; redirectUris: string[]; scopes: string[]; logoUrl: string | null },
    ): Promise<OAuthClientRow | undefined> {
      const [row] = await db
        .update(oauthClients)
        .set({
          name: input.name,
          redirectUris: input.redirectUris,
          scopes: input.scopes,
          logoUrl: input.logoUrl,
        })
        .where(and(eq(oauthClients.id, id), eq(oauthClients.isFirstParty, true)))
        .returning();
      return row;
    },

    /**
     * Boot-seed only (#395): converge a first-party client's allowed-scope ceiling
     * and redirect URIs to the caller-supplied sets. The caller
     * ({@link seedFirstPartyClients}) always passes the additive UNION of the
     * stored values with the code-defined definition, so this never narrows an
     * admin's manual additions. Scoped to `is_first_party` so it can never rewrite
     * a user-owned app; the `client_id`, secret, name and public flag are
     * deliberately not settable here. Returns the updated row, or undefined when
     * the id isn't a first-party app.
     */
    async reconcileFirstPartyClient(
      id: string,
      input: { scopes: string[]; redirectUris: string[] },
    ): Promise<OAuthClientRow | undefined> {
      const [row] = await db
        .update(oauthClients)
        .set({ scopes: input.scopes, redirectUris: input.redirectUris })
        .where(and(eq(oauthClients.id, id), eq(oauthClients.isFirstParty, true)))
        .returning();
      return row;
    },

    /** Resolve a client by its public `btc_…` identifier (authorize/token flows). */
    async findClientByClientId(clientId: string): Promise<OAuthClientRow | undefined> {
      const [row] = await db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .limit(1);
      return row;
    },

    /**
     * Delete a client the caller owns (cascades grants, codes and tokens).
     * Returns the deleted row, or undefined when the id isn't the caller's — so
     * the service can 404 without leaking another user's client ids.
     */
    async deleteClient(userId: string, id: string): Promise<OAuthClientRow | undefined> {
      const [row] = await db
        .delete(oauthClients)
        .where(and(eq(oauthClients.id, id), eq(oauthClients.userId, userId)))
        .returning();
      return row;
    },

    // ── Grants ───────────────────────────────────────────────────────────────
    async findActiveGrant(clientId: string, userId: string): Promise<OAuthGrantRow | undefined> {
      const [row] = await db
        .select()
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.clientId, clientId),
            eq(oauthGrants.userId, userId),
            isNull(oauthGrants.revokedAt),
          ),
        )
        .limit(1);
      return row;
    },

    async createGrant(input: {
      clientId: string;
      userId: string;
      scopes: string[];
    }): Promise<OAuthGrantRow> {
      const [row] = await db.insert(oauthGrants).values(input).returning();
      if (!row) throw new Error('Failed to insert OAuth grant');
      return row;
    },

    async updateGrantScopes(grantId: string, scopes: string[]): Promise<void> {
      await db.update(oauthGrants).set({ scopes }).where(eq(oauthGrants.id, grantId));
    },

    /** The caller's active grants joined to the granting app's name + public id. */
    async listGrantsForUser(
      userId: string,
    ): Promise<{ grant: OAuthGrantRow; client: OAuthClientRow }[]> {
      return db
        .select({ grant: oauthGrants, client: oauthClients })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
        .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
        .orderBy(desc(oauthGrants.createdAt));
    },

    /**
     * Revoke a grant the caller owns. Returns the revoked row, or undefined when
     * the id isn't the caller's or is already revoked — so the service 404s
     * without leaking grant ids. Access + refresh tokens die immediately because
     * every token lookup requires the grant to be active.
     */
    async revokeGrant(userId: string, id: string): Promise<OAuthGrantRow | undefined> {
      const [row] = await db
        .update(oauthGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oauthGrants.id, id),
            eq(oauthGrants.userId, userId),
            isNull(oauthGrants.revokedAt),
          ),
        )
        .returning();
      return row;
    },

    async touchGrantLastUsed(grantId: string, at: Date): Promise<void> {
      await db.update(oauthGrants).set({ lastUsedAt: at }).where(eq(oauthGrants.id, grantId));
    },

    // ── Authorization codes ──────────────────────────────────────────────────
    async createAuthCode(input: CreateOAuthAuthCodeInput): Promise<OAuthAuthCodeRow> {
      const [row] = await db.insert(oauthAuthCodes).values(input).returning();
      if (!row) throw new Error('Failed to insert OAuth authorization code');
      return row;
    },

    async findAuthCodeByHash(codeHash: string): Promise<OAuthAuthCodeRow | undefined> {
      const [row] = await db
        .select()
        .from(oauthAuthCodes)
        .where(eq(oauthAuthCodes.codeHash, codeHash))
        .limit(1);
      return row;
    },

    /**
     * Atomically consume a code: stamps `consumed_at` only if it was still null.
     * Returns the row on success, undefined if it was already consumed (replay).
     */
    async consumeAuthCode(id: string): Promise<OAuthAuthCodeRow | undefined> {
      const [row] = await db
        .update(oauthAuthCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(oauthAuthCodes.id, id), isNull(oauthAuthCodes.consumedAt)))
        .returning();
      return row;
    },

    // ── Access tokens ────────────────────────────────────────────────────────
    async createAccessToken(input: {
      grantId: string;
      tokenHash: string;
      scopes: string[];
      expiresAt: Date;
    }): Promise<OAuthAccessTokenRow> {
      const [row] = await db.insert(oauthAccessTokens).values(input).returning();
      if (!row) throw new Error('Failed to insert OAuth access token');
      return row;
    },

    /**
     * Resolve an access token by hash, joined to its (active) grant, the owning
     * user AND the granting client — the bearer-auth lookup. Returns nothing for
     * a token whose grant is revoked; the service still checks expiry against the
     * row. The client is joined so the service can clamp the token's effective
     * scope to the app's CURRENT allowed-scope ceiling (consent-safety: a scope
     * removed from the app is denied immediately; a scope added to the app is not
     * silently granted to a token that never consented to it).
     */
    async findAccessTokenByHash(
      tokenHash: string,
    ): Promise<
      | { token: OAuthAccessTokenRow; grant: OAuthGrantRow; user: UserRow; client: OAuthClientRow }
      | undefined
    > {
      const [row] = await db
        .select({ token: oauthAccessTokens, grant: oauthGrants, user: users, client: oauthClients })
        .from(oauthAccessTokens)
        .innerJoin(oauthGrants, eq(oauthAccessTokens.grantId, oauthGrants.id))
        .innerJoin(users, eq(oauthGrants.userId, users.id))
        .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
        .where(and(eq(oauthAccessTokens.tokenHash, tokenHash), isNull(oauthGrants.revokedAt)))
        .limit(1);
      return row;
    },

    // ── Refresh tokens ───────────────────────────────────────────────────────
    async createRefreshToken(input: {
      grantId: string;
      tokenHash: string;
      expiresAt: Date;
    }): Promise<OAuthRefreshTokenRow> {
      const [row] = await db.insert(oauthRefreshTokens).values(input).returning();
      if (!row) throw new Error('Failed to insert OAuth refresh token');
      return row;
    },

    /** Resolve a refresh token by hash joined to its grant (any grant state). */
    async findRefreshTokenByHash(
      tokenHash: string,
    ): Promise<{ token: OAuthRefreshTokenRow; grant: OAuthGrantRow } | undefined> {
      const [row] = await db
        .select({ token: oauthRefreshTokens, grant: oauthGrants })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthRefreshTokens.grantId, oauthGrants.id))
        .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
        .limit(1);
      return row;
    },

    /** Atomically consume (rotate) a refresh token; undefined if already used. */
    async consumeRefreshToken(id: string): Promise<OAuthRefreshTokenRow | undefined> {
      const [row] = await db
        .update(oauthRefreshTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(oauthRefreshTokens.id, id), isNull(oauthRefreshTokens.consumedAt)))
        .returning();
      return row;
    },
  };
}

export type OAuthRepository = ReturnType<typeof createOAuthRepository>;
