import { z } from 'zod';

/**
 * Social contracts (PROJECTPLAN.md §6.9). Friend requests + friendships.
 *
 * Privacy: `FriendUser` is the only user shape ever returned by a social
 * endpoint and carries **id + username only** — email is an input identifier
 * (§6.9 "username or email"), never echoed back. Request creation reveals
 * nothing about whether the target exists (no-enumeration is enforced in the
 * service layer, a later P5 package).
 */

/** Lifecycle of a friend request (§5.5). */
export const FRIEND_REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'cancelled'] as const;
export const friendRequestStatusSchema = z.enum(FRIEND_REQUEST_STATUSES);
export type FriendRequestStatus = z.infer<typeof friendRequestStatusSchema>;

/** Whether a pending request was received by (`incoming`) or sent by (`outgoing`) the viewer. */
export const friendRequestDirectionSchema = z.enum(['incoming', 'outgoing']);
export type FriendRequestDirection = z.infer<typeof friendRequestDirectionSchema>;

/** Public-safe view of a user in the social graph — never includes email (§6.9). */
export const friendUserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string(),
  })
  .strict();
export type FriendUser = z.infer<typeof friendUserSchema>;

/**
 * A friend request as seen by the viewer. `direction` tells the viewer whether
 * they received or sent it; `user` is the *other* party (sender for incoming,
 * recipient for outgoing).
 */
export const friendRequestSchema = z
  .object({
    id: z.string().uuid(),
    direction: friendRequestDirectionSchema,
    status: friendRequestStatusSchema,
    user: friendUserSchema,
    createdAt: z.string().datetime(),
    respondedAt: z.string().datetime().nullable(),
  })
  .strict();
export type FriendRequest = z.infer<typeof friendRequestSchema>;

/** An established friendship as seen by the viewer — the other party + when it formed. */
export const friendshipSchema = z
  .object({
    user: friendUserSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type Friendship = z.infer<typeof friendshipSchema>;

/**
 * `POST /social/requests` body — the target by username or email (§6.9). A
 * single free-form identifier; the service resolves and never enumerates.
 */
export const createFriendRequestRequestSchema = z
  .object({ identifier: z.string().min(1).max(320) })
  .strict();
export type CreateFriendRequestRequest = z.infer<typeof createFriendRequestRequestSchema>;

/** `GET /social/requests` response — pending requests split by direction. */
export const friendRequestListResponseSchema = z
  .object({
    incoming: z.array(friendRequestSchema),
    outgoing: z.array(friendRequestSchema),
  })
  .strict();
export type FriendRequestListResponse = z.infer<typeof friendRequestListResponseSchema>;

/** `GET /social/friends` response. */
export const friendsListResponseSchema = z.object({ friends: z.array(friendshipSchema) }).strict();
export type FriendsListResponse = z.infer<typeof friendsListResponseSchema>;
