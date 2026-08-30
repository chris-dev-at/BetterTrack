-- Living tax-year markers must describe every year whose DOCUMENTATION moved,
-- not only the year whose source row was edited (#1591).
--
-- A backdated edit re-settles later years: DE loss pots carry forward and AT's
-- moving-average basis propagates, so amending 2023 changes the 2024 and 2025
-- reports too. Those later years are re-settled by an UNATTACHED tax correction
-- (`tax_withholding` / `tax_refund` carrying no transaction or dividend link),
-- written exactly when a year's settlement target moved. 0093 excluded every
-- tax-kind row from the cash trigger, so a re-settled later year silently kept
-- a stale marker. Including the unattached corrections makes the fan-out match
-- `bettertrack_touch_portfolio_tax_years`, the settings-change precedent.
--
-- Attached tax legs (a sell's or a dividend's own withholding) stay excluded:
-- their parent row's trigger already marks that year, so report self-healing
-- can still never masquerade as a user edit in a year it did not change.
--
-- A correction is posted with `executed_at = now()` but BELONGS to its
-- `tax_year` — January's correction for the prior year is prior-year
-- documentation. Attribute every cash row by `COALESCE(tax_year, executed_at)`,
-- the rule both read paths already use (`listTaxYearDocumentation` and
-- `bettertrack_touch_portfolio_tax_years`). Non-tax kinds carry a NULL
-- `tax_year` (CHECK-enforced), so their attribution is byte-identical.
CREATE FUNCTION "bettertrack_touch_attributed_tax_year"(
	"p_portfolio_id" uuid,
	"p_tax_year" integer,
	"p_executed_at" timestamp with time zone
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "bettertrack_touch_tax_year"(
		p_portfolio_id,
		COALESCE(
			p_tax_year,
			EXTRACT(YEAR FROM p_executed_at AT TIME ZONE 'Europe/Vienna')::integer
		)
	);
END;
$$;
--> statement-breakpoint

-- Which cash rows are tax documentation in their own right: the user-editable
-- operations, plus the engine's unattached year corrections. Everything else
-- (buy/sell/dividend legs and the tax legs hanging off them) is covered by the
-- parent mutation's own trigger.
CREATE FUNCTION "bettertrack_cash_row_marks_tax_year"(
	"p_kind" text,
	"p_transaction_id" uuid,
	"p_dividend_id" uuid
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN p_kind IN ('deposit', 'withdrawal', 'fee', 'transfer_out', 'transfer_in') THEN true
		WHEN p_kind IN ('tax_withholding', 'tax_refund')
			THEN p_transaction_id IS NULL AND p_dividend_id IS NULL
		ELSE false
	END;
$$;
--> statement-breakpoint

-- The no-op guard from 0099 and the FK-cascade skip from 0093 are unchanged:
-- a year whose report did not change is still never bumped.
CREATE OR REPLACE FUNCTION "bettertrack_touch_cash_tax_year"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;
	IF TG_OP IN ('UPDATE', 'DELETE') AND "bettertrack_cash_row_marks_tax_year"(
		OLD."kind"::text, OLD."transaction_id", OLD."dividend_id"
	) THEN
		PERFORM "bettertrack_touch_attributed_tax_year"(
			OLD."portfolio_id", OLD."tax_year", OLD."executed_at"
		);
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') AND "bettertrack_cash_row_marks_tax_year"(
		NEW."kind"::text, NEW."transaction_id", NEW."dividend_id"
	) THEN
		PERFORM "bettertrack_touch_attributed_tax_year"(
			NEW."portfolio_id", NEW."tax_year", NEW."executed_at"
		);
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
