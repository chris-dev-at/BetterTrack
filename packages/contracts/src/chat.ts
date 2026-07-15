import { z } from 'zod';

import { friendUserSchema } from './social';

/**
 * Friend chat (PROJECTPLAN.md §13.3 V3-P8): 1:1 direct messages between accepted
 * friends — a conversation list + a message thread, unread badges, realtime
 * delivery over the §4.5 gateway with a poll fallback, and **share-in-chat**
 * chips.
 *
 * Privacy is contracts-first here too:
 *  - A conversation exists only between two accepted friends and is unique per
 *    pair; a non-participant never receives a conversation or its messages
 *    (the service 404s — never data).
 *  - A **share chip** is stored as a bare `(kind, subjectId)` reference — never a
 *    snapshot of the item. Every viewer's chip is **resolved per-read** through
 *    the ONE sharing-enforcement layer (§13.3 V3-P5): a recipient sees the item's
 *    identity only if its audience already admits them, otherwise a
 *    "not shared with you" state that leaks no name and no data. Sending a chip
 *    never grants or widens access — it writes nothing to the audience model.
 *
 * No groups, reactions or read-receipts in v3.
 */

/**
 * What a chat share-chip can point at: one of the three §13.3 shareable kinds —
 * a `portfolio` / `conglomerate` / `watchlist` the sender owns — or a global
 * `asset` reference (public market data, or the sender's own custom asset). The
 * shareable kinds resolve through the audience-enforcement layer; an `asset`
 * resolves through the §10 asset-visibility rule (global, or the viewer's own
 * custom asset — never a foreign custom asset).
 */
export const CHAT_CHIP_KINDS = ['asset', 'portfolio', 'conglomerate', 'watchlist'] as const;
export const chatChipKindSchema = z.enum(CHAT_CHIP_KINDS);
export type ChatChipKind = z.infer<typeof chatChipKindSchema>;

/**
 * Stable error code the send path returns (HTTP 403) when the sender is chat-banned
 * by an admin (§13.4 V4-P0d). The single source of truth both the API enforcement
 * and the SPA's neutral banned-notice branch key on — for a cookie session and a
 * `chat:write` bearer token alike. Reading a thread is never blocked, so this
 * appears only on `POST …/messages`.
 */
export const CHAT_BANNED_ERROR_CODE = 'CHAT_BANNED';

/**
 * The chip reference a client attaches when sending — a bare pointer, nothing
 * more. The server validates the sender may reference it (owns the shareable, or
 * can see the asset) and stores only these two fields; the item's identity is
 * never captured, so a later rename or audience change is always reflected and a
 * snapshot can never leak.
 */
export const chatChipRefSchema = z
  .object({ kind: chatChipKindSchema, subjectId: z.string().uuid() })
  .strict();
export type ChatChipRef = z.infer<typeof chatChipRefSchema>;

/**
 * A chip as **resolved for one viewer** (§13.3 V3-P8). `viewable` is the
 * enforcement result recomputed for this viewer at read time: `true` only when
 * the audience (or ownership, or asset-visibility) admits them. When `false` the
 * chip renders the kind's "not shared with you" state — `title`/`subtitle` are
 * `null`, so not even the item's name crosses to an unauthorized recipient.
 */
export const chatChipSchema = z
  .object({
    kind: chatChipKindSchema,
    subjectId: z.string().uuid(),
    /** Whether THIS viewer may open the item — the per-read enforcement decision. */
    viewable: z.boolean(),
    /** The item's headline (asset symbol / portfolio/basket/watchlist name). `null` ⇒ not viewable. */
    title: z.string().nullable(),
    /** Secondary line (asset name / owner username). `null` ⇒ not viewable or none. */
    subtitle: z.string().nullable(),
  })
  .strict();
export type ChatChip = z.infer<typeof chatChipSchema>;

/**
 * One message in a thread. A message carries text, a share `chip`, or both — a
 * chip-only message has a `null` body. `chip` is the viewer-resolved shape above,
 * so the same stored message renders differently (and safely) to each side.
 * `senderId` is `null` when the sender's account has been deleted (#362): the
 * message stays readable for the remaining participant, anonymized.
 */
