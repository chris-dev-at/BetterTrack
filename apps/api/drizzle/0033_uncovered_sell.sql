-- #369 Uncovered sell ("sell a stock you don't hold"). A SELL whose quantity
-- exceeds the held position (including a zero holding) is accepted behind an
-- explicit acknowledgment: the position closes at 0 (never negative — no
-- shorts), the covered shares keep their real moving-average basis, and the
-- uncovered remainder takes either a user-supplied entry price or (default) the
-- sale price, so the tax ledger never books a phantom gain.
--
-- `allow_uncovered` is the persisted acknowledgment: it lets the create-time
-- oversell gate accept the sell AND keeps later edit/delete replays from
-- rejecting the (already accepted) oversell. `uncovered_entry_price` is the
-- native per-unit basis chosen for the uncovered shares (NULL = the sale price
-- was used → 0 % realized on that portion). Existing rows default to a covered
-- sell (false / NULL), so both CHECKs hold on backfill.
ALTER TABLE "transactions" ADD COLUMN "allow_uncovered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "uncovered_entry_price" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_uncovered_sell_only" CHECK ("allow_uncovered" = false OR "side" = 'sell');--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_uncovered_entry_price_requires_flag" CHECK ("uncovered_entry_price" IS NULL OR "allow_uncovered" = true);
