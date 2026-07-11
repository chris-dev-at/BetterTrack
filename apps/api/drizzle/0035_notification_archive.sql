-- #437 — Notification archive state. One additive nullable column: a row is
-- archived when `archived_at` is set (explicitly by the user, or by the
-- auto-archive sweep once its read happened more than the service's
-- AUTO_ARCHIVE_READ_AFTER_DAYS ago). NULL = active. Existing rows stay active,
-- so pre-archive clients keep their exact current behavior; deletion (#437's
-- other half) is plain row DELETE and needs no schema.
ALTER TABLE "notifications" ADD COLUMN "archived_at" timestamp with time zone;
