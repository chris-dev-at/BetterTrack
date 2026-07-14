import { and, eq, sql } from 'drizzle-orm';

import type { ShareKind } from '@bettertrack/contracts';

import type { Database } from '../db';
import { sharedItemActivityPrefs, users } from '../schema';

/**
 * Public-profile settings + per-viewer activity-alert preferences (§6.9, §14,
 * V3-P6). Thin persistence over the two additive columns on `users`
 * (`profile_public`, `profile_bio`) and the `shared_item_activity_prefs` store.
 *
 * The profile itself introduces NO new privacy path: which items a public
 * profile shows is decided entirely by the #332 audience model (only
 * `public_link` items), read through {@link ShareAudienceRepository}. This repo
 * only owns the opt-in flag, the bio line, the username→owner slug resolution
 * (active + opted-in), and the activity-pref rows.
 */

/** The owner-facing profile state. */
export interface ProfileSettings {
  username: string;
  isPublic: boolean;
  bio: string | null;
}

/** A resolved public-profile owner (only returned when active AND opted-in). */
export interface PublicProfileOwner {
  ownerId: string;
  username: string;
  bio: string | null;
}

export function createProfileRepository(db: Database) {
  return {
    /** The caller's own profile settings, or `undefined` if the user vanished. */
    async getProfileSettings(ownerId: string): Promise<ProfileSettings | undefined> {
      const [row] = await db
        .select({
          username: users.username,
          isPublic: users.profilePublic,
          bio: users.profileBio,
        })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      return row
        ? { username: row.username, isPublic: row.isPublic, bio: row.bio ?? null }
        : undefined;
    },

    /** Update the caller's profile opt-in + bio. */
    async updateProfileSettings(
      ownerId: string,
      input: { isPublic: boolean; bio: string | null },
    ): Promise<void> {
      await db
        .update(users)
        .set({ profilePublic: input.isPublic, profileBio: input.bio, updatedAt: new Date() })
        .where(eq(users.id, ownerId));
    },

    /**
     * Resolve a username slug to its owner — but ONLY when the account is active
     * AND its profile is currently public. A disabled/unknown user, or one whose
     * profile is opted-out, resolves to `undefined` (→ 404), so disabling a
     * profile 404s the slug instantly and no existence leaks. Username match is
     * case-insensitive (mirrors the unique index).
     */
    async findPublicProfileOwner(username: string): Promise<PublicProfileOwner | undefined> {
      const needle = username.trim().toLowerCase();
      const [row] = await db
        .select({ ownerId: users.id, username: users.username, bio: users.profileBio })
        .from(users)
        .where(
          and(
            sql`lower(${users.username}) = ${needle}`,
            eq(users.status, 'active'),
            eq(users.profilePublic, true),
          ),
        )
        .limit(1);
      return row
        ? { ownerId: row.ownerId, username: row.username, bio: row.bio ?? null }
        : undefined;
    },

    /**
     * Whether the owner's public profile is currently enabled. The
     * `follow.published` fan-out gates on this (#438): a newly-public item is
     * only reachable by a follower through the `/u/:username` profile page — they
     * hold no share link — so the notification's deep link 404s unless the
     * profile resolves. A vanished user reads as not-public.
     */
    async isProfilePublic(ownerId: string): Promise<boolean> {
      const [row] = await db
        .select({ isPublic: users.profilePublic })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      return row?.isPublic ?? false;
    },

    /**
     * The set of items the viewer has enabled activity alerts for, as
     * `"<kind>:<subjectId>"` keys — used to stamp `activityAlertsEnabled` onto the
     * Shared-With-Me summaries without an N+1.
     */
    async listActivityPrefs(viewerId: string): Promise<Set<string>> {
      const rows = await db
        .select({
          kind: sharedItemActivityPrefs.kind,
          subjectId: sharedItemActivityPrefs.subjectId,
        })
        .from(sharedItemActivityPrefs)
        .where(eq(sharedItemActivityPrefs.viewerId, viewerId));
      return new Set(rows.map((r) => `${r.kind}:${r.subjectId}`));
    },

    /**
     * Every viewer who opted into activity alerts for one item (#368 — the
     * friend-activity producer's fan-out set). The pref alone never authorizes:
     * the producer re-checks each viewer against the audience layer at emit
     * time, so a pref that outlived a revoked share notifies nobody.
     */
    async viewersWithActivityAlerts(kind: ShareKind, subjectId: string): Promise<string[]> {
      const rows = await db
        .select({ viewerId: sharedItemActivityPrefs.viewerId })
        .from(sharedItemActivityPrefs)
        .where(
          and(
            eq(sharedItemActivityPrefs.kind, kind),
            eq(sharedItemActivityPrefs.subjectId, subjectId),
          ),
        );
      return rows.map((r) => r.viewerId);
    },

    /** Whether the viewer currently has an activity-alert pref for one item. */
    async hasActivityPref(viewerId: string, kind: ShareKind, subjectId: string): Promise<boolean> {
      const [row] = await db
        .select({ subjectId: sharedItemActivityPrefs.subjectId })
        .from(sharedItemActivityPrefs)
        .where(
          and(
            eq(sharedItemActivityPrefs.viewerId, viewerId),
            eq(sharedItemActivityPrefs.kind, kind),
            eq(sharedItemActivityPrefs.subjectId, subjectId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /** Set (presence = opt-in) or clear the viewer's activity-alert pref for one item. */
    async setActivityPref(
      viewerId: string,
      kind: ShareKind,
      subjectId: string,
      enabled: boolean,
    ): Promise<void> {
      if (enabled) {
        await db
          .insert(sharedItemActivityPrefs)
          .values({ viewerId, kind, subjectId })
          .onConflictDoNothing();
      } else {
        await db
          .delete(sharedItemActivityPrefs)
          .where(
            and(
              eq(sharedItemActivityPrefs.viewerId, viewerId),
              eq(sharedItemActivityPrefs.kind, kind),
              eq(sharedItemActivityPrefs.subjectId, subjectId),
            ),
          );
      }
    },
  };
}

export type ProfileRepository = ReturnType<typeof createProfileRepository>;
