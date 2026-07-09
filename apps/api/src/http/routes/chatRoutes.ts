import { Router } from 'express';

import {
  chatThreadQuerySchema,
  conversationIdParamSchema,
  openConversationRequestSchema,
  sendChatMessageRequestSchema,
  type ChatThreadQuery,
  type ConversationIdParam,
  type OpenConversationRequest,
  type SendChatMessageRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Friend-chat endpoints (PROJECTPLAN.md §13.3 V3-P8). Handlers stay thin
 * (parse → service → respond); the friends-only, participant-gate,
 * unfriend-closes-the-thread and per-viewer chip-enforcement rules all live in
 * the chat service. Every route requires a (non-admin) session; the app-wide
 * per-user rate limiter (mounted in `app.ts`) fronts them all.
 */
export function createChatRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /chat/conversations — the caller's threads + a total unread badge.
  router.get('/conversations', async (req, res) => {
    const result = await ctx.chat.listConversations(req.authUser!.id);
    res.json(result);
  });

  // POST /chat/conversations {userId} — open (or resolve) the 1:1 with a friend.
  // A non-friend `userId` 404s (never data); the pair is unique so repeats
  // resolve to the same conversation.
  router.post('/conversations', validateBody(openConversationRequestSchema), async (req, res) => {
    const { userId } = req.valid?.body as OpenConversationRequest;
    const conversation = await ctx.chat.openConversation(req.authUser!.id, userId);
    res.status(201).json({ conversation });
  });

  // GET /chat/conversations/:conversationId/messages — a page of the thread
  // (newest-first) + the conversation summary. Non-participant → 404.
  router.get(
    '/conversations/:conversationId/messages',
    validateParams(conversationIdParamSchema),
    validateQuery(chatThreadQuerySchema),
    async (req, res) => {
      const { conversationId } = req.valid?.params as ConversationIdParam;
      const { cursor, limit } = req.valid?.query as ChatThreadQuery;
      const result = await ctx.chat.getThread(req.authUser!.id, conversationId, { cursor, limit });
      res.json(result);
    },
  );

  // POST /chat/conversations/:conversationId/messages — send text and/or a share
  // chip. Non-participant → 404; a former friend → 403 (thread closed).
  router.post(
    '/conversations/:conversationId/messages',
    validateParams(conversationIdParamSchema),
    validateBody(sendChatMessageRequestSchema),
    async (req, res) => {
      const { conversationId } = req.valid?.params as ConversationIdParam;
      const body = req.valid?.body as SendChatMessageRequest;
      const message = await ctx.chat.sendMessage(req.authUser!.id, conversationId, body);
      res.status(201).json({ message });
    },
  );

  // POST /chat/conversations/:conversationId/read — clear the caller's unread
  // badge for the thread (idempotent). Non-participant → 404.
  router.post(
    '/conversations/:conversationId/read',
    validateParams(conversationIdParamSchema),
    async (req, res) => {
      const { conversationId } = req.valid?.params as ConversationIdParam;
      await ctx.chat.markRead(req.authUser!.id, conversationId);
      res.json({ ok: true });
    },
  );

  return router;
}
