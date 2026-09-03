-- V5-P5, #1694: record which price basis each `price_history` row is on.
--
-- Stored transaction quantities are AS TRANSACTED — raw share counts on the
-- trading basis of their execution date. The value engine multiplies them by
-- this table's closes, but every row here was written from Yahoo's `adjclose`,
-- i.e. a dividend/split-adjusted total-return series. For any dividend payer the
-- adjusted close sits below the actual close across the whole history, so the
-- value curve was understated along its entire length while the cost curve was
-- not: a permanent phantom loss. §16 2026-09-03 pins valuation to the raw
-- traded close; backtests keep total return (§5.2).
--
-- The column is what makes the fix safe rather than merely correct-going-forward.
-- The PK is (asset_id, date) and the nightly refresh heals only a trailing
-- 35-day window, so without a per-row basis an old adjusted row would merge into
-- the new unadjusted provider series and put a corporate-action-sized cliff
-- mid-chart. The engine now reads only rows on the basis it is building.
--
-- Default `unadjusted`: every writer that exists after this migration produces
-- raw values (the price jobs now fetch the unadjusted series; custom-asset value
-- marks and account rehydration were always raw). Only the rows already on disk
-- are adjusted, and only for upstream-sourced assets — a custom asset has no
-- issuer, no dividend and no split, so its marks were never adjusted and must
-- keep contributing to the curve.
ALTER TABLE "price_history" ADD COLUMN "basis" text DEFAULT 'unadjusted' NOT NULL;
--> statement-breakpoint
UPDATE "price_history"
SET "basis" = 'adjusted'
WHERE "asset_id" IN (SELECT "id" FROM "assets" WHERE "provider_id" <> 'manual');
