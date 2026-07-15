-- V4-P0d — Per-user chat ban (admin moderation) + the chat-off account default.
-- One additive boolean column on `users`, default false (chat enabled). The
-- send path (chatService) rejects a banned user with CHAT_BANNED for BOTH a
-- cookie session and a `chat:write` bearer token; reading stays allowed and
-- unban is instant — the column IS the state, no cached ban anywhere. A NEW
-- account registered while the admin's account-default has chat off starts with
-- this flag true; existing accounts are never touched (defaults never apply
-- retroactively).
ALTER TABLE "users" ADD COLUMN "chat_banned" boolean DEFAULT false NOT NULL;
