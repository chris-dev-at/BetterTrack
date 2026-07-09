-- V3-P6 (#374) — Social surfaces: opt-in public profiles + per-shared-item
-- activity-alert preferences. Purely ADDITIVE. Reuses the #332 audience model
-- for enforcement: the public profile composes only the owner's `public_link`
-- items, so no new privacy path is introduced.

-- Opt-in public profile on the user (§6.9, §14) --------------------------------
ALTER TABLE "users" ADD COLUMN "profile_public" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_bio" varchar(280);
--> statement-breakpoint

-- Per-viewer activity-alert preferences on shared items (§14, delivery in #368) --
CREATE TABLE "shared_item_activity_prefs" (
	"viewer_id" uuid NOT NULL,
	"kind" "share_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_item_activity_prefs_pk" PRIMARY KEY("viewer_id","kind","subject_id")
);
--> statement-breakpoint
ALTER TABLE "shared_item_activity_prefs" ADD CONSTRAINT "shared_item_activity_prefs_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
