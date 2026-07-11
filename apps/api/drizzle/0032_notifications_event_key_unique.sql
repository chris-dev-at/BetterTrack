-- #368 review follow-up: make the (user, eventKey) notification-dedupe marker
-- airtight. The dispatcher's exists→insert pair is race-free only with a single
-- queue consumer; a second worker replica could double-insert (double bell,
-- double push). A partial unique expression index turns the marker into a
-- DB-level guarantee — the insert becomes ON CONFLICT DO NOTHING — and gives
-- the per-dispatch eventKey lookup an index instead of a JSON scan.

-- Collapse any historical duplicates first (keep the earliest row per
-- (user, eventKey) — UUIDv7 ids order by creation time) so the unique index
-- builds cleanly on existing data.
DELETE FROM "notifications" a
USING "notifications" b
WHERE a.user_id = b.user_id
  AND a.payload ->> 'eventKey' IS NOT NULL
  AND a.payload ->> 'eventKey' = b.payload ->> 'eventKey'
  AND a.id > b.id;
--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_event_key_unique" ON "notifications" USING btree ("user_id", (payload ->> 'eventKey')) WHERE (payload ->> 'eventKey') IS NOT NULL;
