-- #1443 — admin workspace hygiene is intentionally independent from the
-- submitter-visible feedback lifecycle and its open-submission cap.
ALTER TABLE "feedback" ADD COLUMN "archived_at" timestamp with time zone;
