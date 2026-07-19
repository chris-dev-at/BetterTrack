-- Friend groups (§13.5 V5-P8): named friend circles usable as a sharing
-- audience, sitting between `specific_friends` and `all_friends` in the ladder.
-- The `share_audience` enum gains a `group` value (added in its own statement —
-- PG allows ADD VALUE in a transaction as long as the new value isn't USED in
-- the same transaction; nothing here inserts a `group` row).
ALTER TYPE "public"."share_audience" ADD VALUE 'group';--> statement-breakpoint
CREATE TABLE "friend_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friend_group_members" (
	"group_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friend_group_members_pk" PRIMARY KEY("group_id","member_id")
);
--> statement-breakpoint
-- A `group` audience references the circle it shares with; ON DELETE SET NULL so
-- deleting the group leaves the row at `group` with a null reference, resolving
-- to NOBODY (fail-closed) rather than widening the share (§6.9).
ALTER TABLE "share_audiences" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "friend_groups" ADD CONSTRAINT "friend_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_group_members" ADD CONSTRAINT "friend_group_members_group_id_friend_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."friend_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_group_members" ADD CONSTRAINT "friend_group_members_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_audiences" ADD CONSTRAINT "share_audiences_group_id_friend_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."friend_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friend_groups_owner_idx" ON "friend_groups" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "friend_group_members_member_idx" ON "friend_group_members" USING btree ("member_id");
