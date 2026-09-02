--- HYGIENE-SCHEMA (#1619): index every foreign key's REFERENCING column.
---
--- Postgres indexes the referenced (parent) side of a foreign key automatically
--- and the referencing (child) side never. Every one of the 53 columns below is
--- the child side of an FK the app follows constantly — the user-scoped and
--- portfolio-scoped joins — and, more sharply, the side Postgres sequentially
--- scans on EVERY parent delete: account deletion (§6.11), portfolio delete and
--- the mirrorchain fork paths each cascade through these tables, and each
--- uncovered FK turns that into one full table scan per parent row.
---
--- Paired with `check:schema-drift`, which fails CI on any future FK that
--- arrives without an index (or an allowlist entry carrying a reason), so this
--- backlog cannot re-accumulate.
---
--- `IF NOT EXISTS` on every statement: nothing here is new behaviour, so a
--- database that already carries one of these indexes (added by hand on the
--- live box) must not turn the deploy into a failed migration. Plain
--- (non-CONCURRENT) CREATE INDEX because drizzle runs each migration in one
--- transaction; on tables of this size the write lock is momentary.
CREATE INDEX IF NOT EXISTS "admin_user_notes_author_id_idx" ON "admin_user_notes" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_asset_id_idx" ON "alerts" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_user_id_idx" ON "alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcement_dismissals_announcement_id_idx" ON "announcement_dismissals" USING btree ("announcement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_created_by_idx" ON "announcements" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_key_request_log_user_id_idx" ON "api_key_request_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_tier_id_idx" ON "api_keys" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_settings_updated_by_idx" ON "app_settings" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_owner_id_idx" ON "assets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_id_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_sender_id_idx" ON "chat_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conglomerate_positions_asset_id_idx" ON "conglomerate_positions" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conglomerates_owner_id_idx" ON "conglomerates" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dividends_asset_id_idx" ON "dividends" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dividends_cash_source_id_idx" ON "dividends" USING btree ("cash_source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_messages_author_user_id_idx" ON "feedback_messages" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friend_requests_from_user_idx" ON "friend_requests" USING btree ("from_user");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friend_requests_to_user_idx" ON "friend_requests" USING btree ("to_user");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friendships_user_b_idx" ON "friendships" USING btree ("user_b");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_batches_cash_source_id_idx" ON "import_batches" USING btree ("cash_source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_batches_portfolio_id_idx" ON "import_batches" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_rows_asset_id_idx" ON "import_rows" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invites_created_by_idx" ON "invites" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_comments_deleted_by_idx" ON "item_comments" USING btree ("deleted_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_reactions_user_id_idx" ON "item_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_chain_invites_chain_id_idx" ON "mirror_chain_invites" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_chain_invites_from_user_idx" ON "mirror_chain_invites" USING btree ("from_user");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_chain_members_invited_by_idx" ON "mirror_chain_members" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_chain_members_portfolio_id_idx" ON "mirror_chain_members" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_chain_ops_actor_user_id_idx" ON "mirror_chain_ops" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_chain_ops_origin_portfolio_id_idx" ON "mirror_chain_ops" USING btree ("origin_portfolio_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_chains_created_by_idx" ON "mirror_chains" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_rows_chain_id_idx" ON "mirror_rows" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mirror_rows_created_by_idx" ON "mirror_rows" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_grant_id_idx" ON "oauth_access_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_auth_codes_client_id_idx" ON "oauth_auth_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_auth_codes_user_id_idx" ON "oauth_auth_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_grant_id_idx" ON "oauth_refresh_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paranoid_v1_wipe_receipts_attestation_id_idx" ON "paranoid_v1_wipe_receipts" USING btree ("attestation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portfolio_cash_movements_counterpart_source_id_idx" ON "portfolio_cash_movements" USING btree ("counterpart_source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portfolio_cash_movements_dividend_id_idx" ON "portfolio_cash_movements" USING btree ("dividend_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portfolio_cash_movements_transaction_id_idx" ON "portfolio_cash_movements" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "problems_resolved_by_idx" ON "problems" USING btree ("resolved_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_tokens_created_by_idx" ON "registration_tokens" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_audiences_group_id_idx" ON "share_audiences" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_links_conglomerate_id_idx" ON "share_links" USING btree ("conglomerate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "standing_orders_asset_id_idx" ON "standing_orders" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_asset_id_idx" ON "transactions" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_blobs_portfolio_id_idx" ON "vault_blobs" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vaults_media_attested_drive_connection_id_idx" ON "vaults" USING btree ("media_attested_drive_connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workboard_items_asset_id_idx" ON "workboard_items" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workboard_items_user_id_idx" ON "workboard_items" USING btree ("user_id");
