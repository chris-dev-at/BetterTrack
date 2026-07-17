-- V5-P0c (#552) — source tags on the three ledgers. Strictly additive: one
-- `source` text column on `transactions`, `dividends` and
-- `portfolio_cash_movements` recording how each row entered the system
-- (`manual` / `import:<broker>` / `sync:<provider>` / `standing-order`), so
-- synced/imported data can never be confused with hand-entered data. The column
-- is added NOT NULL with a `manual` default in one statement: existing rows
-- backfill to `manual` (they predate tagging — pre-v5 imported rows are NOT
-- retroactively re-tagged, by design) and the default keeps every non-tagging
-- insert path (seed, tests) working. The allowed format is validated in
-- contracts (sourceTagSchema); no CHECK here so a new provider slug stays a
-- code-only change.
ALTER TABLE "transactions" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "dividends" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;
