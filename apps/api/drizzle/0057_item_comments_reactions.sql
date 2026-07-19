CREATE TYPE "public"."reaction_target" AS ENUM('item', 'comment');--> statement-breakpoint
CREATE TABLE "item_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "share_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "item_reactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" "reaction_target" NOT NULL,
	"kind" "share_kind",
	"subject_id" uuid,
	"comment_id" uuid,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_comments" ADD CONSTRAINT "item_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_comments" ADD CONSTRAINT "item_comments_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_reactions" ADD CONSTRAINT "item_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_reactions" ADD CONSTRAINT "item_reactions_comment_id_item_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."item_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_comments_subject_idx" ON "item_comments" USING btree ("kind","subject_id");--> statement-breakpoint
CREATE INDEX "item_comments_author_idx" ON "item_comments" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_reactions_item_unique" ON "item_reactions" USING btree ("user_id","kind","subject_id","emoji") WHERE "item_reactions"."target_type" = 'item';--> statement-breakpoint
CREATE UNIQUE INDEX "item_reactions_comment_unique" ON "item_reactions" USING btree ("user_id","comment_id","emoji") WHERE "item_reactions"."target_type" = 'comment';--> statement-breakpoint
CREATE INDEX "item_reactions_item_idx" ON "item_reactions" USING btree ("kind","subject_id");--> statement-breakpoint
CREATE INDEX "item_reactions_comment_idx" ON "item_reactions" USING btree ("comment_id");
