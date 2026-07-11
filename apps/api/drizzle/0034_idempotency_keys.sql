-- #417 (V4-P2a) Idempotency keys on portfolio mutation endpoints — the backbone
-- for the mobile app's offline FIFO queue (mobile SPEC §7). A client-supplied
-- `Idempotency-Key` (a UUID) is claimed per user via the unique (user_id, key)
-- index: the first request wins the claim (INSERT … ON CONFLICT DO NOTHING), runs
-- the mutation and stores its response; a duplicate replays the stored status +
-- body instead of repeating the side effect, and a same-key-but-different-request
-- is rejected 409 (never replayed). Rows are retained ≥ 48 h and lazily purged
-- past that on the next write (the created_at index drives the purge), after which
-- the key is reusable. Keyed per user; deleting the user cascades the rows away.
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response_body" text,
	"content_type" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_user_key_unique" ON "idempotency_keys" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");
