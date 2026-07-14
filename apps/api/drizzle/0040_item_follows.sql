-- #439 — Item follows + per-person auto-follow. Additive only.
-- `item_follows` bookmarks ANOTHER user's shareable item (portfolio /
-- conglomerate / watchlist). `subject_id` is polymorphic (no FK), matching
-- `share_audiences`: a follow grants no read access — every read re-authorizes
-- through the audience layer, so a row whose item lost visibility renders as
-- gone and a deleted subject is purged by the clearForSubject hygiene hook.
-- The composite PK is the unique (user, kind, subject) triple; the user FK
-- cascades so an account deletion takes its bookmarks with it.
CREATE TABLE "item_follows" (
	"user_id" uuid NOT NULL,
	"kind" "share_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_follows_pk" PRIMARY KEY("user_id","kind","subject_id")
);
--> statement-breakpoint
ALTER TABLE "item_follows" ADD CONSTRAINT "item_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_follows_subject_idx" ON "item_follows" USING btree ("kind","subject_id");--> statement-breakpoint
-- Per-followed-person auto-follow opt-in (#439, default OFF): when true, every
-- item of theirs that becomes newly visible to the follower (the #438 event
-- matrix) is auto-added to the follower's item_follows.
ALTER TABLE "user_follows" ADD COLUMN "auto_follow_items" boolean DEFAULT false NOT NULL;
