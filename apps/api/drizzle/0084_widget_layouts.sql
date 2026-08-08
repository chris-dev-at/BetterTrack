-- Per-account dashboard widget compositions, synced across devices, with the
-- mobile and web boards kept as TWO SEPARATE saved compositions (mobile board
-- #68 item 3).
--
-- One row per (user, namespace). The composite primary key is the upsert target:
-- a PUT is `ON CONFLICT (user_id, namespace) DO UPDATE`, so re-sending the same
-- document is a no-op beyond the stamp and last write wins without a conflict
-- model. `user_id` cascades, so the rows die with the account like every other
-- user-owned table.
--
-- `doc` is OPAQUE to the server: jsonb, never interpreted, validated at the edge
-- only as "a JSON object serialising to at most 32 KB". The clients own their
-- own widget vocabulary and routinely run ahead of this build, so anything
-- stricter would drop widgets a user arranged on an updated device. jsonb (not
-- text) so the cap is measured against parsed JSON and the column stays
-- queryable if the composition ever needs inspecting.
--
-- `namespace` is text rather than a pg enum: the accepted values (`mobile`,
-- `web`) are pinned by the request contract, and adding a future client surface
-- should not require an enum-value migration.
CREATE TABLE "widget_layouts" (
	"user_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"doc" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widget_layouts_user_id_namespace_pk" PRIMARY KEY("user_id","namespace")
);
--> statement-breakpoint
ALTER TABLE "widget_layouts"
ADD CONSTRAINT "widget_layouts_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
