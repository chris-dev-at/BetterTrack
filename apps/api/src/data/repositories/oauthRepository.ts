import { oauthRefreshReplayWindowSeconds } from '@bettertrack/contracts';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { OAuthTokenFamilyRevokeReason } from '../../services/audit/auditService';
import type { Database } from '../db';
import {
  oauthAccessTokens,
  oauthAuthCodes,
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
  oauthTokenFamilies,
  users,
  type OAuthAccessTokenRow,
  type OAuthAuthCodeRow,
  type OAuthClientRow,
  type OAuthGrantRow,
  type OAuthRefreshTokenRow,
  type OAuthTokenFamilyRow,
  type UserRow,
} from '../schema';

/**
 * OAuth 2.0 provider persistence (PROJECTPLAN.md §6.13, §14, V2-P12). Only
 * token/secret *hashes* are stored — the one exception is a rotated refresh
 * token's `successor_envelope`, an AES-256-GCM envelope (sealed by the service)
 * of the pair it was rotated into, served only inside the re-serve window of
 * the token's own client (60 s third-party, 24 h first-party — see
 * `oauthRefreshReplayWindowSeconds`) and nulled once it has passed (on read, on
 * the successor's rotation, after the next rotation anywhere, and by the daily
 * sweep).
 * Single-use codes and rotating refresh tokens
 * are consumed with an atomic `UPDATE … WHERE consumed_at IS NULL RETURNING`, so
 * a concurrent double-exchange can only ever win once. Every token lookup joins
 * through the owning grant and rejects a revoked one — that is what makes a grant
 * revocation cut off access and refresh tokens instantly. Tokens also hang off a
 * per-install TOKEN FAMILY (migration 0119): revoking a family cuts off only that
 * install's tokens; a legacy NULL-family row's family is the grant itself.
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
  /**
   * The user's active grant for this client, taken `FOR UPDATE`: the exchange
   * read-modify-writes its scopes (the re-login UNION, §16 2026-10-29), so a
   * concurrent first-party reconcile — which locks the same grant rows — must
   * not interleave and lose its scope additions. Lock order code → user →
   * grant → family → token rows (the grant → family → token-rows order every
   * OAuth writer shares, see `rotateRefreshToken`), never the client row, so
   * it cannot cycle with the reconcile's client → grants order.
   */
  findActiveGrant(clientId: string): Promise<OAuthGrantRow | undefined>;
  createGrant(input: {
    clientId: string;
    userId: string;
    scopes: string[];
  }): Promise<OAuthGrantRow>;
  updateGrantScopes(grantId: string, scopes: string[]): Promise<void>;
  /** Start a NEW per-install token family on `grantId` (every code exchange does). */
  createFamily(input: { grantId: string; instanceId: string | null }): Promise<OAuthTokenFamilyRow>;
  /**
   * Retire every LIVE family on `grantId` carrying `instanceId` (reason
   * `relogin`) and drop their sealed grace envelopes; resolves to the retired
   * rows. Runs under the grant lock before {@link createFamily}, so the live
   * `(grant_id, instance_id)` partial unique index can never be violated by a
   * re-login. IDEMPOTENCY KEY: `revoked_at IS NULL` — a family retires once.
   */
  retireInstanceFamilies(input: {
    grantId: string;
    instanceId: string;
    at: Date;
  }): Promise<OAuthTokenFamilyRow[]>;
  createAccessToken(input: {
    grantId: string;
    familyId: string;
    tokenHash: string;
    scopes: string[];
    expiresAt: Date;
  }): Promise<OAuthAccessTokenRow>;
  createRefreshToken(input: {
    grantId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<OAuthRefreshTokenRow>;
}

/**
 * One token row resolved for RFC 7009 revocation: the ids a revoke needs,
 * nothing secret. `familyId` null = a legacy row (the family is the grant).
 */
export interface OAuthRevocableToken {
  grantId: string;
  userId: string;
  familyId: string | null;
}

export interface RotateOAuthRefreshTokenInput {
  tokenId: string;
  grantId: string;
  /**
   * The consumed token's family, inherited by both successor rows (null = a
   * legacy chain, which stays legacy until the install signs in again).
   */
  familyId: string | null;
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
  /**
   * Seal the successor token response for the refresh grace window. Called
   * INSIDE the rotating transaction once both new rows exist; the returned
   * envelope is stored on the consumed row. Encryption stays in the service —
   * this layer only ever sees ciphertext. A throw rolls the rotation back.
   */
  sealSuccessor(ids: OAuthRefreshRotationIds): string;
}

/** The ids a rotation writes, handed to {@link RotateOAuthRefreshTokenInput.sealSuccessor}. */
export interface OAuthRefreshRotationIds {
  /** The refresh-token row being consumed — the envelope's idempotency key. */
  tokenId: string;
  /** The refresh-token row it is rotated into. */
  successorId: string;
  /** The access-token row issued alongside the successor. */
  accessTokenId: string;
}

/** The successor columns the grace path compares against — never a secret. */
export type OAuthRefreshSuccessorRow = Pick<
  OAuthRefreshTokenRow,
  'id' | 'tokenHash' | 'consumedAt' | 'expiresAt'
>;

/** A refresh-token row joined to its grant, owning user and (if any) successor. */
export interface OAuthRefreshTokenLookup {
  token: OAuthRefreshTokenRow;
  grant: OAuthGrantRow;
  user: UserRow;
  /** The row `token.successorId` points at, while it still exists. */
  successor: OAuthRefreshSuccessorRow | null;
  /** The token's family (any state); null for a legacy row (the family is the grant). */
  family: OAuthTokenFamilyRow | null;
}

/**
 * `rotated`: this caller consumed the token and its pair is committed.
 * `replayed`: a concurrent caller consumed it first. `current` is the row as
 * re-read inside this caller's transaction AFTER the atomic consume came back
 * empty — under READ COMMITTED that consume waited on the winner's row lock, so
 * the winner's successor link and envelope are already visible. `undefined`
 * only when the row itself is gone (its grant was deleted meanwhile).
 * `revoked`: the grant or the token's family was revoked between the caller's
 * lookup and this transaction's lock on it; nothing was consumed or written.
 */
export type OAuthRefreshTokenRotation =
  | { outcome: 'rotated' }
  | { outcome: 'replayed'; current: OAuthRefreshTokenLookup | undefined }
  | { outcome: 'revoked' };

/**
 * What a credential event ({@link createOAuthRepository}'s
 * `revokeGrantsForCredentialEvent`) revoked: the grant id (the realtime
 * invalidation credential + the audit target) and the client's public
 * `btc_…` id (the audit meta). Never a token or a hash.
 */
export interface OAuthCredentialEventRevocation {
  grantId: string;
  clientId: string;
}

/**
 * Everything one credential event revoked, in one transaction: whole grants,
 * plus — sign-out-everywhere from an official app's bearer only — the OTHER
 * token families on the caller's own (kept) grant.
 */
export interface OAuthCredentialEventResult {
  grants: OAuthCredentialEventRevocation[];
  /** Sibling families revoked on `exceptGrantId` (reason `sign_out_everywhere`). */
  families: OAuthTokenFamilyRow[];
}

/** The successor side of the refresh-token self-join. */
const successorTokens = alias(oauthRefreshTokens, 'successor_tokens');

/**
 * Null every sealed successor pair under the given grants — one statement, run
 * in the revoking transaction by every revoke path. A revoked grant's pair can
 * never be served again (the re-serve and every token lookup require an active
 * grant), so keeping it at rest — and in the nightly dump — for the rest of its
 * window (up to 24 h for a first-party app) is pure residue. Idempotent: the
 * `successor_envelope IS NOT NULL` guard makes a replay a no-op.
 */
async function clearGrantEnvelopes(
  executor: Pick<Database, 'update'>,
  grantIds: string[] | SQL,
): Promise<void> {
  if (Array.isArray(grantIds) && grantIds.length === 0) return;
  await executor
    .update(oauthRefreshTokens)
    .set({ successorEnvelope: null })
    .where(
      and(
        Array.isArray(grantIds)
          ? inArray(oauthRefreshTokens.grantId, grantIds)
          : sql`${oauthRefreshTokens.grantId} IN ${grantIds}`,
        isNotNull(oauthRefreshTokens.successorEnvelope),
      ),
    );
}

/**
 * Read one refresh token with its grant, user and successor, enforcing the
 * envelope-lifetime rule on the way: a row whose re-serve window has passed
 * loses its `successor_envelope` on this very read (and the caller never sees
 * it), so a read past the window can never be the one that serves it. The
 * window follows the token's OWN client (joined through the grant):
 * {@link oauthRefreshReplayWindowSeconds} — 60 s for a third-party app, 24 h for
 * an official first-party app (§16 2026-10-29). Rows nobody reads again are
 * left to the post-rotation and daily sweeps. Every refresh-token read goes
 * through here.
 */
async function readRefreshToken(
  executor: Pick<Database, 'select' | 'update'>,
  where: SQL,
  now: Date,
): Promise<OAuthRefreshTokenLookup | undefined> {
  const [row] = await executor
    .select({
      token: oauthRefreshTokens,
      grant: oauthGrants,
      user: users,
      clientIsFirstParty: oauthClients.isFirstParty,
      successor: {
        id: successorTokens.id,
        tokenHash: successorTokens.tokenHash,
        consumedAt: successorTokens.consumedAt,
        expiresAt: successorTokens.expiresAt,
      },
      // ── token families (§16 2026-10-29) ──
      family: oauthTokenFamilies,
    })
    .from(oauthRefreshTokens)
    .innerJoin(oauthGrants, eq(oauthRefreshTokens.grantId, oauthGrants.id))
    .innerJoin(users, eq(oauthGrants.userId, users.id))
    .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .leftJoin(successorTokens, eq(successorTokens.id, oauthRefreshTokens.successorId))
    // LEFT: a legacy NULL-family row still resolves (the family is the grant).
    .leftJoin(oauthTokenFamilies, eq(oauthTokenFamilies.id, oauthRefreshTokens.familyId))
    .where(where)
    .limit(1);
  if (!row) return undefined;

  let token = row.token;
  const windowMs = oauthRefreshReplayWindowSeconds(row.clientIsFirstParty) * 1000;
  if (
    token.successorEnvelope !== null &&
    token.consumedAt !== null &&
    now.getTime() - token.consumedAt.getTime() > windowMs
  ) {
    await executor
      .update(oauthRefreshTokens)
      .set({ successorEnvelope: null })
      .where(
        and(eq(oauthRefreshTokens.id, token.id), isNotNull(oauthRefreshTokens.successorEnvelope)),
      );
    token = { ...token, successorEnvelope: null };
  }
  const successor = row.successor?.id ? row.successor : null;
  return { token, grant: row.grant, user: row.user, successor, family: row.family ?? null };
}

/**
 * Revoke one token family and drop the sealed grace envelopes of its refresh
 * rows (a dead family's successor pairs must not sit at rest). Shared by the
 * user-scoped {@link OAuthRepository.revokeFamily} and the code exchange's
 * `relogin` retirement. IDEMPOTENCY KEY: the family id under
 * `revoked_at IS NULL` — a family is revoked at most once, so concurrent
 * revokers produce one row (one audit, one fan-out).
 *
 * LOCK ORDER: the family row, THEN its token rows — the tail of the one
 * grant → family → token-rows order every OAuth writer follows (see
 * `rotateRefreshToken`). A caller that also locks the grant (the code
 * exchange) must already hold it when it gets here.
 */
async function revokeFamilies(
  executor: Pick<Database, 'update'>,
  where: SQL,
  reason: OAuthTokenFamilyRevokeReason,
  at: Date,
): Promise<OAuthTokenFamilyRow[]> {
  const revoked = await executor
    .update(oauthTokenFamilies)
    .set({ revokedAt: at, revokedReason: reason })
    .where(and(where, isNull(oauthTokenFamilies.revokedAt)))
    .returning();
  if (revoked.length > 0) {
    await executor
      .update(oauthRefreshTokens)
      .set({ successorEnvelope: null })
      .where(
        and(
          inArray(
            oauthRefreshTokens.familyId,
            revoked.map((family) => family.id),
          ),
          isNotNull(oauthRefreshTokens.successorEnvelope),
        ),
      );
  }
  return revoked;
}

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
        .limit(1)
        .for('update');
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

    async createFamily(input): Promise<OAuthTokenFamilyRow> {
      const [row] = await executor
        .insert(oauthTokenFamilies)
        .values({ grantId: input.grantId, instanceId: input.instanceId })
        .returning();
      if (!row) throw new Error('Failed to insert OAuth token family');
      return row;
    },

    retireInstanceFamilies(input): Promise<OAuthTokenFamilyRow[]> {
      return revokeFamilies(
        executor,
        and(
          eq(oauthTokenFamilies.grantId, input.grantId),
          eq(oauthTokenFamilies.instanceId, input.instanceId),
        )!,
        'relogin',
        input.at,
      );
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
     * ceiling into every active grant for the client in the same transaction.
     * The caller ({@link seedFirstPartyClients}) always passes the additive UNION
     * of the stored values with the code-defined definition, so neither the client
     * nor its live grants are narrowed. Revoked grants are deliberately immutable.
     * The first-party predicate keeps user-owned apps outside this product-owned
     * reconciliation boundary; `client_id`, secret, name and public flag are not
     * settable here. Returns the current row, or undefined when the id isn't a
     * first-party app.
     *
     * IDEMPOTENCY KEY: `(oauth_clients.id, oauth_grants.id)` under a union that
     * is its own fixpoint — once a grant holds the ceiling the length guard
     * short-circuits it, so a replay (every boot runs this) performs zero writes
     * and the stored scope arrays keep their existing order. Both the client row
     * and the active grants are taken `FOR UPDATE` in a single transaction, with
     * the grants locked in `id` order so two concurrent reconciles cannot
     * deadlock; `revoked_at IS NULL` is re-asserted in the grant UPDATE so a
     * grant revoked mid-transaction is never resurrected into a wider scope set.
     */
    async reconcileFirstPartyClient(
      id: string,
      input: { scopes: string[]; redirectUris: string[] },
    ): Promise<OAuthClientRow | undefined> {
      return db.transaction(async (tx) => {
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

        const activeGrants = await executor
          .select({ id: oauthGrants.id, scopes: oauthGrants.scopes })
          .from(oauthGrants)
          .where(and(eq(oauthGrants.clientId, stored.id), isNull(oauthGrants.revokedAt)))
          .orderBy(oauthGrants.id)
          .for('update');
        for (const grant of activeGrants) {
          const scopes = unionPreservingOrder(grant.scopes, input.scopes);
          if (scopes.length === grant.scopes.length) continue;
          await executor
            .update(oauthGrants)
            .set({ scopes })
            .where(and(eq(oauthGrants.id, grant.id), isNull(oauthGrants.revokedAt)));
        }

        return client;
      });
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
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const [row] = await executor
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
        // Its sealed pairs go with it (review S3, §16 2026-10-29).
        if (row) await clearGrantEnvelopes(executor, [row.id]);
        return row;
      });
    },

    // ── Token families (§16 2026-10-29, migration 0119) ──────────────────────
    /**
     * Revoke ONE per-install token family on a grant the caller owns, leaving
     * the grant and its other families untouched. Ownership is enforced here,
     * not by the caller: the family must sit on `grantId` AND that grant must
     * belong to `userId` and still be active. Resolves to the revoked row, or
     * undefined when the family is foreign, unknown or already revoked — the
     * idempotency key is the family id under `revoked_at IS NULL`, so two
     * concurrent revokes of one family yield exactly one row.
     */
    async revokeFamily(input: {
      userId: string;
      grantId: string;
      familyId: string;
      reason: OAuthTokenFamilyRevokeReason;
      at: Date;
    }): Promise<OAuthTokenFamilyRow | undefined> {
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const ownedGrant = executor
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(
            and(
              eq(oauthGrants.id, input.grantId),
              eq(oauthGrants.userId, input.userId),
              isNull(oauthGrants.revokedAt),
            ),
          );
        const [revoked] = await revokeFamilies(
          executor,
          and(
            eq(oauthTokenFamilies.id, input.familyId),
            eq(oauthTokenFamilies.grantId, input.grantId),
            inArray(oauthTokenFamilies.grantId, ownedGrant),
          )!,
          input.reason,
          input.at,
        );
        return revoked;
      });
    },

    /**
     * RFC 7009 lookup: resolve an access (`kind: 'access'`) or refresh token by
     * hash to the ids a revocation needs — in ANY state (expired, consumed,
     * revoked: RFC 7009 answers them all alike) — but only when it was issued to
     * `clientRowId`. A token of another client resolves to undefined, so the
     * endpoint can never revoke (or reveal) another app's credentials.
     */
    async findTokenForRevocation(input: {
      kind: 'access' | 'refresh';
      tokenHash: string;
      clientRowId: string;
    }): Promise<OAuthRevocableToken | undefined> {
      const ownedByClient = eq(oauthGrants.clientId, input.clientRowId);
      if (input.kind === 'access') {
        const [row] = await db
          .select({
            grantId: oauthGrants.id,
            userId: oauthGrants.userId,
            familyId: oauthAccessTokens.familyId,
          })
          .from(oauthAccessTokens)
          .innerJoin(oauthGrants, eq(oauthAccessTokens.grantId, oauthGrants.id))
          .where(and(eq(oauthAccessTokens.tokenHash, input.tokenHash), ownedByClient))
          .limit(1);
        return row;
      }
      const [row] = await db
        .select({
          grantId: oauthGrants.id,
          userId: oauthGrants.userId,
          familyId: oauthRefreshTokens.familyId,
        })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthRefreshTokens.grantId, oauthGrants.id))
        .where(and(eq(oauthRefreshTokens.tokenHash, input.tokenHash), ownedByClient))
        .limit(1);
      return row;
    },

    /**
     * Fail-closed realtime revalidation input: the access-token row's grant and
     * whether its family is still live. Undefined when the row is gone. A
     * legacy NULL-family row reports `familyRevoked: false` — its liveness is
     * the grant's, which the caller checks separately.
     */
    async findAccessTokenFamilyState(
      accessTokenId: string,
    ): Promise<{ grantId: string; familyId: string | null; familyRevoked: boolean } | undefined> {
      const [row] = await db
        .select({
          grantId: oauthAccessTokens.grantId,
          familyId: oauthAccessTokens.familyId,
          familyRevokedAt: oauthTokenFamilies.revokedAt,
        })
        .from(oauthAccessTokens)
        .leftJoin(oauthTokenFamilies, eq(oauthTokenFamilies.id, oauthAccessTokens.familyId))
        .where(eq(oauthAccessTokens.id, accessTokenId))
        .limit(1);
      if (!row) return undefined;
      return {
        grantId: row.grantId,
        familyId: row.familyId,
        familyRevoked: row.familyRevokedAt !== null,
      };
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
      // Every grant of the user is revoked now, so every sealed pair under
      // them goes (review S3). Runs after the revoke, so a retry converges.
      await clearGrantEnvelopes(
        db,
        sql`(SELECT ${oauthGrants.id} FROM ${oauthGrants} WHERE ${oauthGrants.userId} = ${userId} AND ${oauthGrants.revokedAt} IS NOT NULL)`,
      );
    },

    /**
     * Credential-event revocation (§16 2026-10-29): a password change, a
     * password reset, or "sign out everywhere" ends the user's OAuth grants —
     * every grant, or (`firstPartyOnly`) only those of official first-party
     * apps — except `exceptGrantId` (the caller's own grant on "sign out
     * everywhere", which promises to keep the caller signed in). Pending
     * authorization codes for the same client set are consumed permanently.
     *
     * `siblingFamilies` (sign-out-everywhere from an official app's bearer):
     * the kept grant serves EVERY install of that app, so keeping it whole
     * would keep every other phone signed in. With it, every live token family
     * on `exceptGrantId` EXCEPT `keepFamilyId` (the caller's own) is revoked
     * too, reason `sign_out_everywhere`, envelopes dropped with it
     * ({@link revokeFamilies}). A legacy pre-family caller (`keepFamilyId:
     * null`) keeps its chain — which is the grant itself — and every family on
     * the grant goes. Ownership is enforced HERE: the kept grant must belong to
     * `userId`, be live, and (`firstPartyOnly`) be a first-party client's.
     * Families are claimed after the code consumption, so a code exchange that
     * was in flight has committed its new family by then and it is revoked too;
     * lock order stays codes → grants → families → token rows.
     *
     * Ordering is the race guard, and it is deliberately lock-free. Codes are
     * consumed FIRST: an exchange in flight holds its code row `FOR UPDATE`, so
     * that statement waits for it to commit (and then skips the code it
     * consumed); the grant UPDATE that follows is a fresh READ COMMITTED
     * snapshot, so it sees — and revokes — the grant that exchange created or
     * reused. An exchange that starts after the first statement finds its code
     * consumed and is refused. Locks are taken codes → grants, the same order
     * an exchange takes code → (user) → grant, so the two cannot deadlock.
     *
     * IDEMPOTENCY KEY: the grant id, guarded by `revoked_at IS NULL`. A replay
     * (or a concurrent revoke of the same grant) returns nothing for that
     * grant, so the service audits and invalidates each grant exactly once.
     */
    async revokeGrantsForCredentialEvent(input: {
      userId: string;
      firstPartyOnly: boolean;
      exceptGrantId: string | null;
      siblingFamilies?: { keepFamilyId: string | null };
      revokedAt: Date;
    }): Promise<OAuthCredentialEventResult> {
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const clientFilter = input.firstPartyOnly
          ? executor
              .select({ id: oauthClients.id })
              .from(oauthClients)
              .where(eq(oauthClients.isFirstParty, true))
          : undefined;

        await executor
          .update(oauthAuthCodes)
          .set({ consumedAt: input.revokedAt })
          .where(
            and(
              eq(oauthAuthCodes.userId, input.userId),
              isNull(oauthAuthCodes.consumedAt),
              clientFilter ? inArray(oauthAuthCodes.clientId, clientFilter) : undefined,
            ),
          );

        const revoked = await executor
          .update(oauthGrants)
          .set({ revokedAt: input.revokedAt })
          .where(
            and(
              eq(oauthGrants.userId, input.userId),
              isNull(oauthGrants.revokedAt),
              clientFilter ? inArray(oauthGrants.clientId, clientFilter) : undefined,
              input.exceptGrantId ? ne(oauthGrants.id, input.exceptGrantId) : undefined,
            ),
          )
          .returning({ id: oauthGrants.id, clientRowId: oauthGrants.clientId });

        // The caller grant's OTHER installs (sign-out-everywhere from an app).
        // IDEMPOTENCY KEY: the family id under `revoked_at IS NULL` — a replay
        // claims nothing, so each family is announced and audited once.
        let families: OAuthTokenFamilyRow[] = [];
        if (input.siblingFamilies && input.exceptGrantId) {
          const keptGrant = executor
            .select({ id: oauthGrants.id })
            .from(oauthGrants)
            .where(
              and(
                eq(oauthGrants.id, input.exceptGrantId),
                eq(oauthGrants.userId, input.userId),
                isNull(oauthGrants.revokedAt),
                clientFilter ? inArray(oauthGrants.clientId, clientFilter) : undefined,
              ),
            );
          const keep = input.siblingFamilies.keepFamilyId;
          families = await revokeFamilies(
            executor,
            and(
              eq(oauthTokenFamilies.grantId, input.exceptGrantId),
              inArray(oauthTokenFamilies.grantId, keptGrant),
              keep ? ne(oauthTokenFamilies.id, keep) : undefined,
            )!,
            'sign_out_everywhere',
            input.revokedAt,
          );
        }
        if (revoked.length === 0) return { grants: [], families };
        // Their sealed pairs go in the same transaction (review S3).
        await clearGrantEnvelopes(
          executor,
          revoked.map((grant) => grant.id),
        );

        const clients = await executor
          .select({ id: oauthClients.id, clientId: oauthClients.clientId })
          .from(oauthClients)
          .where(
            inArray(
              oauthClients.id,
              revoked.map((grant) => grant.clientRowId),
            ),
          );
        const publicId = new Map(clients.map((client) => [client.id, client.clientId]));
        const grants = revoked
          .map((grant) => ({
            grantId: grant.id,
            clientId: publicId.get(grant.clientRowId) ?? grant.clientRowId,
          }))
          .sort((a, b) => a.grantId.localeCompare(b.grantId));
        return { grants, families };
      });
    },

    async touchGrantLastUsed(grantId: string, at: Date): Promise<void> {
      await db.update(oauthGrants).set({ lastUsedAt: at }).where(eq(oauthGrants.id, grantId));
    },

    /**
     * Stamp an access token's FIRST successful authentication (§16 2026-10-29,
     * migration 0121). Written once, by primary key, and never rewritten:
     * IDEMPOTENCY KEY the access-token id, guarded by `first_used_at IS NULL`,
     * so a concurrent second request (or a replay) changes nothing. The
     * first-party re-serve reads this to tell an unused successor pair from
     * one somebody has already acted on.
     */
    async markAccessTokenFirstUsed(id: string, at: Date): Promise<void> {
      await db
        .update(oauthAccessTokens)
        .set({ firstUsedAt: at })
        .where(and(eq(oauthAccessTokens.id, id), isNull(oauthAccessTokens.firstUsedAt)));
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
        // ── token families (§16 2026-10-29): a revoked family rejects its
        // access tokens like a revoked grant does. LEFT so a legacy NULL-family
        // row (the family is the grant) still resolves while the grant is live.
        .leftJoin(oauthTokenFamilies, eq(oauthTokenFamilies.id, oauthAccessTokens.familyId))
        .where(
          and(
            eq(oauthAccessTokens.tokenHash, tokenHash),
            isNull(oauthGrants.revokedAt),
            isNull(oauthTokenFamilies.revokedAt),
          ),
        )
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

    /**
     * Resolve a refresh token by hash joined to its grant + owning user (any
     * grant state) and its successor row. `now` is the caller's clock: a
     * consumed row past the grace window has its envelope nulled by this read.
     */
    async findRefreshTokenByHash(
      tokenHash: string,
      now: Date,
    ): Promise<OAuthRefreshTokenLookup | undefined> {
      return readRefreshToken(db, eq(oauthRefreshTokens.tokenHash, tokenHash), now);
    },

    /**
     * Consume one refresh token and insert its replacement pair in the same
     * transaction, recording the successor link and its sealed response on the
     * consumed row (idempotency key: the consumed row id — the atomic
     * `consumed_at IS NULL` claim lets exactly one transaction write them).
     *
     * A caller that loses the atomic consume to a concurrent rotation does NOT
     * revoke anything: both callers presented the token while it was current,
     * which is a race, not reuse. It re-reads the row instead and hands it back
     * so the service can apply the grace rule to the winner's pair.
     */
    async rotateRefreshToken(
      input: RotateOAuthRefreshTokenInput,
    ): Promise<OAuthRefreshTokenRotation> {
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        // ── LOCK ORDER: grant → family → token rows (§16 2026-10-29) ─────────
        // Every OAuth writer that touches more than one of these takes them in
        // this order: the code exchange (`findActiveGrant FOR UPDATE` → its
        // `relogin` retire → token inserts), every family revoke (family row →
        // that family's token rows, `revokeFamilies`) and this rotation. A
        // rotation that took the family LAST — after locking the consumed row
        // and its predecessor — deadlocked against a concurrent revoke, which
        // holds the family and then wants exactly those token rows (and a
        // deadlock victim on the revoke side is a logout that answered 500
        // and left the family live). So both rows are locked up front, and the
        // same two statements refuse a grant or family revoked meanwhile: no
        // pair is ever minted into a dead grant or family.
        const [liveGrant] = await executor
          .update(oauthGrants)
          .set({ lastUsedAt: input.rotatedAt })
          .where(and(eq(oauthGrants.id, input.grantId), isNull(oauthGrants.revokedAt)))
          .returning({ id: oauthGrants.id });
        if (!liveGrant) return { outcome: 'revoked' };
        if (input.familyId) {
          // An UPDATE, not a bare read: it takes the family's row lock (the same
          // lock a revoke takes) and re-checks `revoked_at` on the newest row
          // version once a concurrent revoke commits.
          const [liveFamily] = await executor
            .update(oauthTokenFamilies)
            .set({ lastUsedAt: input.rotatedAt })
            .where(
              and(
                eq(oauthTokenFamilies.id, input.familyId),
                eq(oauthTokenFamilies.grantId, input.grantId),
                isNull(oauthTokenFamilies.revokedAt),
              ),
            )
            .returning({ id: oauthTokenFamilies.id });
          if (!liveFamily) return { outcome: 'revoked' };
        }

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
          // A fresh statement, so a fresh READ COMMITTED snapshot: the UPDATE
          // above blocked on the winner's row lock and re-evaluated after its
          // commit, so the successor link + envelope it wrote are visible here.
          const current = await readRefreshToken(
            executor,
            eq(oauthRefreshTokens.id, input.tokenId),
            input.rotatedAt,
          );
          return { outcome: 'replayed', current };
        }

        // Both successor rows inherit the consumed token's family (§16 2026-10-29).
        const [accessToken] = await executor
          .insert(oauthAccessTokens)
          .values({ grantId: input.grantId, familyId: input.familyId, ...input.accessToken })
          .returning({ id: oauthAccessTokens.id });
        if (!accessToken) throw new Error('Failed to insert OAuth access token');

        const [refreshToken] = await executor
          .insert(oauthRefreshTokens)
          .values({ grantId: input.grantId, familyId: input.familyId, ...input.refreshToken })
          .returning({ id: oauthRefreshTokens.id });
        if (!refreshToken) throw new Error('Failed to insert OAuth refresh token');

        await executor
          .update(oauthRefreshTokens)
          .set({
            successorId: refreshToken.id,
            successorEnvelope: input.sealSuccessor({
              tokenId: input.tokenId,
              successorId: refreshToken.id,
              accessTokenId: accessToken.id,
            }),
          })
          .where(eq(oauthRefreshTokens.id, input.tokenId));

        // The token consumed above was itself the successor of its predecessor,
        // whose envelope re-serves THIS token's pair. That pair is no longer the
        // current one, so the predecessor's grace ends here, in this transaction,
        // rather than at the end of its window.
        await executor
          .update(oauthRefreshTokens)
          .set({ successorEnvelope: null })
          .where(
            and(
              eq(oauthRefreshTokens.successorId, input.tokenId),
              isNotNull(oauthRefreshTokens.successorEnvelope),
            ),
          );

        // (grant + family `last_used_at` were stamped by the lock statements above.)
        return { outcome: 'rotated' };
      });
    },

    /**
     * Sweep step (`data.retentionCleanup`, and best-effort after every
     * successful rotation): null at most `limit` envelopes whose re-serve
     * window has passed at `now`. The window follows each row's OWN client,
     * exactly like the read path ({@link oauthRefreshReplayWindowSeconds}):
     * a third-party row goes once it was consumed more than 60 s before `now`,
     * an official first-party row only once it was consumed more than 24 h
     * before `now` — inside that, its sealed pair may still be re-served
     * (§16 2026-10-29). Envelope lifetime is otherwise enforced on read and on
     * the successor's rotation; this catches the rows nobody touches again.
     * Walks the partial `oauth_refresh_tokens_live_envelope_idx`. Resolves to
     * how many envelopes were cleared; idempotent.
     */
    async clearExpiredSuccessorEnvelopes(now: Date, limit: number): Promise<number> {
      const strictCutoff = new Date(now.getTime() - oauthRefreshReplayWindowSeconds(false) * 1000);
      const firstPartyCutoff = new Date(
        now.getTime() - oauthRefreshReplayWindowSeconds(true) * 1000,
      );
      const candidates = db
        .select({ id: oauthRefreshTokens.id })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthRefreshTokens.grantId, oauthGrants.id))
        .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
        .where(
          and(
            isNotNull(oauthRefreshTokens.successorEnvelope),
            lt(oauthRefreshTokens.consumedAt, strictCutoff),
            or(
              eq(oauthClients.isFirstParty, false),
              lt(oauthRefreshTokens.consumedAt, firstPartyCutoff),
            ),
          ),
        )
        .orderBy(asc(oauthRefreshTokens.consumedAt), asc(oauthRefreshTokens.id))
        .limit(limit);
      const cleared = await db
        .update(oauthRefreshTokens)
        .set({ successorEnvelope: null })
        .where(
          and(
            inArray(oauthRefreshTokens.id, candidates),
            isNotNull(oauthRefreshTokens.successorEnvelope),
          ),
        )
        .returning({ id: oauthRefreshTokens.id });
      return cleared.length;
    },
  };
}

export type OAuthRepository = ReturnType<typeof createOAuthRepository>;
