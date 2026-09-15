import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

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
  logoBytes?: Buffer | null;
  logoContentType?: string | null;
}

/**
 * Browser/API-facing client metadata. Logo bytes deliberately stay out of list
 * queries; callers need only know whether the dedicated byte endpoint exists.
 */
export type OAuthClientListRow = Pick<
  OAuthClientRow,
  'id' | 'clientId' | 'name' | 'redirectUris' | 'scopes' | 'isPublic' | 'isFirstParty' | 'createdAt'
> & { hasLogo: boolean };

/**
 * Client fields needed by authorize/token flows. This is intentionally narrower
 * than OAuthClientRow so a token exchange can never pull the cached logo blob.
 */
export type OAuthClientLookupRow = Pick<
  OAuthClientRow,
  | 'id'
  | 'clientId'
  | 'name'
  | 'clientSecretHash'
  | 'redirectUris'
  | 'scopes'
  | 'isPublic'
  | 'isFirstParty'
> & { hasLogo: boolean };

export type OAuthGrantClientRow = Pick<
  OAuthClientRow,
  'clientId' | 'name' | 'scopes' | 'isFirstParty'
>;

export interface ReconciledFirstPartyGrant {
  grantId: string;
  userId: string;
  beforeScopes: string[];
  afterScopes: string[];
}

export interface FirstPartyClientReconcileResult {
  client: OAuthClientRow;
  widenedGrants: ReconciledFirstPartyGrant[];
}

/** Maximum active-grant rows held `FOR UPDATE` by one reconcile transaction. */
export const FIRST_PARTY_GRANT_RECONCILE_BATCH_SIZE = 100;

const oauthClientListSelection = {
  id: oauthClients.id,
  clientId: oauthClients.clientId,
  name: oauthClients.name,
  redirectUris: oauthClients.redirectUris,
  scopes: oauthClients.scopes,
  isPublic: oauthClients.isPublic,
  isFirstParty: oauthClients.isFirstParty,
  createdAt: oauthClients.createdAt,
  hasLogo: sql<boolean>`${oauthClients.logoBytes} IS NOT NULL`,
} as const;

const oauthClientLookupSelection = {
  id: oauthClients.id,
  clientId: oauthClients.clientId,
  name: oauthClients.name,
  clientSecretHash: oauthClients.clientSecretHash,
  redirectUris: oauthClients.redirectUris,
  scopes: oauthClients.scopes,
  isPublic: oauthClients.isPublic,
  isFirstParty: oauthClients.isFirstParty,
  hasLogo: sql<boolean>`${oauthClients.logoBytes} IS NOT NULL`,
} as const;

