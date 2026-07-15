import {
  CHAT_BANNED_ERROR_CODE,
  type ChatChip,
  type ChatChipKind,
  type ChatConversation,
  type ChatConversationListResponse,
  type ChatMessage,
  type ChatThreadResponse,
  type SendChatMessageRequest,
  type ShareKind,
} from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type {
  ChatConversationRow,
  ChatMessageRow,
  ChatRepository,
  ConversationParticipants,
} from '../../data/repositories/chatRepository';
import type { FriendshipRepository } from '../../data/repositories/friendshipRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { EventBus } from '../../events';
import { badRequest, forbidden, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { NotificationCenter } from '../notifications/notificationCenter';
import type { AudienceService } from '../social/audienceService';

/**
 * Friend chat (PROJECTPLAN.md §13.3 V3-P8): 1:1 DMs, unread badges, realtime
 * delivery over the §4.5 gateway, and share-in-chat chips. The handlers stay
 * thin; every privacy rule lives here:
 *
 *  - **Friends only.** Opening a conversation requires a current friendship
 *    (a non-friend 404s — never data); a conversation is unique per pair.
 *  - **Participant gate.** Reading/marking/sending against a conversation you're
 *    not part of 404s uniformly (no existence leak, §10).
 *  - **Unfriending closes the thread.** History stays readable, but sending to a
 *    former friend is refused (403) — the thread is closed to new messages.
 *  - **Share-in-chat is never a back-door.** A chip is stored as a bare
 *    `(kind, subjectId)` reference; a sender may only chip an item they own (or a
 *    visible asset), and storing it writes nothing to the audience model — so
 *    sending never grants or widens access. Every chip is re-resolved **per
 *    viewer at read time** through the ONE sharing-enforcement layer (#332): a
 *    recipient sees the item only if its audience already admits them, otherwise
 *    a "not shared with you" state that carries no name and no data.
 */

const PREVIEW_MAX = 140;
const DEFAULT_THREAD_LIMIT = 40;

export interface ChatServiceDeps {
  repo: ChatRepository;
  friendship: FriendshipRepository;
  /** Chat-ban check on the send path (§13.4 V4-P0d) — read fresh, no cache. */
  users: Pick<UserRepository, 'findById'>;
  /** The ONE sharing-enforcement layer (#332) — chip resolution routes through it. */
  audience: AudienceService;
  /** §10 asset visibility for `asset` chips (global or the viewer's own custom asset). */
  assets: Pick<AssetRepository, 'findByIdForUser'>;
  /** Ephemeral bus (§4.5): carries ONLY the gateway's in-thread realtime push. */
  events: EventBus;
  /** The central notification pipeline (#368): the durable bell/email/push leg. */
  notify: NotificationCenter;
  logger?: Logger;
}

export interface ChatService {
  /** Open (or resolve) the 1:1 conversation with a friend. Non-friend → 404. */
  openConversation(userId: string, friendUserId: string): Promise<ChatConversation>;
  /** The caller's conversations, newest-active first, with a total unread badge. */
  listConversations(userId: string): Promise<ChatConversationListResponse>;
  /** A page of a thread + its summary. Non-participant → 404. */
  getThread(
    userId: string,
    conversationId: string,
    params: { cursor?: string; limit?: number },
  ): Promise<ChatThreadResponse>;
  /** Send a message. Non-participant → 404; former friend → 403 (thread closed). */
  sendMessage(
    userId: string,
    conversationId: string,
    input: SendChatMessageRequest,
  ): Promise<ChatMessage>;
  /** Mark a thread read for the caller. Non-participant → 404. */
  markRead(userId: string, conversationId: string): Promise<void>;
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { repo, friendship, users, audience, assets, events, notify, logger } = deps;

  /** Whether `userId` is one of the conversation's participants. The gate keys on
   * the CALLER's side only, so a deleted other side (#362) keeps history readable. */
  function isParticipant(participants: ConversationParticipants, userId: string): boolean {
    return participants.userA === userId || participants.userB === userId;
  }

  /** The other participant — `null` when that account was deleted (#362). Only
   * meaningful after {@link isParticipant} has admitted the caller. */
  function otherParticipant(participants: ConversationParticipants, userId: string): string | null {
    return participants.userA === userId ? participants.userB : participants.userA;
  }

  function toConversation(row: ChatConversationRow): ChatConversation {
    return {
      id: row.id,
      // A deleted other side serializes as `user: null` — the client renders its
      // localized "Deleted user" state (#362); no identity survives.
      user:
        row.otherUserId !== null && row.otherUsername !== null
          ? { id: row.otherUserId, username: row.otherUsername }
          : null,
      unreadCount: row.unreadCount,
      lastMessage: row.lastMessage
        ? {
            senderId: row.lastMessage.senderId,
            body: row.lastMessage.body,
            chipKind: row.lastMessage.chipKind,
            createdAt: row.lastMessage.createdAt.toISOString(),
          }
        : null,
      lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    };
  }

  /**
   * Resolve one chip FOR A SPECIFIC VIEWER through the enforcement layer (#332).
   * `viewable: false` carries no title/subtitle — an unauthorized recipient never
   * learns even the item's name.
   */
  async function resolveChip(
    viewerId: string,
    kind: ChatChipKind,
    subjectId: string,
  ): Promise<ChatChip> {
    const notViewable: ChatChip = { kind, subjectId, viewable: false, title: null, subtitle: null };

    if (kind === 'asset') {
      // Global market asset or the viewer's own custom asset; a foreign custom
      // asset resolves to null — indistinguishable from missing (§10 no-leak).
      const asset = await assets.findByIdForUser(subjectId, viewerId).catch(() => null);
      return asset
        ? { kind, subjectId, viewable: true, title: asset.symbol, subtitle: asset.name }
        : notViewable;
    }

    // Shareable kinds — the enforcement layer decides, recomputed now (no cache).
    const shareKind: ShareKind = kind;

    // The owner (sender) always sees their own item; a non-owner falls through to
    // the audience authorization below.
    if (await audience.ownsSubject(viewerId, shareKind, subjectId).catch(() => false)) {
      const identity = await audience.subjectIdentity(shareKind, subjectId).catch(() => undefined);
      return identity
        ? { kind, subjectId, viewable: true, title: identity.name, subtitle: null }
        : notViewable;
    }

    if (shareKind === 'portfolio') {
      const ref = await audience.authorizePortfolioRead(viewerId, subjectId).catch(() => undefined);
      return ref
        ? { kind, subjectId, viewable: true, title: ref.name, subtitle: ref.ownerUsername }
        : notViewable;
    }
    if (shareKind === 'watchlist') {
      const ref = await audience.authorizeWatchlistRead(viewerId, subjectId).catch(() => undefined);
      return ref
        ? { kind, subjectId, viewable: true, title: ref.name, subtitle: ref.ownerUsername }
        : notViewable;
    }
    // conglomerate — the authorization returns the owner only; fetch the name
    // ONLY after it passes, so a denied read discloses nothing.
    const ref = await audience
      .authorizeConglomerateRead(viewerId, subjectId)
      .catch(() => undefined);
    if (!ref) return notViewable;
    const identity = await audience
      .subjectIdentity('conglomerate', subjectId)
      .catch(() => undefined);
    return {
      kind,
      subjectId,
      viewable: true,
      title: identity?.name ?? null,
      subtitle: ref.ownerUsername,
    };
  }

  async function toMessage(viewerId: string, row: ChatMessageRow): Promise<ChatMessage> {
    const chip =
      row.chipKind && row.chipSubjectId
        ? await resolveChip(viewerId, row.chipKind, row.chipSubjectId)
        : null;
    return {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      body: row.body,
      chip,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Whether a sender may attach a chip: they own the shareable, or can see the asset. */
  async function senderMayReference(
    senderId: string,
    kind: ChatChipKind,
    subjectId: string,
  ): Promise<boolean> {
    if (kind === 'asset') {
      return Boolean(await assets.findByIdForUser(subjectId, senderId).catch(() => null));
    }
    return audience.ownsSubject(senderId, kind, subjectId).catch(() => false);
  }

  return {
    async openConversation(userId, friendUserId) {
      // Friends only, recomputed now — a non-friend (and self) 404s (never data).
      if (!(await friendship.areFriends(userId, friendUserId))) {
        throw notFound('Conversation not found.');
      }
      const conversationId = await repo.getOrCreateConversation(userId, friendUserId);
      const [summary] = await repo.getConversationSummaries(userId, conversationId);
      if (!summary) throw notFound('Conversation not found.');
      return toConversation(summary);
    },

    async listConversations(userId) {
      const rows = await repo.getConversationSummaries(userId);
      const conversations = rows.map(toConversation);
      const unreadTotal = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
      return { conversations, unreadTotal };
    },

    async getThread(userId, conversationId, params) {
      const participants = await repo.findParticipants(conversationId);
      if (!participants || !isParticipant(participants, userId)) {
        throw notFound('Conversation not found.');
      }
      const [summary] = await repo.getConversationSummaries(userId, conversationId);
      if (!summary) throw notFound('Conversation not found.');

      const limit = params.limit ?? DEFAULT_THREAD_LIMIT;
      const { rows, nextCursor } = await repo.listMessages(conversationId, {
        limit,
        cursor: params.cursor,
      });
      const messages = await Promise.all(rows.map((row) => toMessage(userId, row)));
      return { conversation: toConversation(summary), messages, nextCursor };
    },

    async sendMessage(userId, conversationId, input) {
      const participants = await repo.findParticipants(conversationId);
      if (!participants || !isParticipant(participants, userId)) {
        throw notFound('Conversation not found.');
      }
      // Admin chat ban (§13.4 V4-P0d): a banned sender is refused with a stable
      // CHAT_BANNED code (403) for a cookie session and a `chat:write` bearer token
      // alike — the handler is scope-gated, the ban is enforced here on the send
      // path only. Read fresh every send, so an unban restores sending instantly.
      const sender = await users.findById(userId);
      if (sender?.chatBanned) {
        throw forbidden('You cannot send messages.', CHAT_BANNED_ERROR_CODE);
      }
      // Unfriending closes the thread to new messages (history stays readable);
      // a deleted other side (#362) closes it the same way — there is no one to
      // deliver to, and friendship rows cascaded away with the account.
      const recipientId = otherParticipant(participants, userId);
      if (recipientId === null || !(await friendship.areFriends(userId, recipientId))) {
        throw forbidden('You can only message people you are currently friends with.');
      }

      const body = input.body ?? null;
      const chipKind = input.chip?.kind ?? null;
      const chipSubjectId = input.chip?.subjectId ?? null;

      // A chip must reference the sender's OWN shareable (or a visible asset) —
      // this only checks the sender's ownership; it grants the recipient nothing.
      if (
        input.chip &&
        !(await senderMayReference(userId, input.chip.kind, input.chip.subjectId))
      ) {
        throw badRequest('You can only share an item you own.', 'CHAT_CHIP_NOT_OWNED');
      }

      const row = await repo.insertMessage({
        conversationId,
        senderId: userId,
        body,
        chipKind,
        chipSubjectId,
      });

      // Two independent delivery legs (#368), both best-effort for the caller —
      // the message is already persisted and the recipient's poll fallback
      // catches up regardless:
      //  1. the EPHEMERAL bus publish the gateway maps to the in-thread realtime
      //     push (always delivered to the open thread, matrix-independent);
      //  2. the DURABLE notification-center emit, matrix-routed to bell/email/
      //     push and presence-suppressed when the recipient has this very
      //     conversation open.
      const chatEvent = {
        type: 'chat.message' as const,
        userId: recipientId,
        senderId: userId,
        senderUsername: (await friendship.getUsername(userId).catch(() => '')) ?? '',
        conversationId,
        messageId: row.id,
        bodyPreview: body ? body.slice(0, PREVIEW_MAX) : null,
        hasChip: chipKind !== null,
        occurredAt: row.createdAt.toISOString(),
      };
      try {
        await events.publish(chatEvent);
      } catch (err) {
        logger?.warn({ err, messageId: row.id }, 'chat.message publish failed');
      }
      await notify.emit(chatEvent);

      return toMessage(userId, row);
    },

    async markRead(userId, conversationId) {
      const participants = await repo.findParticipants(conversationId);
      if (!participants || !isParticipant(participants, userId)) {
        throw notFound('Conversation not found.');
      }
      await repo.markRead(userId, conversationId);
    },
  };
}
