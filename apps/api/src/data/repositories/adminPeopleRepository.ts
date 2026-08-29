import { and, count, desc, eq, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  adminUserNotes,
  apiKeys,
  conglomerates,
  externalIdentities,
  feedback,
  friendships,
  oauthClients,
  oauthGrants,
  portfolios,
  shareAudiences,
  shareLinks,
  userFollows,
  users,
} from '../schema';

/**
 * Every SQL read behind the People 360 detail page (#1406 W2), plus the operator
 * notes it owns.
 *
 * It lives apart from `userRepository` on purpose: these queries reach across
 * eight tables that have nothing to do with the `users` row itself, and the
 * privacy rules they enforce are the interesting part. Each one is written to
 * return the SMALLEST answer that resolves a support question — a count, a
 * label, a timestamp — never a name, a token, a provider subject, or anything
 * that came out of a portfolio (§3, §6.12, and the #1406 kill list).
 */

/** What "open" means for a support thread — the same predicate the 20-submission
 *  cap enforces, so the operator's number and the user's limit never disagree. */
const OPEN_FEEDBACK = sql`${feedback.status} not in ('declined', 'shipped')`;

export interface AdminUserApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface AdminUserOAuthGrantRow {
  id: string;
  clientName: string;
  firstParty: boolean;
  scopes: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface AdminUserIdentityRow {
  provider: string;
  emailVerified: boolean;
  linkedAt: Date;
}

export interface AdminUserSharingCounts {
  portfolioCount: number;
  sharedPortfolioCount: number;
  shareAudienceCount: number;
  activeShareLinkCount: number;
  revokedShareLinkCount: number;
  friendCount: number;
  followerCount: number;
  followingCount: number;
}

export interface AdminUserSupportRow {
  id: string;
  category: string;
  subject: string | null;
  status: string;
  deletedByUser: boolean;
  archived: boolean;
  unreadByAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserNoteRow {
  id: string;
  body: string;
  authorId: string | null;
  authorUsername: string | null;
  createdAt: Date;
}

export function createAdminPeopleRepository(db: Database) {
  return {
    /** This account's API keys, revoked ones included — a revoked key is part of
     *  the support story ("I revoked it yesterday and it still works"). */
    async apiKeysFor(userId: string): Promise<AdminUserApiKeyRow[]> {
      return db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId))
        .orderBy(desc(apiKeys.createdAt));
    },

    /**
     * OAuth grants with the app's display name. `isFirstParty` travels because
     * "BetterTrack Mobile" and a stranger's app are completely different
     * findings on a support call, and the name alone does not say which is which.
     */
    async oauthGrantsFor(userId: string): Promise<AdminUserOAuthGrantRow[]> {
      return db
        .select({
          id: oauthGrants.id,
          clientName: oauthClients.name,
          firstParty: oauthClients.isFirstParty,
          scopes: oauthGrants.scopes,
          lastUsedAt: oauthGrants.lastUsedAt,
          revokedAt: oauthGrants.revokedAt,
          createdAt: oauthGrants.createdAt,
        })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
        .where(eq(oauthGrants.userId, userId))
        .orderBy(desc(oauthGrants.createdAt));
    },