// Deliberately duplicated in the service: data must not import services under the layering rule.
function unionPreservingOrder(existing: readonly string[], additions: readonly string[]): string[] {
  const merged = [...existing];
  const seen = new Set(existing);
  for (const item of additions) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

/**
 * The persistence operations available while an authorization code exchange is
 * holding the code and its owning user row locked. Keeping the whole mutation
 * inside this transaction makes an administrative status transition serialize
 * with the exchange: suspension either observes and revokes the finished grant,
 * or the exchange observes the disabled user and cannot mint one.
 */
export interface OAuthAuthorizationCodeExchange {
  code: OAuthAuthCodeRow;
  user: UserRow;
  consumeCode(): Promise<OAuthAuthCodeRow | undefined>;
  findActiveGrant(clientId: string): Promise<OAuthGrantRow | undefined>;
  createGrant(input: {
    clientId: string;
    userId: string;
    scopes: string[];
  }): Promise<OAuthGrantRow>;
  updateGrantScopes(grantId: string, scopes: string[]): Promise<void>;
  createAccessToken(input: {
    grantId: string;
    tokenHash: string;
    scopes: string[];
    expiresAt: Date;
  }): Promise<OAuthAccessTokenRow>;
  createRefreshToken(input: {
    grantId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<OAuthRefreshTokenRow>;
}

export interface RotateOAuthRefreshTokenInput {
  tokenId: string;
  grantId: string;
  rotatedAt: Date;
  accessToken: {
    tokenHash: string;
    scopes: string[];
    expiresAt: Date;
  };
  refreshToken: {
    tokenHash: string;
    expiresAt: Date;
  };
}

export type OAuthRefreshTokenRotation = 'rotated' | 'replayed';

function createAuthorizationCodeExchange(
  executor: Pick<Database, 'select' | 'insert' | 'update'>,
  code: OAuthAuthCodeRow,
  user: UserRow,
): OAuthAuthorizationCodeExchange {
  return {
    code,
    user,

    async consumeCode(): Promise<OAuthAuthCodeRow | undefined> {
      const [row] = await executor
        .update(oauthAuthCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(oauthAuthCodes.id, code.id), isNull(oauthAuthCodes.consumedAt)))
        .returning();
      return row;
    },

    async findActiveGrant(clientId: string): Promise<OAuthGrantRow | undefined> {
      const [row] = await executor
        .select()
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.clientId, clientId),
            eq(oauthGrants.userId, code.userId),
            isNull(oauthGrants.revokedAt),
          ),
        )
        .limit(1);
      return row;
    },

    async createGrant(input): Promise<OAuthGrantRow> {
      const [row] = await executor.insert(oauthGrants).values(input).returning();
      if (!row) throw new Error('Failed to insert OAuth grant');
      return row;
    },

    async updateGrantScopes(grantId: string, scopes: string[]): Promise<void> {
      await executor.update(oauthGrants).set({ scopes }).where(eq(oauthGrants.id, grantId));
    },

    async createAccessToken(input): Promise<OAuthAccessTokenRow> {
      const [row] = await executor.insert(oauthAccessTokens).values(input).returning();
      if (!row) throw new Error('Failed to insert OAuth access token');
      return row;
    },

    async createRefreshToken(input): Promise<OAuthRefreshTokenRow> {
      const [row] = await executor.insert(oauthRefreshTokens).values(input).returning();
      if (!row) throw new Error('Failed to insert OAuth refresh token');
      return row;
    },
  };
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
          logoBytes: input.logoBytes ?? null,
          logoContentType: input.logoContentType ?? null,
        })
        .returning();
      if (!row) throw new Error('Failed to insert OAuth client');
      return row;
    },

    async listClientsForUser(userId: string): Promise<OAuthClientListRow[]> {
      return db
        .select(oauthClientListSelection)
        .from(oauthClients)
        .where(eq(oauthClients.userId, userId))
        .orderBy(desc(oauthClients.createdAt));
    },

    // ── First-party (admin-managed) clients ─────────────────────────────────
    /** Every admin-registered first-party app (owned by the system, not a user). */
    async listFirstPartyClients(): Promise<OAuthClientListRow[]> {
      return db
        .select(oauthClientListSelection)
        .from(oauthClients)
        .where(eq(oauthClients.isFirstParty, true))
        .orderBy(desc(oauthClients.createdAt));
    },

    /**
     * Delete a first-party client by id (admin panel; cascades grants/tokens).
     * Lock and retain the active grant principals before the cascade so the
     * service can disconnect precisely those live OAuth sockets afterwards.
     * Scoped to `is_first_party` so this path can never touch a user-owned app.
     */
    async deleteFirstPartyClient(id: string) {
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const [client] = await executor
          .select()
          .from(oauthClients)
          .where(and(eq(oauthClients.id, id), eq(oauthClients.isFirstParty, true)))
          .limit(1)
          .for('update');
        if (!client) return undefined;

        const activeGrants = await executor
          .select({ id: oauthGrants.id, userId: oauthGrants.userId })
          .from(oauthGrants)
          .where(and(eq(oauthGrants.clientId, client.id), isNull(oauthGrants.revokedAt)));
        const [deleted] = await executor
          .delete(oauthClients)
          .where(eq(oauthClients.id, client.id))
          .returning();
        if (!deleted) throw new Error('Failed to delete OAuth client');
        return { client: deleted, activeGrants };
      });
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
     * Boot-seed only (#395, #1393): converge a first-party client's allowed-scope
     * ceiling and redirect URIs to the caller-supplied sets, then union that
     * ceiling into every active grant for the client in fixed-size transactions.
     * The caller ({@link seedFirstPartyClients}) always passes the additive UNION
     * of the stored values with the code-defined definition, so neither the client
     * nor its live grants are narrowed. Revoked grants are deliberately immutable.
     * The first-party predicate keeps user-owned apps outside this product-owned
     * reconciliation boundary; `client_id`, secret, name and public flag are not
     * settable here. Returns the current row, or undefined when the id isn't a
     * first-party app, together with the exact before/after state of every grant
     * actually rewritten so the service can audit the system mutation.
     *
     * IDEMPOTENCY KEY: `(oauth_clients.id, oauth_grants.id)` under a union that
     * is its own fixpoint — once a grant holds the ceiling the length guard
     * short-circuits it, so a replay (every boot runs this) performs zero writes
     * and the stored scope arrays keep their existing order. Active grants are
     * visited in `id` order, at most {@link FIRST_PARTY_GRANT_RECONCILE_BATCH_SIZE}
     * per transaction, and changed rows are written with one set-based UPDATE per
     * batch. This bounds the lock set seen by bearer traffic; `revoked_at IS NULL`
     * is re-asserted in the UPDATE so a revoked grant is never resurrected.
     */
    async reconcileFirstPartyClient(
      id: string,
      input: { scopes: string[]; redirectUris: string[] },
    ): Promise<FirstPartyClientReconcileResult | undefined> {
      const client = await db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const [stored] = await executor
          .select()
          .from(oauthClients)
          .where(and(eq(oauthClients.id, id), eq(oauthClients.isFirstParty, true)))
          .limit(1)
          .for('update');
        if (!stored) return undefined;

        let client = stored;
        if (
          !arraysEqual(stored.scopes, input.scopes) ||
          !arraysEqual(stored.redirectUris, input.redirectUris)
        ) {
          const [updated] = await executor
            .update(oauthClients)
            .set({ scopes: input.scopes, redirectUris: input.redirectUris })
            .where(and(eq(oauthClients.id, id), eq(oauthClients.isFirstParty, true)))
            .returning();
          if (!updated) throw new Error('Failed to reconcile first-party OAuth client');
          client = updated;
        }

        return client;
      });
      if (!client) return undefined;

      const widenedGrants: ReconciledFirstPartyGrant[] = [];
      let afterGrantId: string | undefined;
      while (true) {
        const batchResult = await db.transaction(async (tx) => {
          const executor = tx as unknown as Database;
          const activeGrants = await executor
            .select({
              id: oauthGrants.id,
              userId: oauthGrants.userId,
              scopes: oauthGrants.scopes,
            })
            .from(oauthGrants)
            .where(
              and(
                eq(oauthGrants.clientId, client.id),
                isNull(oauthGrants.revokedAt),
                afterGrantId ? gt(oauthGrants.id, afterGrantId) : undefined,
              ),
            )
            .orderBy(oauthGrants.id)
            .limit(FIRST_PARTY_GRANT_RECONCILE_BATCH_SIZE)
            .for('update');

          const changes = activeGrants.flatMap((grant): ReconciledFirstPartyGrant[] => {
            const afterScopes = unionPreservingOrder(grant.scopes, input.scopes);
            if (arraysEqual(afterScopes, grant.scopes)) return [];
            return [
              {
                grantId: grant.id,
                userId: grant.userId,
                beforeScopes: grant.scopes,
                afterScopes,
              },
            ];
          });

          let updatedIds = new Set<string>();
          if (changes.length > 0) {
            const patches = changes.map((change) => {
              const scopes = change.afterScopes.map((scope) => sql`${scope}::text`);
              return sql`(
                ${change.grantId}::uuid,
                ARRAY[${sql.join(scopes, sql`, `)}]::text[]
              )`;
            });
            const updated = await executor.execute(sql`
              UPDATE "oauth_grants" AS target_grant
              SET "scopes" = patch."scopes"
              FROM (VALUES ${sql.join(patches, sql`, `)}) AS patch("id", "scopes")
              WHERE target_grant."id" = patch."id"
                AND target_grant."revoked_at" IS NULL
              RETURNING target_grant."id"
            `);
            const rows =
              (updated as { rows?: Array<{ id: string }> }).rows ??
              (updated as unknown as Array<{ id: string }>);
            updatedIds = new Set(rows.map((row) => row.id));
          }

          return {
            read: activeGrants.length,
            lastId: activeGrants.at(-1)?.id,
            widened: changes.filter((change) => updatedIds.has(change.grantId)),
          };
        });

        widenedGrants.push(...batchResult.widened);
        if (!batchResult.lastId || batchResult.read < FIRST_PARTY_GRANT_RECONCILE_BATCH_SIZE) {
          break;
        }
        afterGrantId = batchResult.lastId;
      }

      return { client, widenedGrants };
    },

    /** Resolve a client by its public `btc_…` identifier (authorize/token flows). */
    async findClientByClientId(clientId: string): Promise<OAuthClientLookupRow | undefined> {
      const [row] = await db
        .select(oauthClientLookupSelection)
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .limit(1);
      return row;
    },

    /** Read only the already-cached raster bytes; never fetch the source URL. */
    async findClientLogoByClientId(
      clientId: string,
    ): Promise<{ bytes: Buffer; contentType: string } | undefined> {
      const [row] = await db
        .select({
          bytes: oauthClients.logoBytes,
          contentType: oauthClients.logoContentType,
        })
        .from(oauthClients)
        .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.isFirstParty, false)))
        .limit(1);
      if (!row?.bytes || !row.contentType) return undefined;
      return { bytes: row.bytes, contentType: row.contentType };
    },

    /**
     * Delete a client the caller owns (cascades grants, codes and tokens).
     * Lock and retain active grant principals before the cascade so the service
     * can disconnect precisely those live OAuth sockets afterwards. Returns
     * undefined when the id isn't the caller's, avoiding a client-id leak.
     */
    async deleteClient(userId: string, id: string) {
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const [client] = await executor
          .select()
          .from(oauthClients)
          .where(and(eq(oauthClients.id, id), eq(oauthClients.userId, userId)))
          .limit(1)
          .for('update');
        if (!client) return undefined;

        const activeGrants = await executor
          .select({ id: oauthGrants.id, userId: oauthGrants.userId })
          .from(oauthGrants)
          .where(and(eq(oauthGrants.clientId, client.id), isNull(oauthGrants.revokedAt)));
        const [deleted] = await executor
          .delete(oauthClients)
          .where(eq(oauthClients.id, client.id))
          .returning();
        if (!deleted) throw new Error('Failed to delete OAuth client');
        return { client: deleted, activeGrants };
      });
    },

    // ── Grants ───────────────────────────────────────────────────────────────
    /** The caller's active grants joined to the granting app's name + public id. */
    async listGrantsForUser(
      userId: string,
    ): Promise<{ grant: OAuthGrantRow; client: OAuthGrantClientRow }[]> {
      return db
        .select({
          grant: oauthGrants,
          client: {
            clientId: oauthClients.clientId,
            name: oauthClients.name,
            scopes: oauthClients.scopes,
            isFirstParty: oauthClients.isFirstParty,
          },
        })
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

    /**
     * Administrative account suspension invalidates every OAuth credential the
     * user could otherwise resume with: live grants kill access/refresh tokens,
     * and pending authorization codes are consumed permanently.
     */
    async revokeAllForUser(userId: string): Promise<void> {
      const invalidatedAt = new Date();
      await db
        .update(oauthGrants)
        .set({ revokedAt: invalidatedAt })
        .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
      await db
        .update(oauthAuthCodes)
        .set({ consumedAt: invalidatedAt })
        .where(and(eq(oauthAuthCodes.userId, userId), isNull(oauthAuthCodes.consumedAt)));
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

    /**
     * Execute an authorization-code exchange under the code + user row locks.
     *
     * The user lock is deliberately the same row lock an administrative status
     * update acquires. Therefore a code flow that entered first commits its
     * grant/tokens before suspension can proceed (and suspension revokes that
     * grant afterwards); one that enters after suspension sees `disabled` in
     * the callback. The transaction also keeps a consumed pre-suspension code
     * from resuming later and creating a fresh grant after re-enable.
     */
    async withAuthorizationCodeExchange<T>(
      codeHash: string,
      run: (exchange: OAuthAuthorizationCodeExchange | null) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const [code] = await executor
          .select()
          .from(oauthAuthCodes)
          .where(eq(oauthAuthCodes.codeHash, codeHash))
          .limit(1)
          .for('update');
        if (!code) return run(null);

        const [user] = await executor
          .select()
          .from(users)
          .where(eq(users.id, code.userId))
          .limit(1)
          .for('update');
        if (!user) return run(null);

        return run(createAuthorizationCodeExchange(executor, code, user));
      });
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
    async findAccessTokenByHash(tokenHash: string): Promise<
      | {
          token: OAuthAccessTokenRow;
          grant: OAuthGrantRow;
          user: UserRow;
          client: Pick<OAuthClientRow, 'scopes' | 'isFirstParty'>;
        }
      | undefined
    > {
      const [row] = await db
        .select({
          token: oauthAccessTokens,
          grant: oauthGrants,
          user: users,
          client: {
            scopes: oauthClients.scopes,
            isFirstParty: oauthClients.isFirstParty,
          },
        })
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

    /** Resolve a refresh token by hash joined to its grant + owning user (any grant state). */
    async findRefreshTokenByHash(
      tokenHash: string,
    ): Promise<{ token: OAuthRefreshTokenRow; grant: OAuthGrantRow; user: UserRow } | undefined> {
      const [row] = await db
        .select({ token: oauthRefreshTokens, grant: oauthGrants, user: users })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthRefreshTokens.grantId, oauthGrants.id))
        .innerJoin(users, eq(oauthGrants.userId, users.id))
        .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
        .limit(1);
      return row;
    },

    /**
     * Consume one refresh token and insert its replacement pair in the same
     * transaction. A concurrent caller that loses the atomic consume revokes
     * the whole grant before returning, so the winner's just-issued pair is
     * already unusable once both exchanges settle.
     */
    async rotateRefreshToken(
      input: RotateOAuthRefreshTokenInput,
    ): Promise<OAuthRefreshTokenRotation> {
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const [consumed] = await executor
          .update(oauthRefreshTokens)
          .set({ consumedAt: input.rotatedAt })
          .where(
            and(
              eq(oauthRefreshTokens.id, input.tokenId),
              eq(oauthRefreshTokens.grantId, input.grantId),
              isNull(oauthRefreshTokens.consumedAt),
            ),
          )
          .returning({ id: oauthRefreshTokens.id });

        if (!consumed) {
          await executor
            .update(oauthGrants)
            .set({ revokedAt: input.rotatedAt })
            .where(and(eq(oauthGrants.id, input.grantId), isNull(oauthGrants.revokedAt)));
          return 'replayed';
        }

        const [accessToken] = await executor
          .insert(oauthAccessTokens)
          .values({ grantId: input.grantId, ...input.accessToken })
          .returning({ id: oauthAccessTokens.id });
        if (!accessToken) throw new Error('Failed to insert OAuth access token');

        const [refreshToken] = await executor
          .insert(oauthRefreshTokens)
          .values({ grantId: input.grantId, ...input.refreshToken })
          .returning({ id: oauthRefreshTokens.id });
        if (!refreshToken) throw new Error('Failed to insert OAuth refresh token');

        await executor
          .update(oauthGrants)
          .set({ lastUsedAt: input.rotatedAt })
          .where(eq(oauthGrants.id, input.grantId));
        return 'rotated';
      });
    },
  };
}

export type OAuthRepository = ReturnType<typeof createOAuthRepository>;
