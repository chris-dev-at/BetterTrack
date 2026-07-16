-- #493 — Admin-composed announcements (§13.4 V4-P5b). Additive: one table for the
-- announcement itself + one for per-user dismissals + one severity enum. Delivery
-- (banner + inbox) reuses the existing notifications table via the shared
-- `account.notice` type and eventKey dedupe; no new columns land there.

CREATE TYPE "public"."announcement_severity" AS ENUM('info', 'warning', 'critical');
--> statement-breakpoint
-- Admin-composed announcements: severity + EN/DE title & body + optional active
-- window (both inclusive; NULL start = start immediately, NULL end = no auto-off)
-- + `active` toggle the admin flips independently of the window. `published_at`
-- is stamped when active flips on the first time — that's when the fan-out job
-- writes one inbox row per user (deduped per-user by a shared eventKey).
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"severity" "announcement_severity" DEFAULT 'info' NOT NULL,
	"title_en" text NOT NULL,
	"body_en" text NOT NULL,
	"title_de" text NOT NULL,
	"body_de" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_window_order" CHECK ("starts_at" is null or "ends_at" is null or "starts_at" <= "ends_at")
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "announcements_active_window_idx" ON "announcements" USING btree ("active","starts_at","ends_at");
--> statement-breakpoint
-- Per-user dismissal: composite PK dedupes a repeat dismissal into a no-op. A
-- deleted user OR a deleted announcement takes its rows with it — no orphan state.
CREATE TABLE "announcement_dismissals" (
	"user_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_dismissals_pk" PRIMARY KEY("user_id","announcement_id")
);
--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;
