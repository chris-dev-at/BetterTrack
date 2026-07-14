-- #438 — Follow a person. One additive table, no change to any existing table.
-- `user_follows` records a one-directional PERSON follow (asymmetric, no accept
-- step): the follower opts into `follow.published` news about the followed user's
-- items that become newly visible to them. It grants NO read access on its own —
-- visibility stays enforced by the audience layer. The composite PK dedupes a
-- repeat follow, the CHECK forbids a self-follow, and both FKs cascade so an
-- account deletion stops its news in both directions.
CREATE TABLE "user_follows" (
	"follower_id" uuid NOT NULL,
	"followed_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follows_pk" PRIMARY KEY("follower_id","followed_id"),
	CONSTRAINT "user_follows_no_self" CHECK ("user_follows"."follower_id" <> "user_follows"."followed_id")
);
--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_followed_id_users_id_fk" FOREIGN KEY ("followed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_follows_followed_idx" ON "user_follows" USING btree ("followed_id");