    /**
     * Linked external identities. The select is explicit rather than `select()`
     * precisely so `subject` and the provider `email` cannot leak into an admin
     * response by someone later adding a column.
     */
    async identitiesFor(userId: string): Promise<AdminUserIdentityRow[]> {
      return db
        .select({
          provider: externalIdentities.provider,
          emailVerified: externalIdentities.emailVerified,
          linkedAt: externalIdentities.createdAt,
        })
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, userId))
        .orderBy(externalIdentities.provider);
    },

    /**
     * How exposed this account is, as COUNTS ONLY. Nothing here names a
     * portfolio, a friend or a share token: the sharing inventory is deferred by
     * the #1406 decision and browsing a user's portfolios is forbidden outright,
     * so the honest answer to "is this account sharing anything?" is a number.
     */
    async sharingCountsFor(userId: string): Promise<AdminUserSharingCounts> {
      const [portfolioRow] = await db
        .select({ value: count() })
        .from(portfolios)
        .where(eq(portfolios.userId, userId));
      // `friends` is the widest a portfolio ever gets: the visibility enum is
      // `private | friends`, and nothing in the product makes one public.
      const [sharedPortfolioRow] = await db
        .select({ value: count() })
        .from(portfolios)
        .where(and(eq(portfolios.userId, userId), eq(portfolios.visibility, 'friends')));
      // `private` audiences are the default and mean "shared with nobody" — only
      // the widened ones are exposure.
      const [audienceRow] = await db
        .select({ value: count() })
        .from(shareAudiences)
        .where(
          and(eq(shareAudiences.ownerId, userId), sql`${shareAudiences.audience} <> 'private'`),
        );
      const [activeLinkRow] = await db
        .select({ value: count() })
        .from(shareLinks)
        .innerJoin(conglomerates, eq(shareLinks.conglomerateId, conglomerates.id))
        .where(and(eq(conglomerates.ownerId, userId), isNull(shareLinks.revokedAt)));
      const [revokedLinkRow] = await db
        .select({ value: count() })
        .from(shareLinks)
        .innerJoin(conglomerates, eq(shareLinks.conglomerateId, conglomerates.id))
        .where(and(eq(conglomerates.ownerId, userId), sql`${shareLinks.revokedAt} is not null`));
      // Friendship rows are stored once per pair in canonical (a < b) order, so
      // the account can sit on either side.
      const [friendRow] = await db
        .select({ value: count() })
        .from(friendships)
        .where(or(eq(friendships.userA, userId), eq(friendships.userB, userId)));
      const [followerRow] = await db
        .select({ value: count() })
        .from(userFollows)
        .where(eq(userFollows.followedId, userId));
      const [followingRow] = await db
        .select({ value: count() })
        .from(userFollows)
        .where(eq(userFollows.followerId, userId));

      return {
        portfolioCount: portfolioRow?.value ?? 0,
        sharedPortfolioCount: sharedPortfolioRow?.value ?? 0,
        shareAudienceCount: audienceRow?.value ?? 0,
        activeShareLinkCount: activeLinkRow?.value ?? 0,
        revokedShareLinkCount: revokedLinkRow?.value ?? 0,
        friendCount: friendRow?.value ?? 0,
        followerCount: followerRow?.value ?? 0,
        followingCount: followingRow?.value ?? 0,
      };
    },

    /**
     * This account's support submissions, newest first. The message BODY is
     * deliberately not selected: the thread is the helpdesk's surface (W3), and
     * a detail page that cannot reply has no business rendering support prose.
     *
     * `unreadByAdmin` reproduces the helpdesk's own rule — a thread is unread
     * while its last activity postdates the admin's last read stamp, and a
     * never-read thread counts as unread.
     */
    async supportFor(
      userId: string,
      limit: number,
    ): Promise<{ rows: AdminUserSupportRow[]; total: number; openCount: number }> {
      const rows = await db
        .select({
          id: feedback.id,
          category: feedback.category,
          subject: feedback.subject,
          status: feedback.status,
          deletedByUserAt: feedback.deletedByUserAt,
          archivedAt: feedback.archivedAt,
          adminLastReadAt: feedback.adminLastReadAt,
          createdAt: feedback.createdAt,
          updatedAt: feedback.updatedAt,
        })
        .from(feedback)
        .where(eq(feedback.userId, userId))
        .orderBy(desc(feedback.createdAt), desc(feedback.id))
        .limit(limit);

      const [totalRow] = await db
        .select({ value: count() })
        .from(feedback)
        .where(eq(feedback.userId, userId));
      const [openRow] = await db
        .select({ value: count() })
        .from(feedback)
        .where(and(eq(feedback.userId, userId), isNull(feedback.deletedByUserAt), OPEN_FEEDBACK));

      return {
        rows: rows.map((row) => ({
          id: row.id,
          category: row.category,
          subject: row.subject,
          status: row.status,
          deletedByUser: row.deletedByUserAt !== null,
          archived: row.archivedAt !== null,
          unreadByAdmin:
            row.adminLastReadAt === null || row.updatedAt.getTime() > row.adminLastReadAt.getTime(),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        total: totalRow?.value ?? 0,
        openCount: openRow?.value ?? 0,
      };
    },

    /** Operator notes for one account, newest first. */
    async listNotes(userId: string, limit: number): Promise<AdminUserNoteRow[]> {
      return db
        .select({
          id: adminUserNotes.id,
          body: adminUserNotes.body,
          authorId: adminUserNotes.authorId,
          authorUsername: users.username,
          createdAt: adminUserNotes.createdAt,
        })
        .from(adminUserNotes)
        .leftJoin(users, eq(adminUserNotes.authorId, users.id))
        .where(eq(adminUserNotes.userId, userId))
        .orderBy(desc(adminUserNotes.createdAt), desc(adminUserNotes.id))
        .limit(limit);
    },

    async createNote(input: {
      userId: string;
      authorId: string;
      body: string;
    }): Promise<AdminUserNoteRow> {
      const [row] = await db
        .insert(adminUserNotes)
        .values({ userId: input.userId, authorId: input.authorId, body: input.body })
        .returning({
          id: adminUserNotes.id,
          body: adminUserNotes.body,
          authorId: adminUserNotes.authorId,
          createdAt: adminUserNotes.createdAt,
        });
      if (!row) throw new Error('Failed to insert an operator note.');
      const [author] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, input.authorId))
        .limit(1);
      return { ...row, authorUsername: author?.username ?? null };
    },

    /**
     * Delete one note. Scoped by BOTH ids: a note id alone would let a
     * mistyped/stale user id delete a note off a different account, and the
     * route's 404 must mean "not on this account" rather than "somewhere else".
     */
    async deleteNote(userId: string, noteId: string): Promise<boolean> {
      const deleted = await db
        .delete(adminUserNotes)
        .where(and(eq(adminUserNotes.id, noteId), eq(adminUserNotes.userId, userId)))
        .returning({ id: adminUserNotes.id });
      return deleted.length > 0;
    },
  };
}

export type AdminPeopleRepository = ReturnType<typeof createAdminPeopleRepository>;
