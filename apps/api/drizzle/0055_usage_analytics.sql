-- V5-P2 arc (b) (#567) — first-party admin usage analytics. Strictly additive.
-- `usage_events`: one folded row per (user, feature, asset, UTC day) with a hit
-- counter (NOT a per-request log — the unique index bounds growth). `asset_id`
-- defaults to '' (not null) so no-asset rows still fold under the unique index.
-- `usage_daily`: the materialized per-day rollup refreshed by the `usage.rollup`
-- cron; the sentinel feature '*' carries the all-features per-day totals + the
-- day's distinct-user count. No PII is stored — only ids, a low-cardinality
-- feature bucket and a day. Deleting a user cascades their usage rows away.
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"asset_id" text DEFAULT '' NOT NULL,
	"day" date NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"feature" text NOT NULL,
	"events" integer DEFAULT 0 NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_pk" PRIMARY KEY("day","feature")
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_unique" ON "usage_events" USING btree ("user_id","feature","asset_id","day");--> statement-breakpoint
CREATE INDEX "usage_events_day_idx" ON "usage_events" USING btree ("day");--> statement-breakpoint
CREATE INDEX "usage_events_asset_day_idx" ON "usage_events" USING btree ("asset_id","day");