export const chatMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    senderId: z.string().uuid().nullable(),
    body: z.string().nullable(),
    chip: chatChipSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * The conversation-list preview of a thread's newest message. The body is
 * included verbatim; a chip preview carries only its `chipKind` (never resolved
 * identity), so the list can render "Shared a portfolio" client-side through the
 * i18n layer without leaking a non-shared item's name.
 */
export const chatMessagePreviewSchema = z
  .object({
    senderId: z.string().uuid().nullable(),
    body: z.string().nullable(),
    chipKind: chatChipKindSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ChatMessagePreview = z.infer<typeof chatMessagePreviewSchema>;

/**
 * A conversation as seen by the caller: the OTHER participant (public-safe id +
 * username), the caller's unread count, and the last-message preview for the
 * list row. `lastMessage`/`lastMessageAt` are `null` for a freshly-opened,
 * empty thread. `user` is `null` when the other participant deleted their
 * account (#362): the thread's history stays readable, anonymized, and it is
 * closed to new messages.
 */
export const chatConversationSchema = z
  .object({
    id: z.string().uuid(),
    user: friendUserSchema.nullable(),
    unreadCount: z.number().int().nonnegative(),
    lastMessage: chatMessagePreviewSchema.nullable(),
    lastMessageAt: z.string().datetime().nullable(),
  })
  .strict();
export type ChatConversation = z.infer<typeof chatConversationSchema>;

/** `GET /chat/conversations` — the caller's threads, newest-active first, with a total unread badge. */
export const chatConversationListResponseSchema = z
  .object({
    conversations: z.array(chatConversationSchema),
    unreadTotal: z.number().int().nonnegative(),
  })
  .strict();
export type ChatConversationListResponse = z.infer<typeof chatConversationListResponseSchema>;

/**
 * `POST /chat/conversations` body — open (or resolve) the 1:1 conversation with a
 * friend. Friends only: a non-friend `userId` 404s (never data), and the pair is
 * unique so a repeat call returns the same conversation.
 */
export const openConversationRequestSchema = z.object({ userId: z.string().uuid() }).strict();
export type OpenConversationRequest = z.infer<typeof openConversationRequestSchema>;

/** `POST /chat/conversations` response — the resolved conversation summary. */
export const conversationResponseSchema = z
  .object({ conversation: chatConversationSchema })
  .strict();
export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

/** Cursor pagination for a thread's history — newest-first, keyset by UUIDv7 message id. */
export const chatThreadQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ChatThreadQuery = z.infer<typeof chatThreadQuerySchema>;

/**
 * `GET /chat/conversations/:conversationId/messages` — a page of the thread,
 * newest-first, plus the conversation summary so opening a thread by id (e.g.
 * deep-linked from a friend card) needs no second round-trip.
 */
export const chatThreadResponseSchema = z
  .object({
    conversation: chatConversationSchema,
    messages: z.array(chatMessageSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ChatThreadResponse = z.infer<typeof chatThreadResponseSchema>;

/** Max characters in a single message body (§13.3 V3-P8). */
export const CHAT_MESSAGE_MAX = 4000;

/**
 * `POST /chat/conversations/:conversationId/messages` body — text, a share chip,
 * or both; at least one is required. Sending requires the caller still be a
 * participant AND a current friend (unfriending closes the thread to new
 * messages).
 */
export const sendChatMessageRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(CHAT_MESSAGE_MAX).optional(),
    chip: chatChipRefSchema.optional(),
  })
  .strict()
  .refine((b) => b.body !== undefined || b.chip !== undefined, {
    message: 'A message needs text or a shared item.',
  });
export type SendChatMessageRequest = z.infer<typeof sendChatMessageRequestSchema>;

/** `POST …/messages` response — the created message, resolved for the sender. */
export const sendChatMessageResponseSchema = z.object({ message: chatMessageSchema }).strict();
export type SendChatMessageResponse = z.infer<typeof sendChatMessageResponseSchema>;

/** Route params for the thread endpoints. */
export const conversationIdParamSchema = z.object({ conversationId: z.string().uuid() }).strict();
export type ConversationIdParam = z.infer<typeof conversationIdParamSchema>;
