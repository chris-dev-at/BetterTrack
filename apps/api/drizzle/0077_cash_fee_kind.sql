-- V5 — the `fee` cash-movement kind (§16 2026-07-30, owner-signed deviation).
--
-- A standing custody / account / platform fee becomes its own movement kind. It
-- previously had no home: the only way to enter one was a `withdrawal`, which
-- `domain/cashLedger` classifies as an EXTERNAL flow and therefore divides back
-- out of the time-weighted return — so a portfolio quietly eating 0.5 % a year
-- in custody fees reported the same performance as a fee-free one. A `fee` is a
-- cost of HOLDING, not the owner taking money out, so it is INTERNAL for TWR and
-- drags the curve, exactly like `tax_withholding` already does and exactly like
-- the per-trade fee that rides a transaction's cost basis.
--
-- ADDITIVE AND NON-DESTRUCTIVE. No existing row is read, moved or rewritten: the
-- enum gains one value and one CHECK gains one name in its negative arm. A
-- withdrawal a user previously entered *meaning* a fee stays a withdrawal — this
-- migration deliberately does NOT guess which historical withdrawals were fees
-- (that would rewrite money on a heuristic and silently reshape past
-- performance). Re-running is a no-op by construction: the type is recreated to
-- exactly the value list the app declares.
--
-- Extend cash_movement_kind by RECREATING the type (the 0019/0021 dance).
-- ALTER TYPE ... ADD VALUE would be rejected here: the migration runs in a
-- transaction, and the sign CHECK re-added below references the new value, which
-- Postgres forbids for values added (not created) in the same transaction on a
-- database where the type pre-exists (55P04 "unsafe use of new value") — i.e.
-- every deployed instance. ALL FOUR kind-referencing CHECKs must drop before the
-- column type dance: their expressions pin the old enum's OIDs, so the text cast
-- would fail with "operator does not exist: text = cash_movement_kind".
ALTER TABLE "portfolio_cash_movements" DROP CONSTRAINT "portfolio_cash_movements_sign";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" DROP CONSTRAINT "portfolio_cash_movements_transfer_link";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" DROP CONSTRAINT "portfolio_cash_movements_tax_year";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" DROP CONSTRAINT "portfolio_cash_movements_dividend_link";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."cash_movement_kind";--> statement-breakpoint
CREATE TYPE "public"."cash_movement_kind" AS ENUM('deposit', 'withdrawal', 'buy', 'sell_proceeds', 'transfer_out', 'transfer_in', 'dividend', 'tax_withholding', 'tax_refund', 'fee');--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ALTER COLUMN "kind" SET DATA TYPE "public"."cash_movement_kind" USING "kind"::"public"."cash_movement_kind";--> statement-breakpoint
-- Re-added: the three CHECKs that pass VERBATIM for a `fee` row, unchanged.
-- transfer_link: a fee is not a transfer leg, so it must carry neither pairing
-- column — which it does not. tax_year: a fee is not a tax settlement, so its
-- tax_year stays NULL. dividend_link: a fee is not a dividend. Each already
-- excludes `fee` correctly by construction; widening any of them would have
-- LOOSENED an invariant rather than admitted the new kind.
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_transfer_link" CHECK (("portfolio_cash_movements"."kind" in ('transfer_out','transfer_in'))
          = ("portfolio_cash_movements"."transfer_id" is not null and "portfolio_cash_movements"."counterpart_source_id" is not null));--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_tax_year" CHECK (("portfolio_cash_movements"."kind" in ('tax_withholding','tax_refund')) = ("portfolio_cash_movements"."tax_year" is not null));--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_dividend_link" CHECK ("portfolio_cash_movements"."kind" <> 'dividend' or "portfolio_cash_movements"."dividend_id" is not null);--> statement-breakpoint
-- Re-added WIDENED: `fee` joins the strictly-negative arm. A kind in neither arm
-- fails the CHECK outright, which is why this is the one constraint the new kind
-- genuinely required — without it every fee insert would be rejected.
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_sign" CHECK (("portfolio_cash_movements"."kind" in ('deposit','sell_proceeds','transfer_in','dividend','tax_refund') and "portfolio_cash_movements"."amount_eur" > 0)
          or ("portfolio_cash_movements"."kind" in ('withdrawal','buy','transfer_out','tax_withholding','fee') and "portfolio_cash_movements"."amount_eur" < 0));--> statement-breakpoint
-- NEW: a fee is standalone. Per-trade fees already ride the transaction's cost
-- basis and per-dividend tax is a tax kind, so a `fee` linked to either parent
-- would count the same cost twice. Constrains `fee` rows only — no existing row
-- can violate it, since no `fee` row can exist before this migration.
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_fee_standalone" CHECK ("portfolio_cash_movements"."kind" <> 'fee' or ("portfolio_cash_movements"."transaction_id" is null and "portfolio_cash_movements"."dividend_id" is null));
