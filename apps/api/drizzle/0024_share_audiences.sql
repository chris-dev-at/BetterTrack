-- V3-P5 (#332) — Sharing audiences everywhere. ONE audience model over every
-- shareable kind (portfolios, conglomerates, named watchlists) plus first-class
-- named watchlists. Purely ADDITIVE + a lossless backfill of V2 sharing data:
-- no sharing relationship silently widens or vanishes.

-- New enums ------------------------------------------------------------------
CREATE TYPE "public"."share_kind" AS ENUM('portfolio', 'conglomerate', 'watchlist');
--> statement-breakpoint
CREATE TYPE "public"."share_audience" AS ENUM('private', 'specific_friends', 'all_friends', 'public_link');
--> statement-breakpoint

-- Named watchlists -----------------------------------------------------------
CREATE TABLE "watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "watchlists_user_name_lower_unique" ON "watchlists" USING btree ("user_id", lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "watchlists_user_default_unique" ON "watchlists" USING btree ("user_id") WHERE "watchlists"."is_default";
--> statement-breakpoint

-- Unified share audiences ----------------------------------------------------
CREATE TABLE "share_audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" "share_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"audience" "share_audience" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_audiences" ADD CONSTRAINT "share_audiences_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "share_audiences_kind_subject_unique" ON "share_audiences" USING btree ("kind", "subject_id");
--> statement-breakpoint
CREATE INDEX "share_audiences_owner_idx" ON "share_audiences" USING btree ("owner_id");
--> statement-breakpoint
CREATE TABLE "share_audience_members" (
	"audience_id" uuid NOT NULL,
	"friend_id" uuid NOT NULL,
	CONSTRAINT "share_audience_members_pk" PRIMARY KEY("audience_id", "friend_id")
);
--> statement-breakpoint
ALTER TABLE "share_audience_members" ADD CONSTRAINT "share_audience_members_audience_id_share_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."share_audiences"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "share_audience_members" ADD CONSTRAINT "share_audience_members_friend_id_users_id_fk" FOREIGN KEY ("friend_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "share_audience_members_friend_idx" ON "share_audience_members" USING btree ("friend_id");
--> statement-breakpoint
CREATE TABLE "share_audience_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audience_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "share_audience_links" ADD CONSTRAINT "share_audience_links_audience_id_share_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."share_audiences"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "share_audience_links_token_hash_unique" ON "share_audience_links" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "share_audience_links_audience_idx" ON "share_audience_links" USING btree ("audience_id");
--> statement-breakpoint

-- workboard_items → named lists ----------------------------------------------
ALTER TABLE "workboard_items" ADD COLUMN "watchlist_id" uuid;
--> statement-breakpoint
-- One General (default) list per existing user — the add-flow anchor.
INSERT INTO "watchlists" ("id", "user_id", "name", "is_default", "sort_order")
SELECT gen_random_uuid(), "id", 'General', true, 0 FROM "users";
--> statement-breakpoint
-- Every existing workboard item moves to its owner's General list — nothing lost.
UPDATE "workboard_items" wi
SET "watchlist_id" = w."id"
FROM "watchlists" w
WHERE w."user_id" = wi."user_id" AND w."is_default";
--> statement-breakpoint
DROP INDEX IF EXISTS "workboard_items_user_asset_unique";
--> statement-breakpoint
ALTER TABLE "workboard_items" ALTER COLUMN "watchlist_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workboard_items" ADD CONSTRAINT "workboard_items_watchlist_id_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "workboard_items_watchlist_asset_unique" ON "workboard_items" USING btree ("watchlist_id", "asset_id");
--> statement-breakpoint

-- Lossless V2 → audience backfill --------------------------------------------
-- default-portfolio (and any other) visibility='friends' → all_friends
INSERT INTO "share_audiences" ("id", "owner_id", "kind", "subject_id", "audience")
SELECT gen_random_uuid(), "user_id", 'portfolio', "id", 'all_friends'
FROM "portfolios" WHERE "visibility" = 'friends';
--> statement-breakpoint
-- V2-P9 conglomerate friend-shares → all_friends
INSERT INTO "share_audiences" ("id", "owner_id", "kind", "subject_id", "audience")
SELECT gen_random_uuid(), "owner_id", 'conglomerate', "id", 'all_friends'
FROM "conglomerates" WHERE "visibility" = 'friends';
--> statement-breakpoint
-- V2-P9 per-user watchlist friend-share → the user's General list, all_friends
INSERT INTO "share_audiences" ("id", "owner_id", "kind", "subject_id", "audience")
SELECT gen_random_uuid(), u."id", 'watchlist', w."id", 'all_friends'
FROM "users" u
JOIN "watchlists" w ON w."user_id" = u."id" AND w."is_default"
WHERE u."watchlist_visibility" = 'friends';
