-- OAuth refresh-rotation grace window (OAUTH_REFRESH_TOKEN_GRACE_SECONDS = 60).
--
-- Refresh rotation had zero grace: re-presenting a just-consumed refresh token
-- — a lost HTTP answer, or the losing side of two concurrent refreshes —
-- revoked the WHOLE grant, and one grant serves every device a user has signed
-- the app in on. One dropped response therefore signed the user out
-- everywhere. Within the window the server now re-serves the IDENTICAL
-- successor pair instead; it can only do that if it kept the pair.
--
--   successor_id       — the row this token was rotated INTO, written in the
--                        rotating transaction. A plain lineage link, no secret;
--                        ON DELETE SET NULL so pruning a successor never
--                        cascades into its predecessor.
--   successor_envelope — a secretBox v2 envelope (AES-256-GCM under the
--                        BT_DATA_ENCRYPTION_KEY keyring) of the exact successor
--                        token response. Never plaintext, and never SERVED past
--                        the window. At rest it is nulled when the successor
--                        itself rotates (same transaction), on any read once
--                        the window has passed, after the next successful
--                        rotation anywhere on the instance (best-effort), and
--                        by the daily `data.retentionCleanup` sweep — on an
--                        instance with no refresh traffic at all an unservable
--                        envelope can therefore stay until that daily sweep.
--
-- Both columns are NULLABLE with no default and NO backfill: every row rotated
-- before this migration simply has no successor recorded, and re-presenting
-- one keeps the old behaviour (reuse detection revokes the grant). Additive and
-- reversible: dropping the two columns and the two indexes restores the
-- previous table byte-for-byte; no existing value is read or rewritten.
--
-- `oauth_refresh_tokens_successor_id_idx` covers the foreign key (the
-- `check:schema-drift` FK-coverage rule) and the predecessor-envelope clear
-- that runs on every rotation. `oauth_refresh_tokens_live_envelope_idx` is
-- PARTIAL on `successor_envelope IS NOT NULL`: it holds only the handful of
-- rows inside a live window, so the sweep's walk stays an index scan however
-- large the never-pruned token table grows. Building it reads the table once;
-- at this table's size a plain (non-CONCURRENT) build is a short lock, and
-- CONCURRENTLY cannot run inside drizzle's per-migration transaction.
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "successor_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "successor_envelope" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens"
ADD CONSTRAINT "oauth_refresh_tokens_successor_id_fk"
FOREIGN KEY ("successor_id") REFERENCES "public"."oauth_refresh_tokens"("id")
ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_successor_id_idx" ON "oauth_refresh_tokens" USING btree ("successor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_live_envelope_idx" ON "oauth_refresh_tokens" USING btree ("consumed_at") WHERE "successor_envelope" IS NOT NULL;
