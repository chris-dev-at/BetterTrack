-- V4-P9 — Ideas: saved & shareable Workboard analyses. Strictly additive.
-- Ideas become the FOURTH shareable kind through the existing polymorphic
-- `share_audiences` model, so the `share_kind` enum gains an `idea` value (added
-- in its own statement — PG allows ADD VALUE in a transaction as long as the new
-- value isn't consumed in the same transaction; the CREATE TABLE below does not
-- reference it, only runtime audience rows do).
ALTER TYPE "public"."share_kind" ADD VALUE 'idea';--> statement-breakpoint
-- The `idea` chat share-chip (V4-P9): a bare (kind, subjectId) reference like the
-- other chip kinds, resolved per-viewer through the audience layer at read time.
ALTER TYPE "public"."chat_chip_kind" ADD VALUE 'idea';--> statement-breakpoint
-- One row per saved idea: a name, an optional free-text thesis note, and the
-- exact Workboard `state` (basket source — a conglomerate ref or an ad-hoc
-- weighted asset set — plus the backtest parameters) as jsonb, so a save→reopen
-- roundtrip is byte-exact. Owner-scoped; the FK cascades so an account deletion
-- takes its ideas with it. Sharing is governed entirely by `share_audiences`
-- (kind='idea', subject_id=ideas.id), never a column here.
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"thesis" text,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ideas_owner_idx" ON "ideas" USING btree ("owner_id");
