-- V4-P8 imports (#492 follow-up): surface instrument candidates on unresolved
-- preview rows. The near-matches the local-catalog search already returned
-- during exact-identity resolution are kept per row as display-only
-- suggestions ("did you mean…") — the row stays `unmapped`, excluded from
-- apply; nothing is ever auto-applied. Nullable jsonb: absent for every row
-- that resolved exactly, and for all previews staged before this change.
ALTER TABLE "import_rows" ADD COLUMN "candidates" jsonb;
